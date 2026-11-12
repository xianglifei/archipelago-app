// 回复唤醒回归(2026-11-05 方案 - 私信回复唤醒,六拍板点全按推荐):
// send_message 等回信模式全面异步——工具即返不拖发起方回合;B 空闲立即回信、忙则排队;
// 回信落地(B 的 relation 回合收尾)往发起方落 reply-in 行(没回上来也落 noReply 标记行)
// 并唤醒发起方向岛主转述(depth 1 无 send_message 防环,brief 注入上下文尾部)。
// 用内存 SQLite + 桩 LLM 走真实 runTurn 链路(vi.mock 模式同 post-boot-safety)。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

type Gate = { promise: Promise<void>; release: () => void }
const makeGate = (): Gate => {
  let release: () => void = () => undefined
  const promise = new Promise<void>((r) => (release = r))
  return { promise, release }
}

const state = vi.hoisted(() => {
  // 唤醒重试间隔压到 50ms(须在模块加载前设:chat.ts 在模块顶层读环境变量)
  process.env.QD_WAKE_RETRY_DELAY_MS = '50'
  return {
    db: null as Database.Database | null,
    // chatStream 脚本队列:每次模型调用弹一项;函数项=可挂起的慢回信(忙排队场景)
    script: [] as Array<Record<string, unknown> | (() => Promise<Record<string, unknown>>)>,
    calls: [] as { messages: Array<{ role: string; content: unknown }> }[]
  }
})

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {},
  net: {},
  powerMonitor: { on: vi.fn() },
  dialog: {}
}))
vi.mock('../../src/main/store', () => ({
  getDb: () => state.db,
  closeDb: () => undefined,
  // meta KV 落内存库(与真实现同语义):崩溃恢复的 epoch 门要跨「重启」(两次 recover)存续
  metaGet: (key: string) => {
    const row = state.db!.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as unknown) : null
  },
  metaSet: (key: string, value: unknown) => {
    state.db!
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  },
  nowIso: () => new Date().toISOString()
}))
vi.mock('../../src/main/llm', () => ({
  // 桩 LLM:按脚本队列出结果,记录每次调用的上下文(断言 brief 注入)
  chatStream: vi.fn(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
    state.calls.push({ messages: req.messages })
    const next = state.script.shift() ?? { content: '有空' }
    const result = typeof next === 'function' ? await next() : next
    return {
      content: '',
      reasoning: null,
      toolCalls: null,
      finishReason: 'stop',
      sawReasoning: false,
      usage: null,
      ...result
    }
  }),
  ContextTooLongError: class extends Error {},
  RelayError: class extends Error {
    code = ''
    status = 0
  },
  llmContentChars: (c: unknown) => (typeof c === 'string' ? c.length : 0)
}))
vi.mock('../../src/main/auth', () => ({
  currentSeaToken: () => 'synthetic-token',
  currentIslandUid: () => '11111111-1111-4111-8111-111111111111',
  seaRelayBaseUrl: () => 'https://relay.invalid'
}))
vi.mock('../../src/main/secrets', () => ({ getApiKey: () => 'synthetic-key' }))
vi.mock('../../src/main/space', () => ({ getSpace: () => ({ ownerName: '合成岛主' }) }))
vi.mock('../../src/main/paths', () => ({ requireDataRoot: () => '/tmp/qd-reply-wake-test' }))
vi.mock('../../src/main/ui-strings', () => ({ uiStr: (key: string) => key }))
// 上下文管家与记忆整理都换桩:回流不进桩 LLM 队列(脚本按调用次序出队,别被污染)
vi.mock('../../src/main/steward', () => ({
  buildContextMessages: () => [{ role: 'user', content: '上下文' }],
  compactIfNeeded: async () => false,
  forceCompact: async () => false,
  recordPromptUsage: () => undefined
}))
vi.mock('../../src/main/memory', () => ({ reviewTurn: async () => undefined }))

import { executeTool } from '../../src/main/tools'
import { recoverReplyWake, startReplyTurn } from '../../src/main/chat'
import { getExchangeDetail, getOrCreateSession } from '../../src/main/sessions'
import type { Bot } from '@shared/types'

