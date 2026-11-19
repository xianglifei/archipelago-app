// 记忆挂消息侧契约(方案 - Linger 借鉴三件套 2026-11-19,批次②):
// - 消息序:记忆 system 消息在全部逐字历史之后、当前时间行之前——检查点仍在历史前;
// - 缓存契约本体:记忆写入(review 落盘/档案管家/岛主手改)后重建上下文,记忆之前的全部消息
//   逐字节不变,变化只落在末尾——「记忆不打穿历史前缀」的验收(与 tool-cache-contract 的 tools
//   契约互补:tools 排最前、记忆排最后,两轴都稳则全量前缀稳);
// - 群聊路径 buildGroupTurnContext 未导出,以源码契约静态锁「记忆在群转写后、时间行前」。
// 夹具同 prompt-contract(内存库 + electron 五件套 mock),memory 走真实文件读写。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import type { Bot, ChatMessage, OfficialSkillCard, SpaceInfo } from '@shared/types'

const DATA_ROOT = '/tmp/qd-memory-injection'

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  catalog: { revision: 1, skills: [] as OfficialSkillCard[] }
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
  metaGet: () => null,
  metaSet: () => undefined,
  nowIso: () => new Date().toISOString()
}))
vi.mock('../../src/main/paths', () => ({ requireDataRoot: () => DATA_ROOT }))
vi.mock('../../src/main/ui-language', () => ({
  getUiLanguage: () => 'zh',
  setUiLanguage: (l: string) => l,
  onUiLanguageChanged: () => () => undefined
}))
vi.mock('../../src/main/official-catalog', () => ({
  OFFICIAL_CREATOR_ID: 'official',
  currentCatalog: () => state.catalog,
  isCatalogStale: () => false,
  officialResolve: () => null
}))

import { buildContextMessages } from '../../src/main/steward'
import { addMemory } from '../../src/main/memory'
import type { SessionRow } from '../../src/main/sessions'
import type { LlmMessage } from '../../src/main/llm'
import { SKILLS_DDL } from '../../src/main/skills-core'
import { MCP_DDL } from '../../src/main/mcp-core'

/** LlmMessage.content 可能是多模态分段,统一文本化后做 includes 断言 */
const textOf = (m: LlmMessage): string => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))

// ---- 夹具 ----

const NOW = '2026-11-19T00:00:00.000Z'

const momo: Bot = {
  id: 'bot-memo',
  name: 'Momo',
  role: '调度',
  persona: '你做事喜欢先列清单。',
  archetype: 'genki',
  providerId: 'archipelago',
  modelId: 'glm-4.7',
  isMain: true,
  color: '#2f6b63',
  appearance: null,
  permission: 'semi',
  workspacePath: '/tmp/qd-momo-ws',
  createdAt: NOW,
  updatedAt: NOW
}

const space: SpaceInfo = { id: 'sp-1', name: '小岛', ownerName: '阿菲', createdAt: NOW }

