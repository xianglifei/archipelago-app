// 看板卡片回归(2026-11-19 需求 - 看板:卡片与任务会话联动,第一批「板面闭环」):
// 卡片=未开跑的任务会话预约+进度投影——执行链复用任务会话(createTaskThread/钉标题/投正文),
// 四列归属读时推导,回合落定经 chat.ts finally 注册回调推进(两段式完成/失败角标),
// 启动清理(孤儿收尾/断链准备)。用内存 SQLite + 桩 LLM 走真实 runTurn 链路
// (mock 集同 task-threads.test.ts)。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { WebContents } from 'electron'

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  // chatStream 脚本队列:每次模型调用弹一项
  script: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
  windows: [] as Array<{ isFocused: () => boolean; webContents: { send: () => void } }>
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => state.windows },
  Notification: class {},
  net: {},
  powerMonitor: { on: vi.fn() },
  dialog: {}
}))
// store 换桩:meta 读写走真库 meta 表(与生产同 JSON 编解码)——偏好回路与收尾模板需要真持久
vi.mock('../../src/main/store', () => ({
  getDb: () => state.db,
  closeDb: () => undefined,
  metaGet: <T>(key: string): T | null => {
    const row = state.db?.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value) as T
    } catch {
      return null
    }
  },
  metaSet: (key: string, value: unknown) => {
    state.db
      ?.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  },
  nowIso: () => new Date().toISOString()
}))
vi.mock('../../src/main/llm', () => ({
  chatStream: vi.fn(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
    state.calls.push({ messages: req.messages })
    const next = state.script.shift() ?? { content: '(空脚本)' }
    return { content: '', reasoning: null, toolCalls: null, finishReason: 'stop', sawReasoning: false, usage: null, ...next }
  }),
  chatOnce: vi.fn(async () => ({ content: '(桩)', reasoning: null, toolCalls: null, finishReason: 'stop', sawReasoning: false, usage: null })),
  llmCredentials: () => ({ baseUrl: 'https://relay.invalid', apiKey: 'synthetic-key' }),
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
vi.mock('../../src/main/paths', () => ({ requireDataRoot: () => '/tmp/qd-kanban-test' }))
// uiStr 换桩:返回 key 并把 {{param}} 以 JSON 尾巴拼上(与真实实现同替换规则)——
// 智能合并提示词用例要断言分支/仓库根等参数真的被带进去了
vi.mock('../../src/main/ui-strings', () => ({
  uiStr: (key: string, params?: Record<string, string | number>): string =>
    key + (params ? ` ${JSON.stringify(params)}` : '')
}))
vi.mock('../../src/main/steward', () => ({
  buildContextMessages: () => [{ role: 'user', content: '上下文' }],
  compactIfNeeded: async () => false,
  forceCompact: async () => false,
  recordPromptUsage: () => undefined
}))
vi.mock('../../src/main/memory', () => ({ reviewTurn: async () => undefined }))
vi.mock('../../src/main/groups', () => ({ busyGroupIds: () => new Set<string>() }))

import { getTaskThread, TASK_THREADS_DDL } from '../../src/main/task-threads'
import { SKILLS_DDL } from '../../src/main/skills-core'
import { TASKS_DDL } from '../../src/main/tasks'
import { MCP_DDL } from '../../src/main/mcp-core'
import { CARDS_DDL } from '../../src/main/kanban-core'
import {
  cardDone,
  cardsPrefsGet,
  cardsPrefsSet,
  createCard,
  deleteCard,
  finishMessageOf,
  initKanban,
  listCards,
  runCard,
  undoneCard,
  updateCard
} from '../../src/main/kanban'

// ---- 内存库与居民铺底(同 task-threads.test.ts 惯例) ----

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE bots (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL, model_id TEXT NOT NULL, is_main INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL, permission TEXT NOT NULL DEFAULT 'workspace', workspace_path TEXT,
      appearance TEXT, archetype TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
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
    CREATE TABLE groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, announcement TEXT NOT NULL DEFAULT '',
      admin_bot_id TEXT NOT NULL, summary TEXT, cutoff_id INTEGER, created_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE group_members (
      group_id TEXT NOT NULL, bot_id TEXT NOT NULL, added_at TEXT NOT NULL,
      PRIMARY KEY (group_id, bot_id)
    );
    CREATE TABLE group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, sender_type TEXT NOT NULL,
      bot_id TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL, attachments TEXT, meta TEXT
    );
  `)
  db.exec(TASK_THREADS_DDL)
  db.exec(SKILLS_DDL)
  db.exec(TASKS_DDL)
  db.exec(MCP_DDL)
  db.exec(CARDS_DDL)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO bots (id, name, role, persona, provider_id, model_id, is_main, color, permission, archetype, created_at, updated_at)
     VALUES (?, 'Ava', '', '', 'archipelago', 'glm-4.7', 0, '#2f6b63', 'auto', '', ?, ?)`
  ).run('bot-ava', now, now)
  return db
}

