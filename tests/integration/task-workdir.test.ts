// 任务会话工作目录绑定——真实临时仓库集成测试(2026-11-10 第一批「安全地基」):
// 非 mock git:绑定→首回合 prepare(工作树+分支)→执行基点贯通(相对路径/硬围栏/cwd/git 身份)→
// finalize 决策树(自动提交/带序号快照)→verify 复用与跑偏阻断→可等待停止+收尾清理→
// 启动恢复扫描→legacy 零回归。内存 SQLite + 桩 LLM 走真实 runTurn 链路(mock 集同 task-threads.test.ts)。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { WebContents } from 'electron'

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  script: [] as Array<Record<string, unknown> | (() => Promise<Record<string, unknown>>)>,
  calls: [] as { messages: Array<{ role: string; content: unknown }> }[],
  titleCalls: 0,
  windows: [] as Array<{ isFocused: () => boolean; webContents: { send: () => void } }>
}))

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '/tmp/qd-task-workdir-test' },
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
  chatOnce: vi.fn(async () => {
    state.titleCalls++
    return { content: '「任务名」。', reasoning: null, toolCalls: null, finishReason: 'stop', sawReasoning: false, usage: null }
  }),
  llmCredentials: () => ({ baseUrl: 'https://relay.invalid', apiKey: 'synthetic-key' }),
  reasoningEchoValue: () => undefined,
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
vi.mock('../../src/main/paths', () => ({ requireDataRoot: () => '/tmp/qd-task-workdir-test' }))
vi.mock('../../src/main/ui-strings', () => ({ uiStr: (key: string) => key }))
vi.mock('../../src/main/steward', () => ({
  buildContextMessages: () => [{ role: 'user', content: '上下文' }],
  compactIfNeeded: async () => false,
  forceCompact: async () => false,
  recordPromptUsage: () => undefined
}))
vi.mock('../../src/main/memory', () => ({ reviewTurn: async () => undefined }))
vi.mock('../../src/main/groups', () => ({ busyGroupIds: () => new Set<string>() }))

import { sendTaskThreadMessage, stopAndAwaitTaskThread } from '../../src/main/chat'
import { createTaskThread, getTaskThread, TASK_THREADS_DDL } from '../../src/main/task-threads'
import { getOrCreateSession, getOrCreateTaskSession } from '../../src/main/sessions'
import { bindTaskWorkdir, recoverTaskWorkdirs, releaseTaskWorkdir, setWorkdirRootForTests } from '../../src/main/task-workdir'
import { gitExec } from '../../src/main/git-runner'
import { executeTool, toolsFor } from '../../src/main/tools'
import { SKILLS_DDL } from '../../src/main/skills-core'
import { TASKS_DDL } from '../../src/main/tasks'
import { MCP_DDL } from '../../src/main/mcp-core'
import type { Bot, TaskThreadInfo } from '@shared/types'

// ---- 临时仓库与库铺底 ----

let tmp: string

function sh(cmd: string, cwd: string): string {
  return execFileSync('git', cmd.split(' '), { cwd, encoding: 'utf8' }).trim()
}

/** 干净的单提交仓库(main 分支) */
function makeRepo(name: string): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  sh('init -b main', dir)
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n')
  sh('add -A', dir)
  sh('-c user.name=tester -c user.email=t@t commit -m init', dir)
  // realpath 归一(/var → /private/var):绑定侧会这么规范化,测试基线同口径
  return fs.realpathSync(dir)
}

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
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
    CREATE TABLE context_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, announcement TEXT NOT NULL DEFAULT '', admin_bot_id TEXT NOT NULL, summary TEXT, cutoff_id INTEGER, created_at TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE group_members (group_id TEXT NOT NULL, bot_id TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (group_id, bot_id));
    CREATE TABLE group_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, sender_type TEXT NOT NULL, bot_id TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL, attachments TEXT, meta TEXT);
  `)
  db.exec(TASK_THREADS_DDL)
  db.exec(SKILLS_DDL)
  db.exec(TASKS_DDL)
  db.exec(MCP_DDL)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO bots (id, name, role, persona, provider_id, model_id, is_main, color, permission, archetype, created_at, updated_at)
     VALUES (?, 'Kai', '', '', 'archipelago', 'glm-4.7', 0, '#2f6b63', 'auto', '', ?, ?)`
  ).run('bot-kai', now, now)
  return db
}

