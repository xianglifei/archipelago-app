import { describe, expect, it, vi, afterEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCP_DDL } from '../../src/main/mcp-core'

const here = path.dirname(fileURLToPath(import.meta.url))

// MCP stdio 真实子进程冒烟(2026-11-06):InMemory 集成测试不打真实 spawn,这里补——
// 真 StdioClientTransport 起本地假服务器(tests/helpers/mcp-fake-stdio-server.mjs),
// 验证 spawn/env 白名单注入/调用回显全链。依赖 node 在 PATH(CI 与本机都有)。

const state: { db: Database.Database } = { db: null as never }
vi.mock('../../src/main/store', () => ({
  getDb: () => state.db,
  nowIso: () => '2026-11-06T00:00:00.000Z'
}))
// stdio cwd 指向 /tmp 下已存在的目录(manager 现在会 lazy mkdir <数据根>/mcp)
import { mkdirSync } from 'node:fs'
const mcpRoot = '/tmp/qd-mcp-stdio-root'
try { mkdirSync(`${mcpRoot}/mcp`, { recursive: true }) } catch { /* 已存在 */ }
vi.mock('../../src/main/paths', () => ({ requireDataRoot: () => mcpRoot }))
vi.mock('../../src/main/approval', () => ({ requestApproval: async () => 'approved' }))
vi.mock('../../src/main/bots', () => ({ getBot: () => ({ id: 'momo', name: 'Momo' }) }))
vi.mock('../../src/main/audit', () => ({ audit: vi.fn() }))
vi.mock('../../src/main/official-catalog', () => ({ officialResolve: () => null, OFFICIAL_CREATOR_ID: 'official' }))

import Database from 'better-sqlite3'
import { mcpSlug } from '../../src/main/mcp-core'
const { mcpAddManual, installConnectorTo, mcpToolSpecsFor, warmMcpToolsForBot, callMcpToolWithApproval } = await import(
  '../../src/main/mcp'
)
const { closeAllMcp } = await import('../../src/main/mcp-manager')

const momo = { id: 'momo', name: 'Momo' } as never

describe('MCP stdio 真实子进程全链', () => {
  afterEach(async () => {
    await closeAllMcp()
  })

  it('spawn 假服务器:工具发现+env 注入+调用回显', { timeout: 30_000 }, async () => {
    state.db = new Database(':memory:')
    state.db.exec(MCP_DDL)
    const serverPath = path.join(here, '..', 'helpers', 'mcp-fake-stdio-server.mjs')
    const names = mcpAddManual(
      JSON.stringify({
        mcpServers: {
          '本地假服务': {
            // 用 PATH 上的 node(而非 process.execPath):顺带验证 env 白名单的 PATH 透传
            command: 'node',
            args: [serverPath],
            env: { FAKE_KEY: 'abc123' }
          }
        }
      })
    )
    expect(names).toEqual(['本地假服务'])
    const conn = state.db.prepare('SELECT id, name FROM connectors').get() as { id: string; name: string }
    installConnectorTo(conn.id, 'momo')
    // 真实 spawn(StdioClientTransport,非注入工厂):暖连接→listTools
    await warmMcpToolsForBot('momo')
    const { specs } = mcpToolSpecsFor(momo)
    expect(specs.map((s) => s.function.name)).toEqual([`mcp__${mcpSlug('本地假服务')}__echo`])
    // env 白名单:自定义 FAKE_KEY 注入,服务端回显确认
    const out = await callMcpToolWithApproval(momo, specs[0]!.function.name, { text: 'hi' })
    expect(out).toContain('echo:hi')
    expect(out).toContain('envKey=abc123')
  })
})