const chat = (id: number, role: 'user' | 'assistant', content: string): ChatMessage => ({
  id,
  sessionId: 's-dm',
  role,
  content,
  reasoning: null,
  createdAt: `2026-11-19T09:${String(id).padStart(2, '0')}:00`,
  kind: 'chat'
})

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: 's-dm',
  botId: momo.id,
  kind: 'dm',
  ref: null,
  summary: null,
  cutoffId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over
})

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE bots (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL, model_id TEXT NOT NULL, is_main INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL, permission TEXT NOT NULL DEFAULT 'workspace', workspace_path TEXT,
      appearance TEXT, archetype TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    ${SKILLS_DDL}
  `)
  db.exec("ALTER TABLE skills ADD COLUMN origin TEXT NOT NULL DEFAULT 'island'")
  db.exec(MCP_DDL)
  db.prepare(
    "INSERT INTO bots (id, name, role, persona, provider_id, model_id, is_main, color, permission, workspace_path, archetype, created_at, updated_at) VALUES (?, 'Momo', '调度', '', 'archipelago', 'glm-4.7', 1, '#2f6b63', 'semi', '/tmp/qd-momo-ws', 'genki', ?, ?)"
  ).run(momo.id, NOW, NOW)
  return db
}

beforeEach(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true })
  state.db = freshDb()
  state.catalog = { revision: 1, skills: [] }
})

// ---- 消息序:记忆在历史后、时间行前 ----

describe('记忆注入位置(批次②)', () => {
  it('消息序:S1 → S2 → 检查点 → 历史 → 记忆 → 时间行', () => {
    addMemory(momo.id, '岛主的周报要发到飞书')
    addMemory('shared', '全岛统一用中文写周报')
    const history = [chat(1, 'user', '早'), chat(2, 'assistant', '早呀'), chat(3, 'user', '帮我排下今天的活')]
    const messages = buildContextMessages(
      momo,
      space,
      [],
      session({ summary: '(11-10 至 11-18) 之前聊了立项', cutoffId: 1 }),
      history
    )
    const idx = {
      s1: messages.findIndex((m) => textOf(m).includes('你是「Momo」')),
      s2: messages.findIndex((m) => textOf(m).includes('[当前状态')),
      checkpoint: messages.findIndex((m) => textOf(m).includes('之前聊了立项')),
      memory: messages.findIndex((m) => textOf(m).includes('周报要发到飞书'))
    }
    // 时间行=S1 里也预告过该格式,按「最后一条且以此开头」定位
    const timeIdx = messages.length - 1
    expect(textOf(messages[timeIdx]!).startsWith('[当前时间:')).toBe(true)
    expect(idx.s1).toBe(0)
    expect(idx.s2).toBe(1)
    expect(idx.checkpoint).toBeGreaterThan(idx.s2)
    // 记忆必须排在全部历史角色消息之后、时间行之前
    const lastChatIdx = messages.reduce((acc, m, i) => (m.role === 'user' || m.role === 'assistant' ? i : acc), -1)
    expect(idx.memory).toBeGreaterThan(lastChatIdx)
    expect(idx.memory).toBeLessThan(timeIdx)
  })

  it('缓存契约本体:记忆写入后重建,记忆之前的全部消息逐字节不变', () => {
    const history = [chat(1, 'user', '早'), chat(2, 'assistant', '早呀'), chat(3, 'user', '帮我排下今天的活')]
    const build = () =>
      buildContextMessages(momo, space, [], session({ summary: '旧摘要', cutoffId: 1 }), history)
    addMemory(momo.id, '岛主喜欢早上先看简报')
    const before = build()
    // 回合后 review 落了一条新记忆(memoryNote 变化),再建上下文
    addMemory(momo.id, '岛主的周报要发到飞书')
    const after = build()
    const memBefore = before.findIndex((m) => textOf(m).includes('喜欢早上先看简报'))
    const memAfter = after.findIndex((m) => textOf(m).includes('周报要发到飞书'))
    expect(memBefore).toBeGreaterThan(0)
    expect(memAfter).toBe(memBefore) // 位置不变(都在历史后)
    expect(JSON.stringify(after.slice(0, memAfter))).toBe(JSON.stringify(before.slice(0, memBefore)))
    expect(textOf(after[memAfter]!)).not.toBe(textOf(before[memBefore]!))
  })

  it('无记忆时不注入记忆消息(不产噪音空段)', () => {
    const messages = buildContextMessages(momo, space, [], session(), [chat(1, 'user', '早')])
    expect(messages.some((m) => textOf(m).includes('工作笔记') || textOf(m).includes('集体记忆'))).toBe(false)
  })
})

// ---- 群聊路径:源码契约静态锁(buildGroupTurnContext 未导出)----

describe('群聊记忆注入位置(源码契约)', () => {
  it('groups.ts:记忆 push 在群转写循环之后、currentTimeLine 之前', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'groups.ts'), 'utf8')
    const loopAt = src.indexOf('for (let i = 0; i < rows.length; i++)')
    const memoryAt = src.indexOf('const memory = memoryNote(bot.id)')
    const timeAt = src.indexOf('context.push({ role: \'user\', content: currentTimeLine() })')
    expect(loopAt).toBeGreaterThanOrEqual(0)
    expect(memoryAt).toBeGreaterThan(loopAt)
    expect(timeAt).toBeGreaterThan(memoryAt)
  })
})