function fakeSender(): { sender: WebContents; events: { channel: string; payload: Record<string, unknown> }[] } {
  const events: { channel: string; payload: Record<string, unknown> }[] = []
  const sender = { send: (channel: string, payload: Record<string, unknown>) => events.push({ channel, payload }) } as unknown as WebContents
  return { sender, events }
}

const kai = { id: 'bot-kai', name: 'Kai', permission: 'auto' } as unknown as Bot

/** 一步工具调用的模型脚本 */
const toolStep = (name: string, args: Record<string, unknown>): Record<string, unknown> => ({
  content: '',
  toolCalls: [{ id: `call-${randomUUID().slice(0, 6)}`, name, arguments: JSON.stringify(args) }]
})

async function waitTurn(threadId: string, text: string, sender: WebContents): Promise<void> {
  await sendTaskThreadMessage(threadId, text, sender)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-task-workdir-'))
  state.db = freshDb()
  state.script = []
  state.calls = []
  state.titleCalls = 0
  state.windows = []
  setWorkdirRootForTests(path.join(tmp, 'worktrees'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  setWorkdirRootForTests(null)
})

// ---- 绑定与首回合 prepare ----

describe('worktree 绑定全链', () => {
  it('绑定干净仓库 → 首回合 prepare 建工作树与分支;brief 注入;第二回合 verify 复用同一工作树', async () => {
    const repo = makeRepo('fx-engine')
    const thread = createTaskThread('bot-kai')
    const bound = await bindTaskWorkdir(kai, thread.id, repo)
    expect(bound.ok).toBe(true)
    expect(bound.mode).toBe('worktree')

    // 绑定落库:模式持久(分支/基点),wt_state=none(prepare 留给首回合)
    let row = getTaskThread(thread.id)!
    expect(row.workdirPath).toBe(repo)
    expect(row.wtBranch).toBe(`task/Kai/${thread.id.replace(/-/g, '').slice(0, 6)}`)
    expect(row.wtBase).toBe('main')
    expect(row.wtState).toBe('none')
    expect(fs.existsSync(path.join(tmp, 'worktrees'))).toBe(false)

    // 首回合:write_file 相对路径落工作树;回合结束 finalize 把未提交残留自动提交到分支
    const { sender } = fakeSender()
    state.script = [
      toolStep('write_file', { path: 'fix.txt', content: '修好了' }),
      { content: '修好了,分支上见。' }
    ]
    await waitTurn(thread.id, '修一下', sender)

    row = getTaskThread(thread.id)!
    expect(row.wtState).toBe('ready')
    expect(row.wtPath).toBeTruthy()
    expect(fs.existsSync(path.join(row.wtPath!, 'fix.txt'))).toBe(true)
    // 岛主目录逐字节不动:原仓库没有这个文件
    expect(fs.existsSync(path.join(repo, 'fix.txt'))).toBe(false)
    // 分支上已有提交(自动收存)
    const count = sh(`rev-list --count main..${row.wtBranch}`, repo)
    expect(Number(count)).toBeGreaterThanOrEqual(1)
    // 自动提交署居民身份
    const author = sh(`log -1 --format=%an ${row.wtBranch}`, repo)
    expect(author).toBe('Kai(群岛)')
    // brief 注入(工作目录段+分支契约):模型读到的 system 行含契约
    const sysTexts = state.calls.flatMap((c) => c.messages.filter((m) => m.role === 'system').map((m) => String(m.content)))
    expect(sysTexts.some((s) => s.includes('[任务分支]') && s.includes(row.wtBranch!))).toBe(true)

    // 第二回合:verify 复用,不新建工作树
    state.script = [{ content: '继续检查' }]
    await waitTurn(thread.id, '再看看', sender)
    const rootDirs = fs.readdirSync(path.join(tmp, 'worktrees'))
    expect(rootDirs).toHaveLength(1)
    expect(getTaskThread(thread.id)!.wtPath).toBe(row.wtPath)
  })

  it('脏仓库拒绝绑定并列改动计数;显式 direct 是岛主的出口', async () => {
    const repo = makeRepo('dirty-repo')
    fs.writeFileSync(path.join(repo, 'wip.txt'), '脏改动\n')
    const thread = createTaskThread('bot-kai')
    const blocked = await bindTaskWorkdir(kai, thread.id, repo)
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toContain('未提交改动')

    const forced = await bindTaskWorkdir(kai, thread.id, repo, { forceDirect: true })
    expect(forced.ok).toBe(true)
    expect(forced.mode).toBe('direct')
    const row = getTaskThread(thread.id)!
    expect(row.wtBranch).toBeNull() // 直连没有执行资源
    expect(row.wtState).toBe('none')
  })

  it('非 git 目录 → 直连;回合内相对路径落绑定目录', async () => {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true })
    const docs = fs.realpathSync(path.join(tmp, 'docs'))
    const thread = createTaskThread('bot-kai')
    const bound = await bindTaskWorkdir(kai, thread.id, docs)
    expect(bound.mode).toBe('direct')

    const { sender } = fakeSender()
    state.script = [toolStep('write_file', { path: '方案.md', content: 'v1' }), { content: '写好了' }]
    await waitTurn(thread.id, '写个方案', sender)
    expect(fs.existsSync(path.join(docs, '方案.md'))).toBe(true)
    // 直连无执行资源状态流转(恒 none),也不产工作树
    expect(getTaskThread(thread.id)!.wtState).toBe('none')
    expect(fs.existsSync(path.join(tmp, 'worktrees'))).toBe(false)
  })
})