/** 等 fire-and-forget 链路(执行链/回合落定回调)把条件跑出来 */
async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  expect(cond()).toBe(true)
}

/** 假 WebContents:哑事件口(执行链只借它投递用户消息事件) */
function fakeSender(): WebContents {
  return { send: () => undefined, isDestroyed: () => false } as unknown as WebContents
}

const cardOf = (id: string) => listCards().find((c) => c.id === id)

interface MsgRow {
  id: number
  session_id: string
  role: string
  content: string
  kind: string
  reasoning: string | null
}

const threadRows = (threadId: string): MsgRow[] =>
  state.db!
    .prepare(
      `SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.kind = 'task' AND s.ref = ? ORDER BY m.id`
    )
    .all(threadId) as MsgRow[]

beforeEach(() => {
  state.db = freshDb()
  state.script = []
  state.calls = []
  state.windows = []
  initKanban()
})

describe('看板:建卡与列表', () => {
  it('建卡即出列表:短号单调、未指派待办、标题空取正文首行', () => {
    const a = createCard({ title: '', body: '整理本周照片\n九宫格文案', botId: null, workdirPath: null })
    const b = createCard({ title: '周报素材', body: '', botId: 'bot-ava', workdirPath: null })
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(a.status).toBe('todo')
    expect(a.displayTitle).toBe('整理本周照片')
    expect(a.botId).toBeNull()
    expect(b.displayTitle).toBe('周报素材')
    expect(b.status).toBe('todo')
  })

  it('未指派不能执行:人话拒绝,不建线程', () => {
    const a = createCard({ title: '', body: '攒着', botId: null, workdirPath: null })
    const r = runCard(a.id, fakeSender())
    expect(r.ok).toBe(false)
    expect(r.message).toContain('指派')
    expect(a.threadId).toBeNull()
  })

  it('编辑卡:未执行可改正文;执行过禁改正文与目录,标题与指派不受限', () => {
    const a = createCard({ title: 't', body: 'b1', botId: 'bot-ava', workdirPath: null })
    const edited = updateCard(a.id, { title: 't2', body: 'b2', botId: 'bot-ava', workdirPath: null })
    expect(edited.body).toBe('b2')

    state.script = [{ content: '好的' }]
    const r = runCard(a.id, fakeSender())
    expect(r.ok).toBe(true)
    expect(() => updateCard(a.id, { title: 't', body: 'b3', botId: 'bot-ava', workdirPath: null })).toThrow()
    expect(() => updateCard(a.id, { title: 't', body: 'b2', botId: 'bot-ava', workdirPath: '/tmp' })).toThrow()
    expect(updateCard(a.id, { title: '改名不受限', body: 'b2', botId: 'bot-ava', workdirPath: null }).title).toBe('改名不受限')
  })

  it('删卡只删卡:线程与消息保留', async () => {
    const a = createCard({ title: '', body: '正文', botId: 'bot-ava', workdirPath: null })
    state.script = [{ content: '好的' }]
    const r = runCard(a.id, fakeSender())
    expect(r.ok).toBe(true)
    await waitUntil(() => cardOf(a.id)?.lastRunEndedAt != null)

    deleteCard(a.id)
    expect(cardOf(a.id)).toBeUndefined()
    expect(getTaskThread(r.threadId!)).not.toBeNull()
    expect(threadRows(r.threadId!).length).toBeGreaterThan(0)
  })
})

