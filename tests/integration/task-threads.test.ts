// 任务会话回归(2026-11-06 方案 - 新建任务,九拍板点全按推荐):
// 基于居民的上下文隔离专属会话——创建即出列表、发送路由到任务会话(单聊不受污染)、
// 框定语挂上下文最尾、首轮后自动起标题(只一次,净化)、同居民多线程并行(active 线程键化)、
// 事件载荷带 threadId、审批留痕落发起回合的会话、结束=归档软删。
// 用内存 SQLite + 桩 LLM 走真实 runTurn 链路(mock 集同 reply-wake.test.ts)。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { WebContents } from 'electron'

type Gate = { promise: Promise<void>; release: () => void }
const makeGate = (): Gate => {
  let release: () => void = () => undefined
  const promise = new Promise<void>((r) => (release = r))
  return { promise, release }
}

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  // chatStream 脚本队列:每次模型调用弹一项;函数项=可挂起的慢回合(并行场景)
  script: [] as Array<Record<string, unknown> | (() => Promise<Record<string, unknown>>)>,
  calls: [] as { messages: Array<{ role: string; content: unknown }> }[],
  // 标题生成桩记录(自动起名只该发生一次;maxTokens 记录入参防回归)
  titleCalls: 0,
  titleMaxTokens: [] as number[],
  // 窗口桩(默认空=askApproval fail-closed 拒绝;挂卡用例给一个聚焦窗口:不发通知、广播走 no-op)
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
vi.mock('../../src/main/store', () => ({
  getDb: () => state.db,
  closeDb: () => undefined,
  metaGet: () => null,
  metaSet: () => undefined,
  nowIso: () => new Date().toISOString()
}))
vi.mock('../../src/main/llm', () => ({
  chatStream: vi.fn(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
    state.calls.push({ messages: req.messages })
    const next = state.script.shift() ?? { content: '(空脚本)' }
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
  // 标题生成桩:返回带引号+句读的脏标题,验证净化;次数由 titleCalls 记录
  chatOnce: vi.fn(async (req: { maxTokens?: number }) => {
    state.titleCalls++
    state.titleMaxTokens.push(req?.maxTokens ?? 0)
    return { content: '「整理海边照片」。', reasoning: null, toolCalls: null, finishReason: 'stop', sawReasoning: false, usage: null }
  }),
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
vi.mock('../../src/main/paths', () => ({ requireDataRoot: () => '/tmp/qd-task-threads-test' }))
vi.mock('../../src/main/ui-strings', () => ({ uiStr: (key: string) => key }))
// 上下文管家换桩(断言 chat.ts 在其产物之后追加的框定语);记忆整理换桩(串行化在 memory 内,另行由实现保证)
vi.mock('../../src/main/steward', () => ({
  buildContextMessages: () => [{ role: 'user', content: '上下文' }],
  compactIfNeeded: async () => false,
  forceCompact: async () => false,
  recordPromptUsage: () => undefined
}))
vi.mock('../../src/main/memory', () => ({ reviewTurn: async () => undefined }))
// 群聊侧只用到 busyGroupIds 聚合,群工具链本测试不碰
vi.mock('../../src/main/groups', () => ({ busyGroupIds: () => new Set<string>() }))

import { sendTaskThreadMessage, sendMessage, getTaskThreadHistory, startReplyTurn } from '../../src/main/chat'
import { createTaskThread, getTaskThread, listTaskThreads } from '../../src/main/task-threads'
import { getOrCreateSession, getOrCreateTaskSession } from '../../src/main/sessions'
import { listConversationPreviews } from '../../src/main/ui-state'
import { getBot } from '../../src/main/bots'
import {
  clearTurnApprovals,
  pendingApprovalsByBot,
  pendingApprovalsByThread,
  requestApproval,
  resolveApproval
} from '../../src/main/approval'
import { executeTool, toolsFor } from '../../src/main/tools'
import { TASK_THREADS_DDL, TASK_THREAD_BRIEF } from '../../src/main/task-threads'
import { chatExport } from '../../src/main/export'
import { SKILLS_DDL } from '../../src/main/skills-core'
import { TASKS_DDL } from '../../src/main/tasks'
import { MCP_DDL } from '../../src/main/mcp-core'
import type { Bot } from '@shared/types'

// ---- 内存库与居民铺底 ----

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
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
      admin_bot_id TEXT NOT NULL, summary TEXT, cutoff_id INTEGER,
      created_at TEXT NOT NULL, deleted_at TEXT
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
  // FTS5 全文索引(read_own_chat 的底座,与生产 migrate 同款:外部内容表+三触发器)
  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id');
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `)
  db.exec(TASK_THREADS_DDL)
  db.exec(SKILLS_DDL)
  db.exec(TASKS_DDL)
  db.exec(MCP_DDL)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO bots (id, name, role, persona, provider_id, model_id, is_main, color, permission, archetype, created_at, updated_at)
     VALUES (?, 'Ava', '', '', 'archipelago', 'glm-4.7', 0, '#2f6b63', 'auto', '', ?, ?)`
  ).run('bot-ava', now, now)
  return db
}

interface Row {
  id: number
  session_id: string
  role: string
  content: string
  kind: string
}

const rowsOfSession = (sessionId: string): Row[] =>
  state.db!.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(sessionId) as Row[]

/** 等 fire-and-forget 链路(自动起名等后台 promise)把条件跑出来 */
async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  expect(cond()).toBe(true)
}

/** 假 WebContents:记录事件通道与载荷(断言 threadId 路由) */
function fakeSender(): { sender: WebContents; events: { channel: string; payload: Record<string, unknown> }[] } {
  const events: { channel: string; payload: Record<string, unknown> }[] = []
  const sender = {
    send: (channel: string, payload: Record<string, unknown>) => {
      events.push({ channel, payload })
    }
  } as unknown as WebContents
  return { sender, events }
}

const ava = { id: 'bot-ava', name: 'Ava', permission: 'auto' } as unknown as Bot

beforeEach(() => {
  state.db = freshDb()
  state.script = []
  state.calls = []
  state.titleCalls = 0
  state.titleMaxTokens = []
  state.windows = []
})

describe('任务会话:创建与列表', () => {
  it('创建即出列表:空线程有预览条目(preview 空)+ 会话预建,历史为空', () => {
    const thread = createTaskThread('bot-ava')
    expect(thread.title).toBe('')
    expect(thread.status).toBe('open')

    const history = getTaskThreadHistory(thread.id)
    expect(history.messages).toHaveLength(0)

    const previews = listConversationPreviews()
    const entry = previews.find((p) => p.kind === 'task' && p.id === thread.id)
    expect(entry).toBeDefined()
    expect(entry!.preview).toBe('')
    expect(entry!.lastAt).toBe(thread.createdAt)
    expect(entry!.busy).toBeUndefined()
  })

  it('listTaskThreads 只回 open;结束后不再出列表,消息保留', async () => {
    const thread = createTaskThread('bot-ava')
    const { sender } = fakeSender()
    state.script = [{ content: '好的' }]
    await sendTaskThreadMessage(thread.id, '整理照片', sender)

    const session = getOrCreateTaskSession('bot-ava', thread.id)
    expect(rowsOfSession(session.id).length).toBeGreaterThan(0)

    state.db!.prepare("UPDATE task_threads SET status = 'archived' WHERE id = ?").run(thread.id)
    expect(listTaskThreads()).toHaveLength(0)
    expect(listConversationPreviews().some((p) => p.id === thread.id)).toBe(false)
    // 归档不删数据
    expect(rowsOfSession(session.id).length).toBeGreaterThan(0)
  })
})

describe('任务会话:发送路由与上下文', () => {
  it('用户/回复落任务会话,居民单聊零污染;框定语挂上下文最尾;事件载荷带 threadId', async () => {
    const thread = createTaskThread('bot-ava')
    const { sender, events } = fakeSender()
    state.script = [{ content: '好的,我来整理。' }]

    await sendTaskThreadMessage(thread.id, '帮我把这周的照片按天气整理成九宫格文案', sender)

    const taskSession = getOrCreateTaskSession('bot-ava', thread.id)
    const taskRows = rowsOfSession(taskSession.id)
    expect(taskRows.map((r) => r.role)).toEqual(['user', 'assistant'])
    expect(taskRows[0]!.content).toContain('九宫格')

    // 居民单聊会话不受污染(DM 会话此时甚至还不存在——按需查建后也为空)
    const dm = getOrCreateSession('bot-ava')
    expect(rowsOfSession(dm.id)).toHaveLength(0)

    // 框定语是模型读到的最后一条 system 行(同定时任务 brief 的注入位)
    const firstCall = state.calls[0]!
    const last = firstCall.messages[firstCall.messages.length - 1]!
    expect(last.role).toBe('system')
    expect(String(last.content)).toBe(TASK_THREAD_BRIEF)

    // 事件路由:任务回合的 UserAdded/Done 都带 threadId(渲染端据此只喂任务视图)
    const userAdded = events.find((e) => e.channel === 'ev:chat:user-added')
    const done = events.find((e) => e.channel === 'ev:chat:done')
    expect(userAdded?.payload.threadId).toBe(thread.id)
    expect(userAdded?.payload.botId).toBe('bot-ava')
    expect(done?.payload.threadId).toBe(thread.id)
  })

  it('首轮后自动起标题(净化引号句读),第二轮不再生成', async () => {
    const thread = createTaskThread('bot-ava')
    const { sender } = fakeSender()
    state.script = [{ content: '收到' }, { content: '继续' }]

    await sendTaskThreadMessage(thread.id, '整理照片', sender)
    await waitUntil(() => getTaskThread(thread.id)?.title === '整理海边照片')
    expect(state.titleCalls).toBe(1)
    // 防回归:起名小调用的预算必须给够——推理模型 reasoning 先行,48 实测全被吃光(content 空)
    expect(Math.max(...state.titleMaxTokens)).toBeGreaterThanOrEqual(1024)

    await sendTaskThreadMessage(thread.id, '再快一点', sender)
    await new Promise((r) => setTimeout(r, 100))
    expect(state.titleCalls).toBe(1) // 已有标题,永不覆盖
    expect(getTaskThread(thread.id)?.title).toBe('整理海边照片')
  })

  it('手改标题后自动起名永不覆盖', async () => {
    const thread = createTaskThread('bot-ava')
    const { sender } = fakeSender()
    state.script = [{ content: '收到' }]

    state.db!.prepare('UPDATE task_threads SET title = ? WHERE id = ?').run('岛主钦定名', thread.id)
    await sendTaskThreadMessage(thread.id, '整理照片', sender)
    await new Promise((r) => setTimeout(r, 100))
    expect(state.titleCalls).toBe(0)
    expect(getTaskThread(thread.id)?.title).toBe('岛主钦定名')
  })
})

describe('任务会话:并行(active 线程键化)', () => {
  it('同居民两个任务线程并行,单聊也照跑;turnActive 按线程真态', async () => {
    const t1 = createTaskThread('bot-ava')
    const t2 = createTaskThread('bot-ava')
    const gate = makeGate()
    // 脚本:t1 挂起(函数项等闸),t2 与 DM 依次完成
    state.script = [
      () => gate.promise.then(() => ({ content: '第一件完成' })),
      { content: '第二件完成' },
      { content: '单聊回复' }
    ]
    const s1 = fakeSender()
    const s2 = fakeSender()
    const sdm = fakeSender()

    const p1 = sendTaskThreadMessage(t1.id, '第一件事', s1.sender)
    // t1 已进入模型调用(挂起)后 t2/DM 才发——避免同刻竞态误判
    await waitUntil(() => state.calls.length >= 1)
    await sendTaskThreadMessage(t2.id, '第二件事', s2.sender)
    await sendMessage('bot-ava', '单聊照常聊', sdm.sender)

    // t2 与 DM 已完成;t1 仍在跑,turnActive 只对 t1 为真
    expect(rowsOfSession(getOrCreateTaskSession('bot-ava', t2.id).id)).toHaveLength(2)
    expect(rowsOfSession(getOrCreateSession('bot-ava').id)).toHaveLength(2)
    expect(getTaskThreadHistory(t1.id).turnActive).toBe(true)
    expect(getTaskThreadHistory(t2.id).turnActive).toBe(false)

    // 单聊事件不带 threadId(与任务事件互不串门)
    expect(sdm.events.find((e) => e.channel === 'ev:chat:done')?.payload.threadId).toBeUndefined()
    expect(s2.events.find((e) => e.channel === 'ev:chat:done')?.payload.threadId).toBe(t2.id)

    gate.release()
    await p1
    expect(rowsOfSession(getOrCreateTaskSession('bot-ava', t1.id).id)).toHaveLength(2)
    expect(getTaskThreadHistory(t1.id).turnActive).toBe(false)
  })

  it('同线程不并行:上一条进行中再发直接报错', async () => {
    const t1 = createTaskThread('bot-ava')
    const gate = makeGate()
    state.script = [() => gate.promise.then(() => ({ content: '慢工' }))]
    const s1 = fakeSender()
    const p1 = sendTaskThreadMessage(t1.id, '慢慢做', s1.sender)
    await waitUntil(() => state.calls.length >= 1)

    const s2 = fakeSender()
    await sendTaskThreadMessage(t1.id, '插队', s2.sender)
    const err = s2.events.find((e) => e.channel === 'ev:chat:error')
    expect(err?.payload.threadId).toBe(t1.id)
    expect(err?.payload.error).toContain('进行中')
    // 与单聊同语义:用户消息照落库,回合被拒(渲染层 busy 守卫让这条路径几乎不可达)
    const rows = rowsOfSession(getOrCreateTaskSession('bot-ava', t1.id).id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.role === 'user')).toBe(true)

    gate.release()
    await p1
    // 慢回合的回复照常落地,插队没有产生第二个回合
    const settled = rowsOfSession(getOrCreateTaskSession('bot-ava', t1.id).id)
    expect(settled.filter((r) => r.role === 'assistant')).toHaveLength(1)
  })
})