// ---- 执行基点贯通 ----

describe('执行基点(ExecutionContext)', () => {
  it('worktree 模式:工作树外写入硬拒绝(不经审批,auto 档也不放行)', async () => {
    const repo = makeRepo('fence')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)
    const outside = path.join(tmp, 'outside.txt')

    const { sender } = fakeSender()
    state.script = [toolStep('write_file', { path: outside, content: '越界' }), { content: '好的' }]
    await waitTurn(thread.id, '写个外面的文件', sender)

    expect(fs.existsSync(outside)).toBe(false)
    const session = getOrCreateTaskSession('bot-kai', thread.id)
    const toolRows = state.db!
      .prepare("SELECT content FROM messages WHERE session_id = ? AND kind = 'tool' ORDER BY id")
      .all(session.id) as { content: string }[]
    // 工具结果文案进的是模型上下文;落库的工具事件行只有标签——越界拒绝靠文件不存在断言 + 单独直查工具
    void toolRows
    // 直接调工具同断言(不依赖模型链):硬拒绝文案
    const direct = await executeTool(
      kai,
      'write_file',
      { path: outside, content: 'x' },
      { depth: 0, startReply: () => undefined, threadId: thread.id, execBase: { root: getTaskThread(thread.id)!.wtPath!, mode: 'worktree', hardFence: true } }
    )
    expect(direct).toContain('一律不写')
    expect(fs.existsSync(outside)).toBe(false)
  })

  it('run_command 默认 cwd=工作树;居民 shell 提交署群岛身份', async () => {
    const repo = makeRepo('shell-repo')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)

    const { sender } = fakeSender()
    state.script = [
      toolStep('write_file', { path: 'a.txt', content: 'aaa' }),
      toolStep('run_command', { command: 'git add -A && git commit -m wip && git log -1 --format=%an@%ae && pwd' }),
      { content: '提交完成' }
    ]
    await waitTurn(thread.id, '改一行并提交', sender)

    const row = getTaskThread(thread.id)!
    const count = sh(`rev-list --count main..${row.wtBranch}`, repo)
    expect(Number(count)).toBeGreaterThanOrEqual(1)
    const author = sh(`log -1 --format=%an|%ae ${row.wtBranch}`, repo)
    expect(author).toBe('Kai(群岛)|resident-botkai@archipelago.local')
  })

  it('绑定线程的工具描述切任务工作目录措辞(防模型按旧口径拼相对路径)', () => {
    const names = toolsFor(kai, 0, 'task', '/tmp/wt-x').map((t) => t.function.name)
    expect(names).toContain('set_task_workdir')
    const readSpec = toolsFor(kai, 0, 'task', '/tmp/wt-x').find((t) => t.function.name === 'read_file')!
    expect(readSpec.function.description).toContain('/tmp/wt-x')
    // 单聊/群聊不受影响
    const dmSpec = toolsFor(kai, 0, 'dm').find((t) => t.function.name === 'read_file')!
    expect(dmSpec.function.description).toContain('你的工作区')
    expect(toolsFor(kai, 0, 'group').map((t) => t.function.name)).not.toContain('set_task_workdir')
  })
})

