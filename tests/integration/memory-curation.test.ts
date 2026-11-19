// 夜间记忆整理编排集成(方案 - Linger 借鉴三件套 2026-11-19,批次③):真 TS + 真文件
// (临时 dataRoot)+ 真 meta KV(Map)+ mock LLM(chatOnce/llmCredentials)。验收:
// - happy path:提案经校验落盘,旧条目归档 history(程序写),context_events 落观测,脏标记清;
// - DONE / 坏协议 / 开关关闭 / 干净集 / 当天已跑:各自正确静默或部分应用;
// - shared scope 用主 Bot 模型;bot 缺位的 scope 移出队列。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const DATA_ROOT = '/tmp/qd-memory-curation'

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  meta: new Map<string, unknown>(),
  reply: 'DONE'
}))

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
  metaGet: <T,>(key: string): T | null => (state.meta.has(key) ? (state.meta.get(key) as T) : null),
  metaSet: (key: string, value: unknown) => void state.meta.set(key, value),
  nowIso: () => '2026-11-19T09:00:00.000Z'
}))
vi.mock('../../src/main/paths', () => ({ requireDataRoot: () => DATA_ROOT }))
vi.mock('../../src/main/ui-language', () => ({
  getUiLanguage: () => 'zh',
  setUiLanguage: (l: string) => l,
  onUiLanguageChanged: () => () => undefined
}))
vi.mock('../../src/main/space', () => ({ getSpace: () => ({ ownerName: '阿菲' }) }))
vi.mock('../../src/main/llm', () => ({
  chatOnce: vi.fn(async () => ({ content: state.reply })),
  llmCredentials: () => ({ baseUrl: 'https://llm.invalid', apiKey: 'synthetic-key' })
}))

import { memoryPrefsGet, memoryPrefsSave, tickMemoryCuration } from '../../src/main/memory-curation'
import { addMemory, listMemory } from '../../src/main/memory'

