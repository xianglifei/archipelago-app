// 回合改动文件卡·数据链路集成(2026-11-18 方案):内存 SQLite + 真 sessions.ts——
// 工具事件行落库(running)→ finishToolEvent 收尾带行级增删 meta 补丁 → listMessages 取回
// → 渲染端 collectTurnFiles 同一条聚合输入形状,断言一行一个文件与增删累加。
// schema 铺底同 task-threads.test.ts 的最小集(sessions/messages 两张表就够本链路)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
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

import { finishToolEvent, insertMessage, listMessages } from '../../src/main/sessions'
import { readFileTool, writeFileTool } from '../../src/main/fs-tools'
import { collectTurnFiles, sumTurnFileStats } from '../../src/renderer/src/utils/turn-files'
import type { TimelineItem } from '../../src/renderer/src/utils/turn-display'
import type { Bot, ChatMessage, ToolEventMeta } from '@shared/types'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'dm', ref TEXT, summary TEXT,
      cutoff_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      reasoning TEXT, created_at TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'chat',
      meta TEXT, exchange_id TEXT, turn_id TEXT, attachments TEXT
    );
    CREATE TABLE audit (bot_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
  `)
  return db
}

const SESSION_ID = 'sess-1'

function seedSession(): void {
  state.db!.prepare(
    'INSERT INTO sessions (id, bot_id, kind, ref, summary, cutoff_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(SESSION_ID, 'bot-1', 'dm', null, null, null, new Date().toISOString(), new Date().toISOString())
}

/** 模拟一次写/编动作的事件行:beginToolEvent(running 落行)→ 工具落笔 → done(metaPatch) */
function runToolRow(toolName: 'write_file' | 'edit_file', path: string, turnId: string, patch: { add?: number; del?: number }): void {
  const row = insertMessage(
    SESSION_ID,
    'assistant',
    `${toolName === 'write_file' ? '写入' : '编辑'} ${path}`,
    null,
    false,
    'tool',
    { toolName, status: 'running', path },
    undefined,
    turnId
  )
  finishToolEvent(row.id, 'done', 'ok', { k: 'chat.out.done' }, patch)
}

beforeEach(() => {
  state.db = freshDb()
  state.windows = []
  seedSession()
})

describe('回合改动文件数据链路(落库 → 补丁 → 取回 → 聚合)', () => {
  it('finishToolEvent 的 meta 补丁把增删行数写进事件行;同路径多次动作聚合为一行累加', () => {
    runToolRow('write_file', '/ws/SettingsCards.tsx', 'T1', { add: 24, del: 5 })
    runToolRow('edit_file', '/ws/SettingsCards.tsx', 'T1', { add: 3, del: 1 })
    // 无统计的行(旧数据形状)照常落行、无 add/del 字段
    const legacy = insertMessage(SESSION_ID, 'assistant', '写入 README.md', null, false, 'tool', {
      toolName: 'write_file',
      status: 'running',
      path: '/ws/README.md'
    }, undefined, 'T1')
    finishToolEvent(legacy.id, 'done', 'ok', { k: 'chat.out.done' })

    const messages = listMessages(SESSION_ID, false)
    expect(messages).toHaveLength(3)
    const metaOf = (m: ChatMessage): ToolEventMeta => m.meta as ToolEventMeta
    expect(metaOf(messages[0]!)).toMatchObject({ toolName: 'write_file', status: 'done', path: '/ws/SettingsCards.tsx', add: 24, del: 5 })
    expect(metaOf(messages[1]!)).toMatchObject({ add: 3, del: 1 })
    expect(metaOf(messages[2]!)).toMatchObject({ toolName: 'write_file', status: 'done', path: '/ws/README.md' })
    expect(metaOf(messages[2]!).add).toBeUndefined()

    // 渲染端同一形状输入:按 turn 的 timeline 聚合
    const timeline: TimelineItem[] = messages
      .filter((m) => m.kind === 'tool')
      .map((m) => ({ sortId: m.id, kind: 'tool' as const, message: m }))
    const entries = collectTurnFiles(timeline)
    expect(entries).toHaveLength(2) // a.ts 与 README.md;SettingsCards 两次动作合一
    expect(entries[0]).toMatchObject({ path: '/ws/SettingsCards.tsx', fileName: 'SettingsCards.tsx', dirName: '/ws', add: 27, del: 6, count: 2 })
    expect(sumTurnFileStats(entries)).toEqual({ add: 27, del: 6 })
  })

  it('running 行不进清单;跨 turn 的行各自成卡(聚合输入按回合给)', () => {
    // T2 只跑到一半:running 行落在库里,但本回合还没结束不渲染半截清单
    insertMessage(SESSION_ID, 'assistant', '写入 half.ts', null, false, 'tool', {
      toolName: 'write_file',
      status: 'running',
      path: '/ws/half.ts'
    }, undefined, 'T2')
    runToolRow('write_file', '/ws/done.ts', 'T3', { add: 6, del: 0 })

    const messages = listMessages(SESSION_ID, false)
    const itemsOf = (turnId: string): TimelineItem[] =>
      messages
        .filter((m) => m.turnId === turnId && m.kind === 'tool')
        .map((m) => ({ sortId: m.id, kind: 'tool' as const, message: m }))

    expect(collectTurnFiles(itemsOf('T2'))).toHaveLength(0)
    const done = collectTurnFiles(itemsOf('T3'))
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ fileName: 'done.ts', add: 6, del: 0, count: 1 })
  })
})

describe('writeFileTool 行级统计直通(真临时工作区)', () => {
  // 覆盖写入前旧文不可读的回归(2026-11-18 评审 P2):统计读单独兜错,写入照常、统计不出数;
  // 顺带覆盖正常链路 read → 覆盖 write → statsOut 回填真实差分。
  // chmod 语义只在非 win 非 root 下成立(root 读得了只写文件,win 权限位近似无效)
  const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0
  let ws = ''
  let bot: Bot

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-turn-files-'))
    // 写路径只碰 bot.id 与 bot.workspacePath(工作区内直放行,不触审批链)
    bot = { id: 'bot-stats', workspacePath: ws } as unknown as Bot
  })
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('旧文不可读(只写权限)时写入照常执行、统计不出数——统计读不许拖死写入', async () => {
    if (!canChmod) return
    const target = path.join(ws, 'wo.txt')
    fs.writeFileSync(target, '旧内容\n第二行\n')
    await readFileTool(bot, { path: target }) // 先读后写:mtime 登记过才允许覆盖
    fs.chmodSync(target, 0o200) // 只写:stat 照常、readFile 必 EACCES
    const stats: { add?: number; del?: number } = {}
    const out = await writeFileTool(bot, { path: target, content: '新内容\n' }, undefined, undefined, undefined, stats)
    expect(out.startsWith('已写入')).toBe(true)
    fs.chmodSync(target, 0o600) // 恢复可读,校验与清理才走得动
    expect(fs.readFileSync(target, 'utf8')).toBe('新内容\n')
    // 读不到旧文 → 没有统计(渲染端对缺省不渲染数字槽,语义自洽)
    expect(stats.add).toBeUndefined()
    expect(stats.del).toBeUndefined()
  })

  it('正常链路:read 后覆盖写,statsOut 回填真实行差分', async () => {
    const target = path.join(ws, 'ok.txt')
    fs.writeFileSync(target, 'a\nb\nc\n')
    await readFileTool(bot, { path: target })
    const stats: { add?: number; del?: number } = {}
    const out = await writeFileTool(bot, { path: target, content: 'a\nX\nc\n' }, undefined, undefined, undefined, stats)
    expect(out.startsWith('已写入')).toBe(true)
    expect(stats).toEqual({ add: 1, del: 1 })
  })
})