// ---- finalize 决策树 ----

describe('finalize(回合收尾)', () => {
  it('居民已提交 + 有未提交残留 → 带序号恢复快照(回读校验通过),工作树保持原样', async () => {
    const repo = makeRepo('snap')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)
    const { sender } = fakeSender()

    // 居民自己提交一次,再留一个未提交残留
    state.script = [
      toolStep('write_file', { path: 'a.txt', content: 'a' }),
      toolStep('run_command', { command: 'git add -A && git commit -m first' }),
      toolStep('write_file', { path: 'b.txt', content: '残留' }),
      { content: '差不多了' }
    ]
    await waitTurn(thread.id, '干活', sender)

    const row = getTaskThread(thread.id)!
    expect(row.leftoverSeq).toBe(1)
    const ref = `refs/archipelago/${thread.id}/leftover-1`
    const resolved = sh(`rev-parse ${ref}`, repo)
    expect(resolved).toBeTruthy()
    // 快照内容含残留文件
    const files = sh(`diff --name-only ${row.wtBranch} ${ref}`, repo)
    expect(files).toContain('b.txt')
    // 残留在工作树里原样保留(快照不是清理)
    expect(fs.existsSync(path.join(row.wtPath!, 'b.txt'))).toBe(true)
    // 序号单调:再来一轮残留 → leftover-2
    state.script = [toolStep('write_file', { path: 'c.txt', content: 'c2' }), { content: '收尾' }]
    await waitTurn(thread.id, '再改一个', sender)
    expect(getTaskThread(thread.id)!.leftoverSeq).toBe(2)
    expect(sh(`rev-parse refs/archipelago/${thread.id}/leftover-2`, repo)).toBeTruthy()
  })

  it('HEAD 跑偏(切走分支)→ 下一回合被闸拦下,线程标 error 人话原因;不改任何现场', async () => {
    const repo = makeRepo('stray')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)
    const { sender, events } = fakeSender()
    state.script = [toolStep('write_file', { path: 'x.txt', content: 'x' }), { content: 'ok' }]
    await waitTurn(thread.id, '干活', sender)

    // 居民在 shell 里把 HEAD 切走(模拟违约),回合照常结束;下回合 verify 拦下
    const row = getTaskThread(thread.id)!
    sh('checkout --detach main', row.wtPath!)

    state.script = [{ content: '继续' }]
    await waitTurn(thread.id, '继续', sender)
    const err = events.find((e) => e.channel === 'ev:chat:error')
    expect(err).toBeDefined()
    expect(String(err!.payload.error)).toContain('不在任务分支')
    expect(getTaskThread(thread.id)!.wtState).toBe('error')
    // 现场安全:x.txt 的提交仍在任务分支上(detach 会把工作树文件切走,提交不动)
    expect(sh(`cat-file -e ${row.wtBranch}:x.txt`, repo)).toBe('')
  })
})

// ---- 停止握手与收尾清理 ----