const NOW = '2026-11-01T00:00:00.000Z'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE bots (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL, model_id TEXT NOT NULL, is_main INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL, permission TEXT NOT NULL DEFAULT 'workspace', workspace_path TEXT,
      appearance TEXT, archetype TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE context_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
  `)
  db.prepare(
    "INSERT INTO bots (id, name, role, persona, provider_id, model_id, is_main, color, permission, workspace_path, archetype, created_at, updated_at) VALUES ('bot-cur', 'Momo', '调度', '', 'archipelago', 'glm-4.7', 1, '#2f6b63', 'semi', '/tmp/qd-ws', 'genki', ?, ?)"
  ).run(NOW, NOW)
  return db
}

const curationEvents = (): { session_id: string; detail: Record<string, unknown> }[] =>
  (state.db!.prepare("SELECT session_id, detail FROM context_events WHERE kind = 'memory-curation'").all() as {
    session_id: string
    detail: string
  }[]).map((r) => ({ session_id: r.session_id, detail: JSON.parse(r.detail) as Record<string, unknown> }))

beforeEach(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true })
  state.db = freshDb()
  state.meta.clear()
  state.reply = 'DONE'
})

describe('夜间记忆整理编排', () => {
  it('happy path:merge+reject 落盘、归档、观测、脏标记清、当天不重跑', async () => {
    addMemory('bot-cur', '岛主喜欢早上先看简报')
    addMemory('bot-cur', '岛主习惯早看简报')
    addMemory('bot-cur', '岛主在用旧笔记本(已换新)')
    state.reply = 'MERGE|1,2|岛主习惯早上先看简报\nREJECT|3|岛主已换新电脑'
    const now = new Date(2026, 10, 19, 1, 0)
    await tickMemoryCuration(now)
    // 清单:合并成一条,剔除一条
    const entries = listMemory().bots[0]!.entries
    expect(entries.map((e) => e.text)).toEqual(['岛主习惯早上先看简报'])
    expect(entries[0]!.date).toBe('2026-11-19')
    // 归档:3 条旧文本进 history(程序写)
    const history = readFileSync(join(DATA_ROOT, 'memory', 'bot-cur.history.md'), 'utf8')
    expect(history).toContain('岛主喜欢早上先看简报 → 并入合并')
    expect(history).toContain('岛主在用旧笔记本(已换新) → 剔除(岛主已换新电脑)')
    // 观测:context_events 一行,口径含 changed/archives/invalid
    const events = curationEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ session_id: 'memory:bot-cur' })
    expect(events[0]!.detail).toMatchObject({ scope: 'bot-cur', changed: 3, archives: 3, invalid: 0 })
    // 脏标记清空、lastRunDate 占坑:同日再 tick(哪怕有新脏)不重跑
    addMemory('bot-cur', '又一条新记忆')
    state.reply = 'REJECT|1|x'
    await tickMemoryCuration(new Date(2026, 10, 19, 23, 0))
    expect(curationEvents()).toHaveLength(1)
    expect(listMemory().bots[0]!.entries).toHaveLength(2)
  })

  it('DONE:文件不动、脏清、观测记 0 改动', async () => {
    addMemory('bot-cur', '条目一')
    addMemory('bot-cur', '条目二')
    state.reply = 'DONE'
    await tickMemoryCuration(new Date(2026, 10, 19, 2, 0))
    expect(listMemory().bots[0]!.entries).toHaveLength(2)
    expect(existsSync(join(DATA_ROOT, 'memory', 'bot-cur.history.md'))).toBe(false)
    expect(curationEvents()[0]!.detail).toMatchObject({ changed: 0 })
  })

  it('坏协议行丢弃,好行照常应用(坏行不伤整批)', async () => {
    addMemory('bot-cur', '保留条目')
    addMemory('bot-cur', '失效条目')
    state.reply = 'ADD|1|凭空新增\nBOGUS\nREJECT|2|已失效'
    await tickMemoryCuration(new Date(2026, 10, 19, 2, 0))
    expect(listMemory().bots[0]!.entries.map((e) => e.text)).toEqual(['保留条目'])
    expect(curationEvents()[0]!.detail).toMatchObject({ changed: 1, invalid: 2 })
  })

  it('开关关闭:完全静默(chatOnce 不被调),脏标记保留', async () => {
    expect(memoryPrefsGet().curationEnabled).toBe(true) // 缺省开
    memoryPrefsSave({ curationEnabled: false })
    expect(memoryPrefsGet().curationEnabled).toBe(false)
    addMemory('bot-cur', '条目一')
    addMemory('bot-cur', '条目二')
    state.reply = 'REJECT|1|x'
    await tickMemoryCuration(new Date(2026, 10, 19, 3, 0))
    expect(curationEvents()).toHaveLength(0)
    expect(listMemory().bots[0]!.entries).toHaveLength(2)
    // 重新打开后当天仍能补跑
    memoryPrefsSave({ curationEnabled: true })
    await tickMemoryCuration(new Date(2026, 10, 19, 4, 0))
    expect(curationEvents()).toHaveLength(1)
  })

  it('干净集(无新写入)与单条目 scope:不发起模型调用', async () => {
    await tickMemoryCuration(new Date(2026, 10, 19, 5, 0))
    expect(curationEvents()).toHaveLength(0)
    // 单条没什么可整理:清脏、不调模型
    addMemory('bot-cur', '孤条目')
    state.reply = 'REJECT|1|x' // 若误调,这条会把唯一条目剔掉
    await tickMemoryCuration(new Date(2026, 10, 19, 5, 30))
    expect(curationEvents()).toHaveLength(0)
    expect(listMemory().bots[0]!.entries).toHaveLength(1)
  })

  it('shared scope 走主 Bot,bot 缺位的 scope 移出队列不再重试', async () => {
    addMemory('shared', '全岛约定甲')
    addMemory('shared', '全岛约定乙')
    state.reply = 'MERGE|1,2|全岛约定(合并)'
    await tickMemoryCuration(new Date(2026, 10, 19, 6, 0))
    expect(listMemory().shared.map((e) => e.text)).toEqual(['全岛约定(合并)'])
    expect(curationEvents()[0]!.detail).toMatchObject({ scope: 'shared', changed: 2 })
    // 已删居民的遗留 scope:移出脏集(不发起调用),不影响其他 scope
    state.meta.set('memory.curation.dirty', JSON.stringify(['bot-ghost']))
    state.reply = 'REJECT|1|x'
    await tickMemoryCuration(new Date(2026, 11, 1, 6, 0))
    expect(curationEvents()).toHaveLength(1) // 没有新增事件
    expect(state.meta.get('memory.curation.dirty')).toBe('[]')
  })
})
