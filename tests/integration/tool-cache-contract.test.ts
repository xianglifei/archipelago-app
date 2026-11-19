// 工具注入缓存稳定性契约(方案 - 工具注入缓存稳定性 2026-11-19,PR-1 = P1+P2):
// - P2 缓存契约本体:权限档 semi↔auto 切换,toolsFor 装配的 tools 数组序列化逐字节不变——
//   tools 在多数提供方的缓存前缀里排最前,这一条就是「切档不打穿全量前缀」的验收;
// - P1b turn-usage 事件:每回合一行 kind='turn-usage'(此处直打 recordTurnUsage 落库函数;
//   回合链接线由 typecheck 把关,LLM 侧无集成夹具);
// - P1c tools 段并轨:withToolsSection 增键口径(toolsTokensFor 与压缩事件同一校准通道)。
// 夹具同 prompt-contract(内存库 + 空官方目录);tools/steward 走真实实现,electron 五件套 mock。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { OfficialSkillCard } from '@shared/types'
import type { Bot } from '@shared/types'

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
vi.mock('../../src/main/auth', () => ({
  currentSeaToken: () => 'synthetic-token',
  currentIslandUid: () => '11111111-1111-4111-8111-111111111111',
  seaRelayBaseUrl: () => 'https://relay.invalid',
  cloudModelWindow: () => null
}))
vi.mock('../../src/main/secrets', () => ({ getApiKey: () => 'synthetic-key' }))
vi.mock('../../src/main/space', () => ({ getSpace: () => ({ ownerName: '合成岛主' }) }))
vi.mock('../../src/main/paths', () => ({ requireDataRoot: () => '/tmp/qd-tool-cache-contract' }))
vi.mock('../../src/main/ui-language', () => ({
  getUiLanguage: () => 'zh',
  setUiLanguage: (l: string) => l,
  onUiLanguageChanged: () => () => undefined
}))
vi.mock('../../src/main/ui-strings', () => ({ uiStr: (key: string) => key }))
// 官方目录 mock:catalog 是随版本演进的业务数据,不进契约
vi.mock('../../src/main/official-catalog', () => ({
  OFFICIAL_CREATOR_ID: 'official',
  currentCatalog: () => state.catalog,
  isCatalogStale: () => false,
  officialResolve: () => null
}))

import { toolsBundleFor, toolsFor } from '../../src/main/tools'
import { recordTurnUsage, toolsTokensFor, withToolsSection, type TurnUsageDetail } from '../../src/main/steward'
import type { ToolSpec } from '../../src/main/llm'
import { SKILLS_DDL } from '../../src/main/skills-core'
import { MCP_DDL } from '../../src/main/mcp-core'

// ---- 夹具 ----

const NOW = '2026-11-19T00:00:00.000Z'

const baseBot: Bot = {
  id: 'bot-cache',
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
    ${SKILLS_DDL}
  `)
  db.exec("ALTER TABLE skills ADD COLUMN origin TEXT NOT NULL DEFAULT 'island'")
  db.exec(MCP_DDL)
  return db
}

beforeEach(() => {
  state.db = freshDb()
  state.catalog = { revision: 1, skills: [] }
})

// ---- P2:权限档 tools 稳定性(缓存契约本体)----

describe('P2 权限档切换的 tools 契约', () => {
  it('semi↔auto 切换:dm 场景 tools 序列化逐字节相等', () => {
    const semi = JSON.stringify(toolsBundleFor(baseBot, 0, 'dm').tools)
    const auto = JSON.stringify(toolsBundleFor({ ...baseBot, permission: 'auto' }, 0, 'dm').tools)
    expect(semi).toBe(auto)
  })

  it('task 场景(带任务工作目录 rebase)同样逐字节相等——描述改写路径不分档', () => {
    const semi = JSON.stringify(toolsBundleFor(baseBot, 0, 'task', '/tmp/wt-x').tools)
    const auto = JSON.stringify(toolsBundleFor({ ...baseBot, permission: 'auto' }, 0, 'task', '/tmp/wt-x').tools)
    expect(semi).toBe(auto)
  })

  it('run_command 描述档位中性:指向 S2 权限档位行,不再有档位专属话术', () => {
    const spec = toolsFor(baseBot, 0, 'dm').find((t) => t.function.name === 'run_command')
    expect(spec).toBeDefined()
    expect(spec!.function.description).toContain('以系统提示中的当前权限档位为准')
    // 「直接执行」/「不会弹审批卡」是 auto 专属旧话术,出现即代表分叉回归
    expect(spec!.function.description).not.toContain('不会弹审批卡')
  })

  it('toolsFor 薄壳与 toolsBundleFor.tools 同源(兼容签名不产新装配路径)', () => {
    expect(JSON.stringify(toolsFor(baseBot, 0, 'dm'))).toBe(JSON.stringify(toolsBundleFor(baseBot, 0, 'dm').tools))
  })

  it('无连接器时 mcpOmitted 为空数组(事件字段恒在,不为 undefined)', () => {
    expect(toolsBundleFor(baseBot, 0, 'dm').mcpOmitted).toEqual([])
  })
})

// ---- P1b:turn-usage 事件落库 ----

describe('P1b recordTurnUsage', () => {
  const detail: TurnUsageDetail = {
    promptTokens: 12000,
    cachedPromptTokens: 9500,
    completionTokens: 678,
    toolsTokens: 6120,
    toolsCount: 31,
    mcpOmitted: ['装不下的服务']
  }

  it('落一行 kind=turn-usage,detail 六字段齐全可回读', () => {
    recordTurnUsage('sess-1', detail)
    const row = state.db!
      .prepare('SELECT session_id, kind, detail FROM context_events')
      .get() as { session_id: string; kind: string; detail: string }
    expect(row.session_id).toBe('sess-1')
    expect(row.kind).toBe('turn-usage')
    expect(JSON.parse(row.detail)).toEqual(detail)
  })

  it('cachedPromptTokens=null 序列化保留(null=端点未回传,与 0 区分)', () => {
    recordTurnUsage('sess-1', { ...detail, cachedPromptTokens: null })
    const row = state.db!.prepare('SELECT detail FROM context_events').get() as { detail: string }
    expect((JSON.parse(row.detail) as TurnUsageDetail).cachedPromptTokens).toBeNull()
  })

  it('落库失败只留痕不抛(纯观测,绝不打断回合):表缺失场景', () => {
    state.db!.exec('DROP TABLE context_events')
    expect(() => recordTurnUsage('sess-1', detail)).not.toThrow()
  })
})

// ---- P1c:tools 段 token 并轨 ----

describe('P1c toolsTokensFor / withToolsSection', () => {
  const tools: ToolSpec[] = toolsBundleFor(baseBot, 0, 'dm').tools

  it('toolsTokensFor 按序列化形态估算,正数且两次调用一致(确定性)', () => {
    const a = toolsTokensFor('sess-1', tools)
    const b = toolsTokensFor('sess-1', tools)
    expect(a).toBeGreaterThan(0)
    expect(a).toBe(b)
  })

  it('withToolsSection:带工具添 tools 键,与提示词段并轨;不带不添(口径同「空节省略」)', () => {
    const sections = [{ name: 'stable', text: '稳定核' }]
    const withTools = withToolsSection('sess-1', sections, tools)
    expect(Object.keys(withTools)).toContain('tools')
    expect(withTools.stable).toBeGreaterThan(0)
    const withoutTools = withToolsSection('sess-1', sections, undefined)
    expect(Object.keys(withoutTools)).not.toContain('tools')
    expect(withoutTools.stable).toBe(withTools.stable)
  })
})