describe('看板:执行链(无工作目录)', () => {
  it('执行 = 建线程 + 钉标题(手动改名永不覆盖)+ 正文作为首条消息;回合落定回待过目', async () => {
    const a = createCard({ title: '', body: '把岛上这周的照片整理成九宫格文案', botId: 'bot-ava', workdirPath: null })
    state.script = [{ content: '整理好了' }]
    const r = runCard(a.id, fakeSender())
    expect(r.ok).toBe(true)
    expect(r.threadId).toBeTruthy()

    // 线程标题钉成展示标题:抢在首轮自动起名之前(手改口径)
    const thread = getTaskThread(r.threadId!)
    expect(thread?.title).toBe('把岛上这周的照片整理成九宫格文案')

    // 首条 user 消息 = 卡片正文
    const rows = threadRows(r.threadId!)
    expect(rows[0]?.role).toBe('user')
    expect(rows[0]?.content).toBe(a.body)

    // 回合落定回调:lastRunEnded 落库、无错误、卡回待审阅
    await waitUntil(() => cardOf(a.id)?.lastRunEndedAt != null)
    const card = cardOf(a.id)!
    expect(card.error).toBeNull()
    expect(card.status).toBe('review')
    // 手改标题挡住自动起名:线程标题保持卡片标题
    expect(getTaskThread(r.threadId!)?.title).toBe('把岛上这周的照片整理成九宫格文案')
  })
})