describe('结束任务(可等待停止+工作树收尾)', () => {
  it('回合进行中结束:握手等回合+finalize 收完再清理;干净工作树移除、分支保留', async () => {
    const repo = makeRepo('close-clean')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)
    // 慢模型步(1200ms 固定延时):停止握手须等它连同 finalize 一起收完
    state.script = [
      toolStep('write_file', { path: 'done.txt', content: 'done' }),
      () => new Promise((r) => setTimeout(r, 1200)).then(() => ({ content: '完成' }))
    ]
    const { sender } = fakeSender()
    const p = sendTaskThreadMessage(thread.id, '干活', sender)
    // 等 write 落盘(停止太早会落在 prepare 期,工具被合法跳过——那是另一条正交路径)
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      const wt = getTaskThread(thread.id)!.wtPath
      if (wt && fs.existsSync(path.join(wt, 'done.txt'))) break
      await new Promise((r) => setTimeout(r, 10))
    }

    await stopAndAwaitTaskThread(thread.id)
    // 握手返回=回合连同 finalize 已收尾:分支上有自动提交(不改任何现场的手动检查在释放前完成)
    const row = getTaskThread(thread.id)!
    expect(sh(`rev-list --count main..${row.wtBranch}`, repo)).toBe('1')
    await p

    const result = await releaseTaskWorkdir('bot-kai', thread.id)
    expect(result.removed).toBe(true)
    expect(fs.existsSync(row.wtPath!)).toBe(false)
    // 分支保留即记录(P6-a)
    expect(sh(`rev-parse --verify refs/heads/${row.wtBranch}`, repo)).toBeTruthy()
    expect(getTaskThread(thread.id)!.wtState).toBe('closed')
  })

  it('脏现场默认保留(禁止强删):快照校验后仍保留目录,结果如实交代', async () => {
    const repo = makeRepo('close-dirty')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)
    const { sender } = fakeSender()
    // 提交一次 + 留残留 → finalize 落快照但工作树仍脏
    state.script = [
      toolStep('write_file', { path: 'a.txt', content: 'a' }),
      toolStep('run_command', { command: 'git add -A && git commit -m first' }),
      toolStep('write_file', { path: 'dirty.txt', content: '脏' }),
      { content: 'ok' }
    ]
    await waitTurn(thread.id, '干活', sender)
    const row = getTaskThread(thread.id)!
    expect(row.leftoverSeq).toBe(1)

    const result = await releaseTaskWorkdir('bot-kai', thread.id)
    expect(result.removed).toBe(false)
    expect(result.keptPath).toBe(row.wtPath)
    expect(fs.existsSync(row.wtPath!)).toBe(true)
    expect(result.snapshotRef).toBe(`refs/archipelago/${thread.id}/leftover-1`)
  })
})

// ---- 启动恢复扫描 ----

describe('启动恢复扫描', () => {
  it('ready 线程的工作树目录被删 → 标 error 人话原因;归属不明目录只报告不删', async () => {
    const repo = makeRepo('recover')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)
    const { sender } = fakeSender()
    state.script = [{ content: '看看' }]
    await waitTurn(thread.id, '随便看看', sender)
    const row = getTaskThread(thread.id)!

    // 破坏:删工作树目录;再放一个归属不明的目录
    fs.rmSync(row.wtPath!, { recursive: true, force: true })
    const stranger = path.join(tmp, 'worktrees', 'stranger123')
    fs.mkdirSync(stranger, { recursive: true })

    await recoverTaskWorkdirs()
    const after = getTaskThread(thread.id)!
    expect(after.wtState).toBe('error')
    expect(after.wtError).toContain('不存在')
    // 归属不明目录仍在
    expect(fs.existsSync(stranger)).toBe(true)
  })

  it('preparing 残留(崩溃在创建中途):不完整 → 回 none 待重备', async () => {
    const repo = makeRepo('recover-prep')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)
    // 手造 preparing 残留(无工作树)
    state.db!.prepare("UPDATE task_threads SET wt_state = 'preparing' WHERE id = ?").run(thread.id)
    await recoverTaskWorkdirs()
    expect(getTaskThread(thread.id)!.wtState).toBe('none')
    // 下一回合照常重备
    const { sender } = fakeSender()
    state.script = [{ content: '开始' }]
    await waitTurn(thread.id, '开始', sender)
    expect(getTaskThread(thread.id)!.wtState).toBe('ready')
  })
})

// ---- 居民工具与 legacy 回归 ----

