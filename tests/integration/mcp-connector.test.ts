import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { MCP_DDL } from '../../src/main/mcp-core'
import { mcpSlug } from '../../src/main/mcp-core'

// MCP 连接器全链集成冒烟(2026-11-06,需求 doc/需求 - MCP 连接器(居民 MCP 能力接入) - 2026-11-06.md):
// 进程内假 MCP 服务器(InMemoryTransport)打真 manager+mcp.ts——解析入库→分配→暖连接→工具转译→
// 审批三分支→停用→重连。审批/electron 边界全 mock,只验真实链路逻辑。

const state: { db: Database.Database } = { db: null as never }
vi.mock('../../src/main/store', () => ({
  getDb: () => state.db,
  nowIso: () => '2026-11-06T00:00:00.000Z'
}))
vi.mock('../../src/main/paths', () => ({ requireDataRoot: () => '/tmp/qd-mcp-test' }))
let approvalDecision = 'approved'
vi.mock('../../src/main/approval', () => ({
  requestApproval: vi.fn(async () => approvalDecision)
}))
vi.mock('../../src/main/bots', () => ({ getBot: () => ({ id: 'momo', name: 'Momo' }) }))
vi.mock('../../src/main/audit', () => ({ audit: vi.fn() }))
vi.mock('../../src/main/official-catalog', () => ({
  officialResolve: () => null,
  OFFICIAL_CREATOR_ID: 'official'
}))

const { setMcpTransportFactoryForTests } = await import('../../src/main/mcp-manager')
const {
  listConnectors,
  mcpAddManual,
  installConnectorTo,
  islandConnectorSummaries,
  setConnectorDisabled,
  mcpToolSpecsFor,
  warmMcpToolsForBot,
  callMcpToolWithApproval
} = await import('../../src/main/mcp')
const { closeAllMcp, invalidateMcpConnector } = await import('../../src/main/mcp-manager')

/** 进程内假 MCP 服务器:echo 正常回显 / boom 业务报错;每次调用产新链路对(重连可复用) */
function makeFakeClientTransport(): Transport {
  const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: '回声测试',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
      },
      { name: 'boom', description: '总是报错', inputSchema: { type: 'object', properties: {} } }
    ]
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'boom') {
      return { content: [{ type: 'text', text: '参数缺失' }], isError: true }
    }
    return { content: [{ type: 'text', text: `echo:${JSON.stringify(req.params.arguments ?? {})}` }] }
  })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  void server.connect(serverT)
  return clientT
}

function fixture(): void {
  state.db = new Database(':memory:')
  state.db.exec(MCP_DDL)
  setMcpTransportFactoryForTests(() => makeFakeClientTransport())
  approvalDecision = 'approved'
}

async function addAssignedConnector(): Promise<string> {
  const [item] = mcpAddManual(
    JSON.stringify({
      mcpServers: {
        '瑞幸咖啡': { url: 'https://gwmcp.lkcoffee.com/order/user/user-mcp', headers: { Authorization: 'Bearer x' } }
      }
    })
  )
  const conn = listConnectors().find((r: { name: string }) => r.name === item)
  if (!conn) throw new Error('fixture: 连接器没插进去')
  installConnectorTo(conn.id, 'momo')
  return conn.id
}

const momo = { id: 'momo', name: 'Momo' } as never

describe('MCP 连接器全链(InMemory 假服务器)', () => {
  beforeEach(() => fixture())
  afterEach(async () => {
    setMcpTransportFactoryForTests(null)
    await closeAllMcp()
  })

  it('手动添加:WorkBuddy 同型 JSON 解析入库', async () => {
    const names = mcpAddManual(
      '{"mcpServers":{"ima-mcp":{"url":"https://ima.qq.com/mcp","type":"streamable-http"}}}'
    )
    expect(names).toEqual(['ima-mcp'])
    const { listConnectors } = await import('../../src/main/mcp')
    const rows = listConnectors()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.transport).toBe('http')
    expect(rows[0]!.origin).toBe('manual')
  })

  it('暖连接后工具转译进 specs,绑定可反查;调用走审批后回显', async () => {
    const id = await addAssignedConnector()
    await warmMcpToolsForBot('momo')
    const { specs, omitted } = mcpToolSpecsFor(momo)
    expect(omitted).toHaveLength(0)
    expect(specs.map((s) => s.function.name).sort()).toEqual([
      `mcp__${mcpSlug('瑞幸咖啡')}__boom`,
      `mcp__${mcpSlug('瑞幸咖啡')}__echo`
    ])
    expect(specs[0]!.function.parameters).toHaveProperty('type')
    const out = await callMcpToolWithApproval(momo, specs.find((s) => s.function.name.includes('echo'))!.function.name, {
      text: '你好'
    })
    expect(out).toBe('echo:{"text":"你好"}')
    // 能力数进 summaries(连接器行)
    const sums = islandConnectorSummaries()
    expect(sums).toHaveLength(1)
    expect(sums[0]!.assignedCount).toBe(1)
    expect(sums[0]!.toolCount).toBe(2)
    expect(sums[0]!.id).toBe(id)
  })

  it('业务报错(isError)与人话包装;审批拒绝/中止各有文案', async () => {
    await addAssignedConnector()
    await warmMcpToolsForBot('momo')
    const { specs } = mcpToolSpecsFor(momo)
    const boom = specs.find((s) => s.function.name.includes('boom'))!.function.name
    const out = await callMcpToolWithApproval(momo, boom, {})
    expect(out).toContain('服务方返回了错误')
    approvalDecision = 'denied'
    const denied = await callMcpToolWithApproval(momo, boom, {})
    expect(denied).toContain('没有同意')
    approvalDecision = 'aborted'
    const aborted = await callMcpToolWithApproval(momo, boom, {})
    expect(aborted).toContain('已停止')
  })

  it('停用后工具即刻不注入,作废运行态后重连可用', async () => {
    const id = await addAssignedConnector()
    await warmMcpToolsForBot('momo')
    setConnectorDisabled(id, true)
    // disabled 连接器不在注入名单;旧的转译名经兜底反查也找不到(不匹配 active 连接器)
    expect(mcpToolSpecsFor(momo).specs).toHaveLength(0)
    const stale = await callMcpToolWithApproval(momo, `mcp__x__echo`, {})
    expect(stale).toContain('找不到对应的服务')
    // 恢复+作废运行态:重连(新 InMemory 对)后回到可用
    setConnectorDisabled(id, false)
    invalidateMcpConnector(id)
    await warmMcpToolsForBot('momo')
    const again = mcpToolSpecsFor(momo)
    expect(again.specs.length).toBe(2)
    const echo = again.specs.find((s) => s.function.name.includes('echo'))!.function.name
    expect(await callMcpToolWithApproval(momo, echo, { text: 'a' })).toBe('echo:{"text":"a"}')
  })
})