describe('看板:「完成之后」三档(none / prompt / smart)', () => {
  it('prompt 档:发默认收尾提示词,回合正常结束自动落 done;撤销完成回待过目', async () => {
    const a = createCard({ title: '周报', body: '收集周报素材', botId: 'bot-ava', workdirPath: null })
    state.script = [{ content: '素材齐了' }, { content: '收尾汇报:全部交付' }]
    const r = runCard(a.id, fakeSender())
    expect(r.ok).toBe(true)
    await waitUntil(() => cardOf(a.id)?.lastRunEndedAt != null)
    expect(cardOf(a.id)!.status).toBe('review')

    cardsPrefsSet({ finishMode: 'prompt' })
    // cardDone await 整个收尾回合,返回时落定回调已把 done 落库(finishing 是回合进行中的瞬态)
    const d = await cardDone(a.id, fakeSender())
    expect(d.ok).toBe(true)
    const finishRow = threadRows(r.threadId!)
      .filter((m) => m.role === 'user')
      .at(-1)
    expect(finishRow?.content).toContain('boardFinishPromptDefault') // uiStr 桩返回 key

    await waitUntil(() => cardOf(a.id)?.doneAt != null)
    const done = cardOf(a.id)!
    expect(done.status).toBe('done')
    expect(done.finishing).toBe(false)

    const again = await cardDone(a.id, fakeSender())
    expect(again.ok).toBe(false)

    const undone = undoneCard(a.id)
    expect(undone.status).toBe('review')
    expect(getTaskThread(r.threadId!)?.status).toBe('open')
  })

  it('prompt 档·自定义模板:发的是自定义文案而非默认', async () => {
    const a = createCard({ title: '', body: '正文', botId: 'bot-ava', workdirPath: null })
    state.script = [{ content: '好的' }, { content: '收尾汇报' }]
    const r = runCard(a.id, fakeSender())
    expect(r.ok).toBe(true)
    await waitUntil(() => cardOf(a.id)?.lastRunEndedAt != null)

    cardsPrefsSet({ finishMode: 'prompt', finishPrompt: '自定义收尾指令:列出交付清单' })
    const d = await cardDone(a.id, fakeSender())
    expect(d.ok).toBe(true)
    await waitUntil(() => cardOf(a.id)?.doneAt != null)
    const finishRow = threadRows(r.threadId!)
      .filter((m) => m.role === 'user')
      .at(-1)
    expect(finishRow?.content).toContain('自定义收尾指令:列出交付清单')
    expect(finishRow?.content).not.toContain('boardFinishPromptDefault')
  })

  it('smart 档(默认)·非工作树:直接完成,不发消息不起回合', async () => {
    const a = createCard({ title: '', body: '正文', botId: 'bot-ava', workdirPath: null })
    state.script = [{ content: '好的' }]
    const r = runCard(a.id, fakeSender())
    expect(r.ok).toBe(true)
    await waitUntil(() => cardOf(a.id)?.lastRunEndedAt != null)

    const callsBefore = state.calls.length
    const rowsBefore = threadRows(r.threadId!).length
    const d = await cardDone(a.id, fakeSender())
    expect(d.ok).toBe(true)
    const card = cardOf(a.id)!
    expect(card.doneAt).not.toBeNull()
    expect(card.status).toBe('done')
    expect(state.calls.length).toBe(callsBefore)
    expect(threadRows(r.threadId!).length).toBe(rowsBefore)
  })

  it('smart 档·工作树线程:finishMessageOf 拼合并收尾指令(带分支/仓库根参数),非工作树返回 null', async () => {
    const a = createCard({ title: '升级依赖', body: '正文', botId: 'bot-ava', workdirPath: null })
    state.script = [{ content: '好的' }]
    const r = runCard(a.id, fakeSender())
    expect(r.ok).toBe(true)
    await waitUntil(() => cardOf(a.id)?.lastRunEndedAt != null)

    const prefs = cardsPrefsGet()
    expect(prefs.finishMode).toBe('smart') // 默认档
    // 非工作树线程:smart 判定直接完成(收尾消息为 null)
    const plain = getTaskThread(r.threadId!)!
    expect(finishMessageOf({ title: a.title, body: a.body }, plain, prefs)).toBeNull()

    // 直写线程工作树列族,模拟 worktree 绑定完成(不走真 git:发送会被 ensureWorkdirReady
    // 回合闸 fail-closed 拦下,这里聚焦档位判定与参数拼装本身)
    state.db!
      .prepare(
        `UPDATE task_threads SET workdir_path = '/tmp/qd-repo', wt_branch = 'task/ava/abc123',
         wt_path = '/tmp/qd-wt', wt_base = 'main', wt_base_commit = 'abcdef1234567890' WHERE id = ?`
      )
      .run(r.threadId)
    const bound = getTaskThread(r.threadId!)!
    const msg = finishMessageOf({ title: a.title, body: a.body }, bound, prefs)
    // 智能档命中合并指令,且分支/仓库根真实带入(uiStr 桩把参数拼成 JSON 尾巴)
    expect(msg).toContain('boardFinishSmartPrompt')
    expect(msg).toContain('task/ava/abc123')
    expect(msg).toContain('/tmp/qd-repo')
    // none 档无论工作树与否都是 null;prompt 档与工作树无关,恒为模板
    expect(finishMessageOf({ title: a.title, body: a.body }, bound, { ...prefs, finishMode: 'none' })).toBeNull()
    expect(finishMessageOf({ title: a.title, body: a.body }, plain, { ...prefs, finishMode: 'prompt' })).toContain(
      'boardFinishPromptDefault'
    )
  })

  it('none 档:直接完成,不发消息', async () => {
    const a = createCard({ title: '', body: '正文', botId: 'bot-ava', workdirPath: null })
    state.script = [{ content: '好的' }]
    const r = runCard(a.id, fakeSender())
    expect(r.ok).toBe(true)
    await waitUntil(() => cardOf(a.id)?.lastRunEndedAt != null)

    cardsPrefsSet({ finishMode: 'none' })
    const callsBefore = state.calls.length
    const rowsBefore = threadRows(r.threadId!).length
    const d = await cardDone(a.id, fakeSender())
    expect(d.ok).toBe(true)
    expect(cardOf(a.id)!.doneAt).not.toBeNull()
    expect(state.calls.length).toBe(callsBefore)
    expect(threadRows(r.threadId!).length).toBe(rowsBefore)
  })
})