describe('set_task_workdir 工具与 legacy 零回归', () => {
  it('set_task_workdir:任务会话内绑定成功并回执;单聊调用得到指路拒绝', async () => {
    const repo = makeRepo('tool-bind')
    const thread = createTaskThread('bot-kai')
    const ok = await executeTool(kai, 'set_task_workdir', { directory: repo }, {
      depth: 0,
      startReply: () => undefined,
      threadId: thread.id
    })
    expect(ok).toContain('隔离模式')
    expect(getTaskThread(thread.id)!.workdirPath).toBe(repo)

    const refused = await executeTool(kai, 'set_task_workdir', { directory: repo }, { depth: 0, startReply: () => undefined })
    expect(refused).toContain('只在任务会话里可用')
  })

  it('换绑:旧现场保护(快照)后代次 +1,旧分支保留在仓库', async () => {
    const repo1 = makeRepo('rebind-1')
    const repo2 = makeRepo('rebind-2')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo1)
    const { sender } = fakeSender()
    state.script = [
      toolStep('write_file', { path: 'a.txt', content: 'a' }),
      toolStep('run_command', { command: 'git add -A && git commit -m first' }),
      toolStep('write_file', { path: 'left.txt', content: '残留' }),
      { content: 'ok' }
    ]
    await waitTurn(thread.id, '干活', sender)
    const first = getTaskThread(thread.id)!
    expect(first.leftoverSeq).toBe(1)

    const re = await bindTaskWorkdir(kai, thread.id, repo2)
    expect(re.ok).toBe(true)
    const row = getTaskThread(thread.id)!
    expect(row.bindingGeneration).toBe(1)
    expect(row.workdirPath).toBe(repo2)
    expect(row.wtState).toBe('none')
    expect(row.leftoverSeq).toBe(1) // 序号跨绑定单调:refs 按 threadId 命名,归零会覆盖旧快照
    // 旧分支保留
    expect(sh(`rev-parse --verify refs/heads/${first.wtBranch}`, repo1)).toBeTruthy()
    // 旧残留快照也在
    expect(sh(`rev-parse refs/archipelago/${thread.id}/leftover-1`, repo1)).toBeTruthy()
  })

  it('legacy 线程(未绑定)零回归:回合照常,无 gate 副作用', async () => {
    const thread = createTaskThread('bot-kai')
    const { sender, events } = fakeSender()
    state.script = [{ content: '普通任务回合' }]
    await waitTurn(thread.id, '聊聊', sender)
    const row = getTaskThread(thread.id)!
    expect(row.workdirPath).toBeNull()
    expect(row.wtState).toBe('none')
    const done = events.find((e) => e.channel === 'ev:chat:done')
    expect(done).toBeDefined()
    // 单聊会话零串扰
    expect(state.db!.prepare("SELECT COUNT(*) n FROM messages WHERE session_id = ?").get(getOrCreateSession('bot-kai').id)).toMatchObject({ n: 0 })
  })

  it('绑定后岛主目录的后续提交不自动进工作树(基点钉定)', async () => {
    const repo = makeRepo('pinned')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)
    const { sender } = fakeSender()
    state.script = [{ content: '开始' }]
    await waitTurn(thread.id, '开始', sender)
    const row = getTaskThread(thread.id)!

    // 岛主在原目录推进 main
    fs.writeFileSync(path.join(repo, 'owner.txt'), '岛主的新改动\n')
    sh('add -A', repo)
    sh('-c user.name=owner -c user.email=o@t commit -m advance', repo)

    // 工作树 base 仍是绑定时的基点(不含岛主新提交)
    const contains = await gitExec(['merge-base', '--is-ancestor', 'HEAD', row.wtBranch!], { cwd: row.wtPath! })
    expect(contains.ok).toBe(true)
    expect(fs.existsSync(path.join(row.wtPath!, 'owner.txt'))).toBe(false)
    const brief = state.calls.flatMap((c) => c.messages.filter((m) => m.role === 'system').map((m) => String(m.content)))
    expect(brief.some((s) => s.includes('岛主目录后续的新改动不会自动进入你的工作树'))).toBe(true)
  })
})

// ---- codex 专项评审修复批(2026-11-10,H4/M7/M8/M9/H2/M6/M3/L1) ----