// ---- 内存库与居民铺底 ----

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE bots (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL, model_id TEXT NOT NULL, is_main INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'dm', ref TEXT, summary TEXT,
      cutoff_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      reasoning TEXT, created_at TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'chat',
      meta TEXT, exchange_id TEXT, turn_id TEXT, attachments TEXT
    );
    CREATE TABLE context_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL,
      detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO bots (id, name, role, persona, provider_id, model_id, is_main, color, created_at, updated_at)
     VALUES (?, 'Ava', '', '', 'archipelago', 'glm-4.7', 0, '#2f6b63', ?, ?)`
  ).run('bot-ava', now, now)
  db.prepare(
    `INSERT INTO bots (id, name, role, persona, provider_id, model_id, is_main, color, created_at, updated_at)
     VALUES (?, 'Bebe', '', '', 'archipelago', 'glm-4.7', 0, '#7c3aed', ?, ?)`
  ).run('bot-bebe', now, now)
  return db
}

interface Row {
  id: number
  session_id: string
  role: string
  content: string
  kind: string
  meta: string | null
  exchange_id: string | null
  turn_id: string | null
}

const rowsOf = (botId: string): Row[] => {
  const session = getOrCreateSession(botId)
  return state.db!.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(session.id) as Row[]
}

const metaOf = (r: Row): Record<string, unknown> => (r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {})

/** 等 fire-and-forget 链路(回信回合/唤醒回合都是后台 promise)把条件跑出来 */
async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  // 到点后再给一次机会,让断言报真实状态而非竞态误报
  expect(cond()).toBe(true)
}

const sendLetter = async (): Promise<{ result: string; exchangeId: string }> => {
  const ava = { id: 'bot-ava', name: 'Ava' } as unknown as Bot
  const result = await executeTool(ava, 'send_message', { to: 'Bebe', content: '今天有空吗' }, {
    depth: 0,
    startReply: startReplyTurn
  })
  // 多封信并存时取最新一条 out 行(数组末尾)
  const out = [...rowsOf('bot-ava')].reverse().find((r) => r.kind === 'relation' && metaOf(r).dir === 'out')!
  return { result, exchangeId: out.exchange_id! }
}

beforeEach(() => {
  state.db = freshDb()
  state.script = []
  state.calls = []
})

describe('回复唤醒:等回信私信全面异步', () => {
  it('主链:工具即返 → B 回信落 reply 行 → A 收 reply-in 投影 + 被唤醒转述(brief 注入上下文尾部)', async () => {
    state.script = [{ content: '今天下午有空', reasoning: '想了想' }, { content: 'Bebe 回信说今天下午有空。' }]
    const { result, exchangeId } = await sendLetter()

    // 工具立即返回,不再同步等回信
    expect(result).toContain('已把私信发给「Bebe」')
    expect(result).toContain('向岛主转述')

    // B 侧:来信行 + 回复行(带 turnId 供 #34 过程折叠与浮窗挂靠)
    await waitUntil(() => rowsOf('bot-bebe').some((r) => r.kind === 'relation' && metaOf(r).dir === 'reply'))
    const bebeReply = rowsOf('bot-bebe').find((r) => metaOf(r).dir === 'reply')!
    expect(bebeReply.content).toContain('今天下午有空')
    expect(bebeReply.exchange_id).toBe(exchangeId)
    expect(bebeReply.turn_id).toBeTruthy()

    // A 侧:reply-in 投影行落回发起方会话(浮窗与交流签的数据源)
    await waitUntil(() => rowsOf('bot-ava').some((r) => metaOf(r).dir === 'reply-in'))
    const replyIn = rowsOf('bot-ava').find((r) => metaOf(r).dir === 'reply-in')!
    expect(replyIn.content).toContain('[来自 Bebe 的回复]')
    expect(replyIn.exchange_id).toBe(exchangeId)
    // 发起方回合早已结束,投影行不挂旧 turnId(独立成签,不折进历史回合)
    expect(metaOf(replyIn).dir).toBe('reply-in')

    // A 被唤醒:普通 chat 气泡 + relay 标记(「收到回信」小签的数据源)
    await waitUntil(() => rowsOf('bot-ava').some((r) => r.kind === 'chat' && metaOf(r).relay))
    const relay = rowsOf('bot-ava').find((r) => metaOf(r).relay)!
    expect(relay.content).toContain('今天下午有空')
    expect((metaOf(relay).relay as { peer: string }).peer).toBe('Bebe')

    // 模型只被叫两次(B 回信 + A 转述);第二次调用的上下文尾部 = 唤醒 brief(回信原文在 brief 里)
    expect(state.calls).toHaveLength(2)
    const wakeMsgs = state.calls[1]!.messages
    const last = wakeMsgs[wakeMsgs.length - 1]!
    expect(last.role).toBe('system')
    expect(String(last.content)).toContain('回信到了')
    expect(String(last.content)).toContain('今天下午有空')
  })

  it('没回上来:noReply 也落 reply-in 标记行 + 唤醒如实转述;浮窗轮次只含来信、不把空回复算成轮', async () => {
    // B 跑了思考(processRows=1)但没产出正文 → markNoReply 路径
    state.script = [{ content: '', reasoning: '想了想,但不知道说什么' }, { content: 'Bebe 处理了但没回上来。' }]
    const { exchangeId } = await sendLetter()

    // B 侧:无回复标记行
    await waitUntil(() => rowsOf('bot-bebe').some((r) => metaOf(r).dir === 'reply' && metaOf(r).noReply))
    // A 侧:noReply 的 reply-in 投影(交流签亮「未获回应」的数据源)+ 唤醒转述
    await waitUntil(() => rowsOf('bot-ava').some((r) => metaOf(r).dir === 'reply-in' && metaOf(r).noReply))
    await waitUntil(() => rowsOf('bot-ava').some((r) => r.kind === 'chat' && metaOf(r).relay))

    // 浮窗:轮次只有来信一行;replied=false;B 的思考过程挂 peerProcess
    const detail = getExchangeDetail(exchangeId)!
    expect(detail.rounds).toHaveLength(1)
    expect(detail.replied).toBe(false)
    expect(detail.peerNoReply).toBe(true)
    expect(detail.peerProcess?.length).toBe(1)
  })

  it('B 忙时排队:第二封信不丢,B 空下来接着回,两封各自唤醒转述', async () => {
    const gate = makeGate()
    // 第一封的回信挂起(占住 B 的回合),放行后依次:回信1、回信2、唤醒1、唤醒2(顺序不敏感,断言只看落库数量)
    state.script = [
      async () => {
        await gate.promise
        return { content: '第一封的回信' }
      },
      { content: '第二封的回信' },
      { content: '转述一' },
      { content: '转述二' }
    ]
    const first = await sendLetter()
    // 第一封还在写:第二封必须立即返回(不阻塞发起方),进排队
    const second = await sendLetter()
    expect(second.result).toContain('已把私信发给「Bebe」')
    expect(second.exchangeId).not.toBe(first.exchangeId)

    // B 忙期间:只有第一封的来信行,没有第二封的回复
    expect(rowsOf('bot-bebe').filter((r) => metaOf(r).dir === 'reply')).toHaveLength(0)

    gate.release()
    await waitUntil(() => rowsOf('bot-bebe').filter((r) => metaOf(r).dir === 'reply').length === 2)
    await waitUntil(() => rowsOf('bot-ava').filter((r) => metaOf(r).dir === 'reply-in').length === 2)
    await waitUntil(() => rowsOf('bot-ava').filter((r) => r.kind === 'chat' && metaOf(r).relay).length === 2)

    // 两封信的回复各自归属各自交流
    const replyExchanges = rowsOf('bot-bebe')
      .filter((r) => metaOf(r).dir === 'reply')
      .map((r) => r.exchange_id)
      .sort()
    expect(replyExchanges).toEqual([first.exchangeId, second.exchangeId].sort())
  })

  it('跨对话排队不覆盖:B 忙时两位不同发起方的信各回各的(单槽覆盖曾把前一位的信黑洞)', async () => {
    // 第三位居民 Cici 上岛
    const now = new Date().toISOString()
    state.db!.prepare(
      `INSERT INTO bots (id, name, role, persona, provider_id, model_id, is_main, color, created_at, updated_at)
       VALUES ('bot-cici', 'Cici', '', '', 'archipelago', 'glm-4.7', 0, '#b45309', ?, ?)`
    ).run(now, now)

    const gate = makeGate()
    state.script = [
      async () => {
        await gate.promise
        return { content: '给 Ava 第一封的回信' }
      },
      { content: '给 Cici 的回信' },
      { content: '给 Ava 第二封的回信' },
      { content: '转述A1' },
      { content: '转述Cici' },
      { content: '转述A2' }
    ]
    const ava = { id: 'bot-ava', name: 'Ava' } as unknown as Bot
    const cici = { id: 'bot-cici', name: 'Cici' } as unknown as Bot
    // Ava 第一封:B 空闲,回信回合立即起跑并被闸住
    const avaLetter = await sendLetter()
    // B 忙期间:Cici 的信入队(跨对话,不得被后面同槽覆盖)
    await executeTool(cici, 'send_message', { to: 'Bebe', content: 'Cici 想问件事' }, {
      depth: 0,
      startReply: startReplyTurn
    })
    const ciciOut = [...rowsOf('bot-cici')].reverse().find((r) => r.kind === 'relation' && metaOf(r).dir === 'out')!
    // Ava 第二封:同对话合批(最新一封为代表),不挤掉 Cici 的队位
    await executeTool(ava, 'send_message', { to: 'Bebe', content: '再补一句' }, {
      depth: 0,
      startReply: startReplyTurn
    })
    const avaOut2 = [...rowsOf('bot-ava')].reverse().find((r) => r.kind === 'relation' && metaOf(r).dir === 'out')!
    expect(avaOut2.exchange_id).not.toBe(avaLetter.exchangeId)

    gate.release()
    // B 三个回信回合全部落地:给 Ava 两封(第一封在途 + 第二封排队)与 Cici 一封
    await waitUntil(() => rowsOf('bot-bebe').filter((r) => metaOf(r).dir === 'reply').length === 3)
    const replyPeers = rowsOf('bot-bebe')
      .filter((r) => metaOf(r).dir === 'reply')
      .map((r) => metaOf(r).peer)
      .sort()
    expect(replyPeers).toEqual(['Ava', 'Ava', 'Cici'].sort())
    // Cici 侧:投影 + 唤醒转述都到(单槽覆盖时这位发起方会被整封黑洞)
    await waitUntil(() => rowsOf('bot-cici').some((r) => metaOf(r).dir === 'reply-in'))
    await waitUntil(() => rowsOf('bot-cici').some((r) => r.kind === 'chat' && metaOf(r).relay))
    expect(rowsOf('bot-cici').filter((r) => metaOf(r).dir === 'reply-in').map((r) => r.exchange_id)).toEqual([
      ciciOut.exchange_id
    ])
    await waitUntil(() => rowsOf('bot-ava').filter((r) => r.kind === 'chat' && metaOf(r).relay).length === 2)
  })

  /** 直接铺一行落库(模拟崩溃现场/同步时代存量),不走在线链路 */
  const seedRow = (
    botId: string,
    over: { role: string; content: string; kind: string; meta: unknown; exchangeId?: string | null; turnId?: string | null }
  ): void => {
    const session = getOrCreateSession(botId)
    state
      .db!.prepare(
        `INSERT INTO messages (session_id, role, content, reasoning, created_at, hidden, kind, meta, exchange_id, turn_id)
         VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?, ?)`
      )
      .run(session.id, over.role, over.content, new Date().toISOString(), over.kind, JSON.stringify(over.meta), over.exchangeId ?? null, over.turnId ?? null)
  }

  it('崩溃恢复:重启后从落库行重建待办——信未回补回信、回信未转述补唤醒;首启置 epoch、同步时代投影行不动', async () => {
    recoverReplyWake() // 首次挂载:只置 epoch,不扫不动存量
    expect(state.calls).toHaveLength(0)

    // 崩溃现场①:A 的信已落 B 会话,B 的回信回合死了(该交流无 reply 行)
    seedRow('bot-bebe', { role: 'user', content: '[来自 Ava] 之前那问有结论吗', kind: 'relation', meta: { dir: 'in', peer: 'Ava' }, exchangeId: 'ex-crash-letter' })
    // 崩溃现场②:B 的回信与 A 的投影行都落了,但 A 唤醒前 App 退出(无转述消息)
    seedRow('bot-ava', { role: 'assistant', content: '[来自 Bebe 的回复] 有结论,明天可以', kind: 'relation', meta: { dir: 'reply-in', peer: 'Bebe' }, exchangeId: 'ex-crash-wake' })
    // 同步时代的投影行带回合 id(当时已在发起方回合里转述过):不该被恢复
    seedRow('bot-ava', { role: 'assistant', content: '[来自 Bebe 的回复] 旧同步路径', kind: 'relation', meta: { dir: 'reply-in', peer: 'Bebe' }, exchangeId: 'ex-legacy', turnId: 'turn-old' })

    // 再次挂载:重建两项待办(B 补回信 + A 补唤醒);B 补上的回信还会再触发一次新唤醒
    state.script = [
      { content: '现在有结论了' },
      { content: '转述:Bebe 说之前那问明天可以。' },
      { content: '转述:新回信到了。' }
    ]
    recoverReplyWake()

    await waitUntil(() => rowsOf('bot-bebe').some((r) => metaOf(r).dir === 'reply' && r.exchange_id === 'ex-crash-letter'))
    await waitUntil(() => rowsOf('bot-ava').filter((r) => r.kind === 'chat' && metaOf(r).relay).length === 2)
    const relayExchanges = rowsOf('bot-ava')
      .filter((r) => r.kind === 'chat' && metaOf(r).relay)
      .map((r) => (metaOf(r).relay as { exchangeId?: string }).exchangeId)
      .sort()
    expect(relayExchanges).toEqual(['ex-crash-letter', 'ex-crash-wake'].sort())
    // 模型恰好三次:B 补回信、A 补两次唤醒;同步时代投影行(ex-legacy)零触发
    expect(state.calls).toHaveLength(3)
  })

  it('崩溃恢复扫描③:回信已落但发起方投影未落(两次写之间崩溃)也补投影+唤醒,不永久黑洞', async () => {
    recoverReplyWake() // 首启只置 epoch
    // 崩溃现场④:B 的 reply 行已落,A 的 reply-in 投影没来得及落(两次写之间退出)
    seedRow('bot-bebe', {
      role: 'assistant',
      content: '[回复 Ava] 结论在路上了',
      kind: 'relation',
      meta: { dir: 'reply', peer: 'Ava' },
      exchangeId: 'ex-orphan-reply',
      turnId: 'turn-crash'
    })

    state.script = [{ content: '转述:Bebe 说结论在路上了。' }]
    recoverReplyWake()

    // A 侧:补落投影行 + 唤醒转述落地
    await waitUntil(() => rowsOf('bot-ava').some((r) => metaOf(r).dir === 'reply-in' && r.exchange_id === 'ex-orphan-reply'))
    await waitUntil(() => rowsOf('bot-ava').some((r) => r.kind === 'chat' && metaOf(r).relay))
    expect(state.calls).toHaveLength(1)
    // 再次恢复不重复(投影与转述都已就位)
    recoverReplyWake()
    await new Promise((r) => setTimeout(r, 30))
    expect(state.calls).toHaveLength(1)
  })

  it('空结局(零过程行)也落无回复终态标记:崩溃恢复不会把该交流重跑一遍', async () => {
    // B 的回信回合零思考零工具、正文也为空 → 修复前不落任何 reply 行,恢复会重跑
    state.script = [{ content: '', reasoning: null }, { content: 'Bebe 处理了但没回上来。' }]
    const { exchangeId } = await sendLetter()

    await waitUntil(() => rowsOf('bot-bebe').some((r) => metaOf(r).dir === 'reply' && metaOf(r).noReply))
    await waitUntil(() => rowsOf('bot-ava').some((r) => r.kind === 'chat' && metaOf(r).relay))
    const callsAfterTurn = state.calls.length

    // 崩溃重启:该交流有 reply 终态行,恢复不得再排回信
    recoverReplyWake()
    await new Promise((r) => setTimeout(r, 30))
    expect(state.calls).toHaveLength(callsAfterTurn)
    expect(rowsOf('bot-bebe').filter((r) => r.exchange_id === exchangeId && metaOf(r).dir === 'reply')).toHaveLength(1)
  })

  it('唤醒失败自动重试:断网一次后回队冷却重试,转述最终落地', async () => {
    state.script = [
      { content: 'B 的回信' },
      () => {
        throw new Error('网络断了')
      },
      { content: '重试后的转述' }
    ]
    await sendLetter()
    await waitUntil(() => rowsOf('bot-ava').some((r) => r.kind === 'chat' && metaOf(r).relay))
    const relay = rowsOf('bot-ava').find((r) => metaOf(r).relay)!
    expect(relay.content).toContain('重试后的转述')
    // 三次模型调用:B 回信、唤醒失败、冷却后重试成功
    expect(state.calls).toHaveLength(3)
  })

  it('唤醒重试 3 次耗尽后放弃,不无限重试(投影行已落库可见,不黑洞)', async () => {
    state.script = [
      { content: '回信' },
      () => {
        throw new Error('持续断网')
      },
      () => {
        throw new Error('持续断网')
      },
      () => {
        throw new Error('持续断网')
      }
    ]
    await sendLetter()
    await waitUntil(() => state.calls.length >= 4)
    await new Promise((r) => setTimeout(r, 200)) // 冷却窗外不应有第 5 次
    expect(state.calls).toHaveLength(4)
    expect(rowsOf('bot-ava').some((r) => r.kind === 'chat' && metaOf(r).relay)).toBe(false)
    // 回复投影行在场:用户仍可见「已收到回复」
    expect(rowsOf('bot-ava').some((r) => metaOf(r).dir === 'reply-in')).toBe(true)
  })
})