describe('看板:偏好(第二批)', () => {
  it('读写回路:默认 smart → 部分补丁落库 → 恢复默认;旧版 finishPrompt 语义自动推断', () => {
    // 默认态:三档默认 smart(走查拍板),模板未自定义
    const d = cardsPrefsGet()
    expect(d.viewMode).toBe('board')
    expect(d.doneCollapsed).toBe(true)
    expect(d.finishMode).toBe('smart')
    expect(d.finishPrompt).toBeNull()
    expect(d.finishPromptDefault).toBe('boardFinishPromptDefault')

    // 部分补丁:只动给到的键
    cardsPrefsSet({ viewMode: 'list', doneCollapsed: false, finishMode: 'prompt', finishPrompt: '自定义收尾' })
    const p1 = cardsPrefsGet()
    expect(p1.viewMode).toBe('list')
    expect(p1.doneCollapsed).toBe(false)
    expect(p1.finishMode).toBe('prompt')
    expect(p1.finishPrompt).toBe('自定义收尾')
    cardsPrefsSet({ viewMode: 'board' })
    expect(cardsPrefsGet().doneCollapsed).toBe(false) // 未给到的键不动

    // 恢复默认:finishPrompt 传 null 与未设置同读
    cardsPrefsSet({ finishPrompt: null })
    expect(cardsPrefsGet().finishPrompt).toBeNull()

    // 旧版语义推断(finishMode 未存):''=旧「关闭两段式」→ none;非空 → prompt;未设置 → smart
    state.db!.prepare("DELETE FROM meta WHERE key LIKE 'kanban.%'").run()
    state.db!.prepare(`INSERT INTO meta (key, value) VALUES ('kanban.finishPrompt', '""')`).run()
    expect(cardsPrefsGet().finishMode).toBe('none')
    state.db!.prepare("UPDATE meta SET value = ? WHERE key = 'kanban.finishPrompt'").run(JSON.stringify('旧自定义'))
    expect(cardsPrefsGet().finishMode).toBe('prompt')
    state.db!.prepare("DELETE FROM meta WHERE key = 'kanban.finishPrompt'").run()
    expect(cardsPrefsGet().finishMode).toBe('smart')
  })
})

describe('看板:工作目录绑定失败与启动清理', () => {
  it('目录不存在:绑定快速失败(fail-closed),线程落可见回执,卡标「未成」回待过目', async () => {
    const a = createCard({ title: '', body: '升级依赖', botId: 'bot-ava', workdirPath: '/tmp/qd-kanban-不存在目录' })
    const r = runCard(a.id, fakeSender())
    expect(r.ok).toBe(true)
    await waitUntil(() => cardOf(a.id)?.error != null)
    const card = cardOf(a.id)!
    expect(card.error).toContain('工作目录绑定没有通过')
    // 从未跑起来的失败不当「准备中」吊着:回待过目
    expect(card.status).toBe('review')
    expect(card.preparing).toBe(false)
    // 线程里有可见回执(note 行)
    const notes = threadRows(r.threadId!).filter((m) => m.kind === 'note')
    expect(notes.length).toBe(1)
  })

  it('启动清理:孤儿收尾清空、断链准备标未成(两个仅有的持久过渡态)', async () => {
    const a = createCard({ title: '', body: '正文', botId: 'bot-ava', workdirPath: null })
    state.script = [{ content: '好的' }]
    const r = runCard(a.id, fakeSender())
    expect(r.ok).toBe(true)
    await waitUntil(() => cardOf(a.id)?.lastRunEndedAt != null)

    // 手工制造两个过渡态(模拟应用中途退出:收尾已发但回合没跑完 / 线程已建但首条没发出)
    const b = createCard({ title: '', body: '第二张', botId: 'bot-ava', workdirPath: null })
    state.db!.prepare('UPDATE cards SET finishing_since = ? WHERE id = ?').run(new Date().toISOString(), a.id)
    const br = runCard(b.id, fakeSender())
    expect(br.ok).toBe(true)
    state.db!
      .prepare('UPDATE cards SET last_run_started_at = NULL, error = NULL WHERE id = ?')
      .run(b.id)

    initKanban()
    const ca = cardOf(a.id)!
    const cb = cardOf(b.id)!
    expect(ca.finishing).toBe(false)
    expect(ca.status).toBe('review')
    expect(cb.error).toContain('重新执行')
    expect(cb.status).toBe('review')
  })
})