describe('codex 评审修复批', () => {
  it('M9:.git 标记在但 rev-parse 失败(仓库损坏/伪 .git)→ 阻断,不静默直连', async () => {
    const dir = path.join(tmp, 'broken-git')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nonexistent/repo\n') // .git 文件指向不存在的仓库
    const thread = createTaskThread('bot-kai')
    const blocked = await bindTaskWorkdir(kai, thread.id, dir)
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toContain('无法确认')
  })

  it('H2:合卡绑定复核批准计划——审批期间模式漂移(隔离→直连)拒绝执行', async () => {
    const repo = makeRepo('plan-drift')
    const thread = createTaskThread('bot-kai')
    // 批准的是 worktree 计划,但批准后 .git 被移走(探测变直连)——绑定必须拒绝而非静默降级
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true })
    const bound = await bindTaskWorkdir(kai, thread.id, repo, {
      approval: 'merged',
      approvedPlan: { dir: repo, mode: 'worktree' }
    })
    expect(bound.ok).toBe(false)
    expect(bound.message).toContain('发生了变化')
    expect(getTaskThread(thread.id)!.workdirPath).toBeNull()
  })

  it('M7:error 态同目录重绑是恢复出口:新代次重备,不被「无需重复绑定」堵死', async () => {
    const repo = makeRepo('recover-rebind')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)
    // 绑定后岛主把仓库弄脏 → 首回合 prepare 拒绝标 error
    fs.writeFileSync(path.join(repo, 'wip.txt'), '脏\n')
    const { sender } = fakeSender()
    state.script = [{ content: '开始' }]
    await waitTurn(thread.id, '开始', sender)
    expect(getTaskThread(thread.id)!.wtState).toBe('error')

    // 岛主清理干净后同目录重绑:幂等早退不适用(不健康),走新代次
    sh('add -A', repo)
    sh('-c user.name=t -c user.email=t@t commit -m clean', repo)
    const re = await bindTaskWorkdir(kai, thread.id, repo)
    expect(re.ok).toBe(true)
    const row = getTaskThread(thread.id)!
    expect(row.bindingGeneration).toBe(1)
    expect(row.wtState).toBe('none')
    state.script = [{ content: '再开始' }]
    await waitTurn(thread.id, '再开始', sender)
    expect(getTaskThread(thread.id)!.wtState).toBe('ready')
  })

  it('M8:绑定授权卡等待中新回合被挡;批准后恢复', async () => {
    const repo = makeRepo('pending-card')
    const thread = createTaskThread('bot-kai')
    state.windows = [{ isFocused: () => true, webContents: { send: () => undefined } }]
    state.db!.prepare("UPDATE bots SET permission = 'semi' WHERE id = 'bot-kai'").run()

    const session = getOrCreateTaskSession('bot-kai', thread.id).id
    const pendingBind = bindTaskWorkdir(kai, thread.id, repo)
    // 等卡真正挂起(probe 要跑几条 git 命令,固定延时不可靠)
    const cardDeadline = Date.now() + 4000
    while (Date.now() < cardDeadline) {
      const rows = state.db!
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND kind = 'approval'")
        .get(session) as { n: number }
      if (rows.n > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    // 卡已挂起:此时发消息被闸挡下(防按 legacy 基点抢跑)
    const { sender, events } = fakeSender()
    state.script = [{ content: 'x' }]
    await waitTurn(thread.id, '趁卡未决插入', sender)
    const err = events.find((e) => e.channel === 'ev:chat:error')
    expect(err?.payload.error).toContain('等岛主确认')

    // 批准卡 → 绑定落地,下一回合照常
    const card = state.db!
      .prepare("SELECT meta FROM messages WHERE session_id = ? AND kind = 'approval'")
      .all(session) as { meta: string }[]
    const approval = JSON.parse(card[card.length - 1]!.meta) as { approvalId: string }
    const { resolveApproval } = await import('../../src/main/approval')
    resolveApproval(approval.approvalId, 'allow')
    expect((await pendingBind).ok).toBe(true)

    state.script = [{ content: '开始' }]
    await waitTurn(thread.id, '开始', sender)
    expect(getTaskThread(thread.id)!.wtState).toBe('ready')
  })

  it('H4:error 态(HEAD 跑偏)结束任务:工作树保留,游离提交不丢引用', async () => {
    const repo = makeRepo('close-error')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)
    const { sender } = fakeSender()
    state.script = [toolStep('write_file', { path: 'x.txt', content: 'x' }), { content: 'ok' }]
    await waitTurn(thread.id, '干活', sender)
    const row = getTaskThread(thread.id)!
    sh('checkout --detach main', row.wtPath!)
    // detached 上再提交一个游离 commit(只在此工作树可达)
    fs.writeFileSync(path.join(row.wtPath!, 'lost.txt'), '游离提交\n')
    sh('add -A', row.wtPath!)
    sh('-c user.name=k -c user.email=k@t commit -m stray-commit', row.wtPath!)
    // 下回合 verify 拦下 → error;结束任务不得移除工作树
    state.script = [{ content: '再看看' }]
    await waitTurn(thread.id, '再看看', sender)
    expect(getTaskThread(thread.id)!.wtState).toBe('error')

    const result = await releaseTaskWorkdir('bot-kai', thread.id)
    expect(result.removed).toBe(false)
    expect(result.keptPath).toBe(row.wtPath)
    expect(fs.existsSync(path.join(row.wtPath!, 'lost.txt'))).toBe(true)
  })

  it('M6:回合中途换绑 → 本回合仍写旧工作树,回合末按捕获基点快照保护旧现场', async () => {
    const repo1 = makeRepo('mid-rebind-1')
    const repo2 = makeRepo('mid-rebind-2')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo1)
    const { sender } = fakeSender()
    // 首回合:换绑到 repo2(set_task_workdir)后继续写相对路径——写的是旧工作树(捕获基点)
    state.script = [
      toolStep('set_task_workdir', { directory: repo2 }),
      toolStep('write_file', { path: 'late.txt', content: '换绑后的残留' }),
      { content: '换好了' }
    ]
    await waitTurn(thread.id, '换到新仓库去干活', sender)

    const row = getTaskThread(thread.id)!
    expect(row.workdirPath).toBe(repo2) // 新绑定已生效(下一回合起),wt_path 为空待新备
    expect(row.wtPath).toBeNull()
    // 旧工作树仍存在,且其中的 late.txt 残留已被快照保护:换绑时保护一份、回合末再保护增量
    const oldWt = fs.readdirSync(path.join(tmp, 'worktrees'))[0]!
    const oldPath = path.join(tmp, 'worktrees', oldWt)
    expect(fs.existsSync(path.join(oldPath, 'late.txt'))).toBe(true)
    const latest = getTaskThread(thread.id)!.leftoverSeq
    const ref = `refs/archipelago/${thread.id}/leftover-${latest}`
    expect(sh(`diff --name-only HEAD ${ref}`, oldPath)).toContain('late.txt')
  })

  it('M3:busy 插入不破坏停止握手——等的是真回合(含 finalize),不是被顶掉的瞬时 promise', async () => {
    const repo = makeRepo('busy-close')
    const thread = createTaskThread('bot-kai')
    await bindTaskWorkdir(kai, thread.id, repo)
    // 慢回合 + 中途一次 busy 抢发(M3 场景:覆盖 waiter 后停止握手会假完成)
    state.script = [
      toolStep('write_file', { path: 'done.txt', content: 'done' }),
      () => new Promise((r) => setTimeout(r, 900)).then(() => ({ content: '完成' }))
    ]
    const { sender } = fakeSender()
    const p = sendTaskThreadMessage(thread.id, '干活', sender)
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      const wt = getTaskThread(thread.id)!.wtPath
      if (wt && fs.existsSync(path.join(wt, 'done.txt'))) break
      await new Promise((r) => setTimeout(r, 10))
    }
    const s2 = fakeSender()
    await sendTaskThreadMessage(thread.id, '插队(bound to busy-early-return)', s2.sender)

    const stopped = await stopAndAwaitTaskThread(thread.id, 5000)
    expect(stopped).toBe(true)
    // 握手返回=真回合连同 finalize 收完:分支上有自动提交
    const row = getTaskThread(thread.id)!
    expect(sh(`rev-list --count main..${row.wtBranch}`, repo)).toBe('1')
    await p
  })

  it('L1:git 输出上限按字节计——多字节大输出被截断并附提示', async () => {
    const repo = makeRepo('big-out')
    fs.writeFileSync(path.join(repo, 'big.txt'), '中'.repeat(2 * 1024 * 1024)) // 6MB UTF-8 字节,2M 字符
    sh('add -A', repo)
    sh('-c user.name=t -c user.email=t@t commit -m big', repo)
    const r = await gitExec(['show', 'HEAD:big.txt'], { cwd: repo, timeoutMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(r.stdout.length).toBeLessThan(1.6 * 1024 * 1024) // 旧字符口径会完整保留 2M 字符
    expect(r.stderr).toContain('已截断')
  })
})

// 静态整形引用防 tree-shake 误报
void ({} as unknown as TaskThreadInfo)