describe('任务会话:审批路由', () => {
  it('auto 档留痕行落任务会话(发起回合的会话),居民单聊不出现', async () => {
    const thread = createTaskThread('bot-ava')
    const decision = await requestApproval(
      ava,
      { toolName: 'run_command', title: '执行命令', detail: 'ls', reason: '测试' },
      undefined,
      undefined,
      thread.id
    )
    expect(decision).toBe('approved')
    const taskSession = getOrCreateTaskSession('bot-ava', thread.id)
    const rows = rowsOfSession(taskSession.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('approval')
    const metaRow = state.db!.prepare('SELECT meta FROM messages WHERE id = ?').get(rows[0]!.id) as { meta: string }
    expect((JSON.parse(metaRow.meta) as { status: string }).status).toBe('auto-approved')
    expect(rowsOfSession(getOrCreateSession('bot-ava').id)).toHaveLength(0)
  })
})

describe('任务会话:居民工具(open_task / rename_task / read_own_chat 来源)', () => {
  it('toolsFor 按场景注入:单聊有 open_task 无 rename_task;任务会话两个都有;群聊没有 open_task', () => {
    const bot = { id: 'bot-ava', name: 'Ava', permission: 'auto' } as unknown as Bot
    const dm = toolsFor(bot, 0, 'dm').map((t) => t.function.name)
    const task = toolsFor(bot, 0, 'task').map((t) => t.function.name)
    const group = toolsFor(bot, 0, 'group').map((t) => t.function.name)
    expect(dm).toContain('open_task')
    expect(dm).not.toContain('rename_task')
    expect(task).toContain('open_task')
    expect(task).toContain('rename_task')
    expect(group).not.toContain('open_task')
  })

  it('open_task 全深度放行(2026-11-06 拍板):回信回合(depth 1)也有——私信托付「开个任务做 X」能收口', () => {
    const bot = { id: 'bot-ava', name: 'Ava', permission: 'auto' } as unknown as Bot
    const replyDm = toolsFor(bot, 1, 'dm').map((t) => t.function.name)
    expect(replyDm).toContain('open_task')
    // 私信链其余深门不动:depth 1 无 send_message(防环)、无定时任务四工具
    expect(replyDm).not.toContain('send_message')
    expect(replyDm).not.toContain('set_task')
    // 群聊场景任何深度都不注入(P3);任务会话 depth 1(唤醒转述回任务)同样放行
    expect(toolsFor(bot, 1, 'group').map((t) => t.function.name)).not.toContain('open_task')
    expect(toolsFor(bot, 1, 'task').map((t) => t.function.name)).toContain('open_task')
  })

  it('open_task:全自动档留痕落发起会话 + 建线程 + 回执指路', async () => {
    // 从任务会话里开(P3:嵌套开新任务 OK)——留痕行应落当前任务会话
    const outer = createTaskThread('bot-ava')
    const result = await executeTool(ava, 'open_task', { purpose: '整理本周照片' }, {
      depth: 0,
      startReply: () => undefined,
      threadId: outer.id
    })
    expect(result).toContain('消息列表')
    // 新线程建好(现在共两个 open)
    expect(listTaskThreads()).toHaveLength(2)
    // 留痕行落 outer 任务会话,不在单聊
    const outerRows = rowsOfSession(getOrCreateTaskSession('bot-ava', outer.id).id)
    const approvalRow = outerRows.find((r) => r.kind === 'approval')
    expect(approvalRow).toBeDefined()
    expect(rowsOfSession(getOrCreateSession('bot-ava').id)).toHaveLength(0)
    // 冷启动开场白(2026-11-06 拍板):批准即落一条 canned 居民发言复述目的求确认,岛主进房只需回「开始」
    const fresh = listTaskThreads().find((t) => t.id !== outer.id)
    expect(fresh).toBeDefined()
    const opening = rowsOfSession(getOrCreateTaskSession('bot-ava', fresh!.id).id).find((r) => r.kind === 'chat' && r.role === 'assistant')
    expect(opening).toBeDefined()
    expect(opening!.content).toContain('整理本周照片')
    expect(opening!.content).toContain('现在开始')
  })

  it('rename_task:任务会话内改名成功;单聊里调用得到指路拒绝', async () => {
    const thread = createTaskThread('bot-ava')
    const ok = await executeTool(ava, 'rename_task', { new_title: '整理海边照片!' }, {
      depth: 0,
      startReply: () => undefined,
      threadId: thread.id
    })
    expect(ok).toContain('整理海边照片!')
    expect(getTaskThread(thread.id)?.title).toBe('整理海边照片!')

    const refused = await executeTool(ava, 'rename_task', { new_title: 'X' }, {
      depth: 0,
      startReply: () => undefined
    })
    expect(refused).toContain('只在任务会话里可用')
  })

  it('read_own_chat 标注出处:单聊与任务会话的记录行尾各自带来源', async () => {
    // 注:FTS5 默认分词器把连续中文整段当一个 token,查询词须等于整段(存量行为,与本期无关)
    const thread = createTaskThread('bot-ava')
    state.db!
      .prepare("INSERT INTO messages (session_id, role, content, created_at, kind) VALUES (?, 'user', '单聊素材', ?, 'chat')")
      .run(getOrCreateSession('bot-ava').id, new Date().toISOString())
    state.db!
      .prepare("INSERT INTO messages (session_id, role, content, created_at, kind) VALUES (?, 'user', '任务素材', ?, 'chat')")
      .run(getOrCreateTaskSession('bot-ava', thread.id).id, new Date().toISOString())

    const dmHit = await executeTool(ava, 'read_own_chat', { query: '单聊素材' }, { depth: 0, startReply: () => undefined })
    expect(dmHit).toContain('· 单聊]')
    expect(dmHit).not.toContain('任务「')
    const taskHit = await executeTool(ava, 'read_own_chat', { query: '任务素材' }, { depth: 0, startReply: () => undefined })
    expect(taskHit).toContain('· 任务「新任务」]')
  })
})

describe('任务会话:多选导出', () => {
  it('按线程取数:markdown 含任务对话与任务名,不混入居民单聊', async () => {
    const thread = createTaskThread('bot-ava')
    const { sender } = fakeSender()
    state.script = [{ content: '好的,这就去整理。' }]
    await sendTaskThreadMessage(thread.id, '整理本周照片', sender)
    // 同居民的 DM 也插一条同名消息,验证不串
    state.db!
      .prepare("INSERT INTO messages (session_id, role, content, created_at, kind) VALUES (?, 'user', '整理本周照片', ?, 'chat')")
      .run(getOrCreateSession('bot-ava').id, new Date().toISOString())

    state.db!.prepare("UPDATE task_threads SET title = '整理照片' WHERE id = ?").run(thread.id)
    const taskSession = getOrCreateTaskSession('bot-ava', thread.id)
    const ids = (rowsOfSession(taskSession.id).filter((r) => r.kind === 'chat')).map((r) => r.id)
    const result = await chatExport({ threadId: thread.id, messageIds: ids, mode: 'copy' })
    expect(result.markdown).toContain('任务「整理照片」')
    expect(result.markdown).toContain('整理本周照片')
    expect(result.markdown).toContain('Ava')
    // DM 的同名消息不在(任务导出不串单聊):同文案在 markdown 里只出现一次(任务那条)
    const exported = result.markdown ?? ''
    expect((exported.match(/整理本周照片/g) ?? []).length).toBe(1)
  })
})

// ---- 线程隔离缺口修复(codex 审查 2026-11-06:免问跨线程/文件命令审批漂单聊/私信回链漂单聊) ----

/** 半自动档 + 一个聚焦窗口(挂卡路径可用;通知早退、广播 no-op) */
function semiWithWindow(): void {
  state.windows = [{ isFocused: () => true, webContents: { send: () => undefined } }]
  state.db!.prepare("UPDATE bots SET permission = 'semi' WHERE id = 'bot-ava'").run()
}

/** 某会话里挂起中的审批卡 meta(approvalId 取来 resolve) */
function pendingApprovalOf(sessionId: string): { approvalId: string; toolName: string } | null {
  const rows = state.db!
    .prepare("SELECT meta FROM messages WHERE session_id = ? AND kind = 'approval'")
    .all(sessionId) as { meta: string }[]
  for (const r of rows) {
    const meta = JSON.parse(r.meta) as { approvalId: string; toolName: string; status: string }
    if (meta.status === 'pending') return { approvalId: meta.approvalId, toolName: meta.toolName }
  }
  return null
}

describe('任务会话:免问表线程隔离(codex P1)', () => {
  const req = { toolName: 'run_command', title: '执行命令', detail: 'ls', reason: '测试' }

  it('「本回合不再问」只对本线程生效:别的任务/单聊照样弹卡,收尾清理互不牵连', async () => {
    semiWithWindow()
    const tA = createTaskThread('bot-ava')
    const tB = createTaskThread('bot-ava')
    const sessionA = getOrCreateTaskSession('bot-ava', tA.id).id
    const sessionB = getOrCreateTaskSession('bot-ava', tB.id).id
    const dm = getOrCreateSession('bot-ava').id

    // 任务 A 的卡,岛主点「本回合不再问」
    const pA = requestApproval(ava, req, undefined, 'turn-a', tA.id)
    await waitUntil(() => pendingApprovalOf(sessionA) !== null)
    resolveApproval(pendingApprovalOf(sessionA)!.approvalId, 'turn')
    expect(await pA).toBe('approved')

    // 同工具在任务 B:不吃 A 的免问——照样挂卡(计到 B 的任务行)
    const pB = requestApproval(ava, req, undefined, 'turn-b', tB.id)
    await waitUntil(() => pendingApprovalOf(sessionB) !== null)
    expect(pendingApprovalsByThread().get(tB.id)).toBe(1)
    resolveApproval(pendingApprovalOf(sessionB)!.approvalId, 'deny')
    expect(await pB).toBe('denied')

    // 同工具在单聊:同样不吃 A 的免问
    const pDm = requestApproval(ava, req, undefined, 'turn-dm')
    await waitUntil(() => pendingApprovalOf(dm) !== null)
    expect(pendingApprovalsByBot().get('bot-ava')).toBe(1)
    resolveApproval(pendingApprovalOf(dm)!.approvalId, 'deny')
    expect(await pDm).toBe('denied')

    // A 的免问仍然有效:同线程再问直接放行,不落新卡
    expect(await requestApproval(ava, req, undefined, 'turn-a2', tA.id)).toBe('approved')
    expect(pendingApprovalOf(sessionA)).toBeNull()

    // B 的回合收尾(清 B 的键)不误清 A 的免问
    clearTurnApprovals(`task:${tB.id}`)
    expect(await requestApproval(ava, req, undefined, 'turn-a3', tA.id)).toBe('approved')

    // A 自己的回合收尾才失效:再问重新挂卡
    clearTurnApprovals(`task:${tA.id}`)
    const pA2 = requestApproval(ava, req, undefined, 'turn-a4', tA.id)
    await waitUntil(() => pendingApprovalOf(sessionA) !== null)
    resolveApproval(pendingApprovalOf(sessionA)!.approvalId, 'deny')
    expect(await pA2).toBe('denied')
  })
})

describe('任务会话:文件/命令审批落点(codex P2)', () => {
  it('write_file 工作区外审批卡落任务会话,不漂回居民单聊', async () => {
    semiWithWindow()
    const thread = createTaskThread('bot-ava')
    const taskSession = getOrCreateTaskSession('bot-ava', thread.id).id
    const dm = getOrCreateSession('bot-ava').id
    // 走真实 getBot(工作区路径带默认值),与生产写围栏同源
    const avaLive = getBot('bot-ava')!

    const pending = executeTool(
      avaLive,
      'write_file',
      { path: '/tmp/qd-task-threads-outside/hi.txt', content: 'x' },
      { depth: 0, startReply: () => undefined, turnId: 'turn-w', threadId: thread.id }
    )
    await waitUntil(() => pendingApprovalOf(taskSession) !== null)
    // 卡在任务会话里;单聊零串扰
    expect(pendingApprovalOf(taskSession)!.toolName).toBe('write_file')
    expect(pendingApprovalsByThread().get(thread.id)).toBe(1)
    expect(
      state.db!.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND kind = 'approval'").get(dm) as { n: number }
    ).toMatchObject({ n: 0 })

    resolveApproval(pendingApprovalOf(taskSession)!.approvalId, 'deny')
    const result = await pending
    expect(result).toContain('拒绝了这次工作区外写入')
    // 拒绝后没有产生任何文件写入副作用
    expect(pendingApprovalOf(taskSession)).toBeNull()
  })
})

describe('任务会话:私信与回信唤醒回链(codex P2)', () => {
  function addBen(): void {
    const now = new Date().toISOString()
    state.db!.prepare(
      `INSERT INTO bots (id, name, role, persona, provider_id, model_id, is_main, color, permission, archetype, created_at, updated_at)
       VALUES (?, 'Ben', '', '', 'archipelago', 'glm-4.7', 0, '#b0684a', 'auto', '', ?, ?)`
    ).run('bot-ben', now, now)
  }

  it('任务里托人办事:发信投影/回信投影/唤醒转述全落任务会话,双方单聊零串扰', async () => {
    addBen()
    const thread = createTaskThread('bot-ava')
    state.script = [{ content: 'Ben 的回信:浪高两米' }, { content: 'Ava 转述:Ben 说浪高两米' }]

    const result = await executeTool(
      ava,
      'send_message',
      { to: 'Ben', content: '帮我查今天的海况' },
      { depth: 0, startReply: startReplyTurn, notifyDigest: () => undefined, turnId: 'turn-1', threadId: thread.id }
    )
    expect(result).toContain('已把私信发给「Ben」')

    const taskSession = getOrCreateTaskSession('bot-ava', thread.id).id
    // 发信投影落任务会话,meta 记线程出处(回信按它寻址)
    const outRow = state.db!
      .prepare("SELECT meta FROM messages WHERE session_id = ? AND kind = 'relation' AND meta LIKE '%\"dir\":\"out\"%'")
      .get(taskSession) as { meta: string }
    expect((JSON.parse(outRow.meta) as { threadId?: string }).threadId).toBe(thread.id)

    // 异步链:Ben 回信 → 回信投影 + Ava 唤醒转述,都回任务会话
    await waitUntil(() => {
      const rows = state.db!.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND kind = 'chat'").get(taskSession) as { n: number }
      return rows.n >= 1
    })
    const replyIn = state.db!
      .prepare("SELECT meta FROM messages WHERE session_id = ? AND kind = 'relation' AND meta LIKE '%\"dir\":\"reply-in\"%'")
      .get(taskSession) as { meta: string }
    expect(replyIn).toBeDefined()
    expect((JSON.parse(replyIn.meta) as { threadId?: string }).threadId).toBe(thread.id)

    // Ava 单聊零串扰;Ben 侧照旧在自己的单聊(来信 + 回复)
    expect(rowsOfSession(getOrCreateSession('bot-ava').id)).toHaveLength(0)
    const benRows = rowsOfSession(getOrCreateSession('bot-ben').id)
    expect(benRows.filter((r) => r.kind === 'relation')).toHaveLength(2)
  })

  it('任务结束后的回信回落单聊转述,不复活已归档任务', async () => {
    addBen()
    const thread = createTaskThread('bot-ava')
    const gate = makeGate()
    // Ben 的回信回合挂起在闸上:期间把任务归档,回信只能回落单聊
    state.script = [() => gate.promise.then(() => ({ content: 'Ben 的回信:风停了' })), { content: '单聊转述:Ben 说风停了' }]

    await executeTool(
      ava,
      'send_message',
      { to: 'Ben', content: '帮我查风况' },
      { depth: 0, startReply: startReplyTurn, notifyDigest: () => undefined, turnId: 'turn-2', threadId: thread.id }
    )
    await waitUntil(() => state.calls.length >= 1)
    state.db!.prepare("UPDATE task_threads SET status = 'archived' WHERE id = ?").run(thread.id)
    gate.release()

    const dm = getOrCreateSession('bot-ava').id
    await waitUntil(() => {
      const rows = state.db!.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND kind = 'chat'").get(dm) as { n: number }
      return rows.n >= 1
    })
    // 回信投影与转述都在单聊;任务会话只有发信投影(归档不删数据)
    const dmReplyIn = state.db!.prepare("SELECT meta FROM messages WHERE session_id = ? AND meta LIKE '%\"dir\":\"reply-in\"%'").get(dm) as { meta: string }
    expect((JSON.parse(dmReplyIn.meta) as { threadId?: string }).threadId).toBeUndefined()
    const taskSession = getOrCreateTaskSession('bot-ava', thread.id).id
    expect(rowsOfSession(taskSession).filter((r) => r.kind === 'relation')).toHaveLength(1)
    expect(rowsOfSession(taskSession).filter((r) => r.kind === 'chat')).toHaveLength(0)
  })
})
