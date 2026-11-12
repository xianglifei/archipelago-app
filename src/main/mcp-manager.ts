import { mkdirSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  effectiveStdioCommand,
  buildStdioEnv,
  contentBlocksToText,
  mcpErrorText,
  truncateMcpResult,
  wrapToolErrorText,
  type McpConnectorConfig,
  type McpTransport
} from './mcp-core'
import { requireDataRoot } from './paths'

// MCP 连接器运行时(2026-11-06):SDK 薄壳。每连接器一个 Client 实例,岛级共享
// (多居民多回合复用),懒启动+崩溃退避+登出清理。纯逻辑在 mcp-core.ts,DB 层在 mcp.ts;
// 审批不在本层(tools.ts 的 callMcpToolWithApproval 负责),保证本层可被集成测试直接打。
// 传输工厂可注入:测试用 InMemoryTransport 起进程内假服务器走全链。

export interface McpToolInfo {
  /** 服务方原始工具名(非转译名) */
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** 转译进 ToolSpec 的字符量(描述+schema),预算装箱用 */
  chars: number
}

export type McpConnStatus = 'stopped' | 'starting' | 'ready' | 'error'

interface ConnEntry {
  client: Client | null
  transportKind: 'streamable-http' | 'sse' | 'stdio' | null
  status: McpConnStatus
  lastError: string | null
  tools: McpToolInfo[] | null
  /** 下次允许重连的时间戳(崩溃退避 1/2/4…60s 封顶) */
  nextAttemptAt: number
  attempts: number
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]

const conns = new Map<string, ConnEntry>()
/** 转译名 → 归属(toolsFor 组装时登记;executeTool 精确分发用,不经 slug 反查) */
const toolBindings = new Map<string, { connectorId: string; tool: string }>()
/** 每连接器的连接串行化(并发回合同时暖连接只连一次) */
const connecting = new Map<string, Promise<Client>>()

function entryOf(connectorId: string): ConnEntry {
  let e = conns.get(connectorId)
  if (!e) {
    e = { client: null, transportKind: null, status: 'stopped', lastError: null, tools: null, nextAttemptAt: 0, attempts: 0 }
    conns.set(connectorId, e)
  }
  return e
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}超时(超过 ${Math.round(ms / 1000)} 秒)`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) }
    )
  })
}

// ── 传输构建(测试可整体替换) ─────────────────────────────────────────────

export type McpTransportFactory = (
  transport: McpTransport,
  config: McpConnectorConfig,
  connectorId: string
) => Transport

let transportFactory: McpTransportFactory | null = null

/** 集成测试注入 InMemoryTransport;传 null 恢复生产传输 */
export function setMcpTransportFactoryForTests(f: McpTransportFactory | null): void {
  transportFactory = f
}

/** stdio 子进程 cwd:<数据根>/mcp。目录必须真实存在——spawn 的 ENOENT 会把「cwd 不存在」
 *  误报成「命令不存在」(stdio 冒烟实测踩中),所以这里 lazy mkdir,失败则不设 cwd */
function stdioCwd(): string | undefined {
  const dir = `${requireDataRoot()}/mcp`
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return undefined
  }
}

function buildStdioTransport(config: McpConnectorConfig): StdioClientTransport {
  const cfg = config as Extract<McpConnectorConfig, { command: string }>
  const eff = effectiveStdioCommand(cfg.command, cfg.args)
  const transport = new StdioClientTransport({
    command: eff.command,
    args: eff.args,
    env: buildStdioEnv(cfg.env),
    cwd: stdioCwd(),
    stderr: 'pipe'
  })
  // SDK 把子进程 stderr 接进 PassThrough 后就不管了:没人消费,缓冲写满即背压,
  // 爱打日志的 stdio 服务会整个卡死。挂一个恒消费的 drain 保持管道畅通
  transport.stderr?.on('data', () => {})
  return transport
}
function buildHttpCandidates(config: McpConnectorConfig): Transport[] {
  const cfg = config as Extract<McpConnectorConfig, { url: string }>
  const url = new URL(cfg.url)
  const headers = cfg.headers ?? {}
  // Streamable HTTP 优先,连接失败自动落 SSE 回退(官方文档明确回退要自组,
  // 覆盖百度网盘类纯 SSE 端点)。fetch 注入(§6.2 验证点)暂不做:境内官方端点无需代理,
  // SDK 在主进程用 undici 全局 fetch;代理环境适配留待后续版本注入 net.fetch。
  // eventSourceInit.headers 是 eventsource 包的扩展(DOM 类型没标),运行时生效,这里过一道断言
  const esInit = { headers, withCredentials: false } as unknown as EventSourceInit
  return [
    new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
    new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: esInit })
  ]
}

/** 生产候选表:stdio 单候选;http 两个候选依次尝试 */
function buildCandidates(transport: McpTransport, config: McpConnectorConfig, connectorId: string): Transport[] {
  if (transportFactory) return [transportFactory(transport, config, connectorId)]
  return transport === 'stdio' ? [buildStdioTransport(config)] : buildHttpCandidates(config)
}

function classifyTransport(t: Transport): 'streamable-http' | 'sse' | 'stdio' {
  return t instanceof StdioClientTransport ? 'stdio' : t instanceof SSEClientTransport ? 'sse' : 'streamable-http'
}

// ── 连接生命周期 ───────────────────────────────────────────────────────────

async function connectOne(connectorId: string, transport: McpTransport, config: McpConnectorConfig): Promise<Client> {
  const e = entryOf(connectorId)
  e.status = 'starting'
  e.lastError = null
  const candidates = buildCandidates(transport, config, connectorId)
  let lastErr: unknown
  // 候选依次尝试(每个候选配全新 Client,失败的半连状态随手丢弃)
  for (const candidate of candidates) {
    const client = new Client({ name: 'Archipelago', version: '1.0.0' })
    client.onclose = () => {
      // HTTP 无常驻连接,close 是正常收尾;stdio 掉线才算事故。都清缓存,下次调用重连
      const cur = conns.get(connectorId)
      if (cur?.client === client) {
        cur.client = null
        cur.tools = null
        if (cur.status === 'ready') cur.status = 'stopped'
      }
    }
    client.onerror = (err) => {
      const cur = conns.get(connectorId)
      if (cur?.client === client) {
        cur.lastError = err instanceof Error ? err.message : String(err)
        // 不在这里置 error:单次请求失败由调用方定性,连接级 onclose 才清连接
      }
    }
    try {
      await withTimeout(client.connect(candidate), MCP_CONNECT_TIMEOUT_MS, '连接服务')
      // 连接期间连接器可能被停用/删除/改配(invalidateMcpConnector 已把 entry 摘走):
      // 这条刚建好的连接归不进现行 entry,就地关闭,不让它写成无主的 ready 态
      if (conns.get(connectorId) !== e) {
        try { await client.close() } catch { /* 尽力而为 */ }
        throw new Error('服务配置已变更,本次连接作废')
      }
      e.client = client
      e.status = 'ready'
      e.attempts = 0
      e.transportKind = classifyTransport(candidate)
      return client
    } catch (err) {
      lastErr = err
      try { await client.close() } catch { /* 尽力而为 */ }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 确保连接可用(懒启动+退避);失败抛 lastError 给调用方翻译 */
async function ensureClient(
  connectorId: string,
  transport: McpTransport,
  config: McpConnectorConfig
): Promise<Client> {
  const e = entryOf(connectorId)
  if (e.client && e.status === 'ready') return e.client
  const inflight = connecting.get(connectorId)
  if (inflight) return inflight
  if (Date.now() < e.nextAttemptAt) {
    throw new Error(e.lastError ?? '服务暂时不可用,稍后再试')
  }
  const task = (async () => {
    try {
      return await connectOne(connectorId, transport, config)
    } catch (err) {
      // entry 已被 invalidate/重建(连接期间停用改配)时,错误态只写回还是本代理的那份,
      // 不污染新配置的新 entry
      if (conns.get(connectorId) === e) {
        e.status = 'error'
        e.lastError = err instanceof Error ? err.message : String(err)
        e.client = null
        e.tools = null
        e.nextAttemptAt = Date.now() + (BACKOFF_MS[Math.min(e.attempts, BACKOFF_MS.length - 1)] ?? 60_000)
        e.attempts += 1
      }
      throw err
    } finally {
      connecting.delete(connectorId)
    }
  })()
  connecting.set(connectorId, task)
  return task
}

/** 拉取并缓存工具清单(连接后一次;tools/list_changed 通知在 v1 轮次模型下按「每次回合暖连接时过期重拉」简化) */
async function refreshTools(
  connectorId: string,
  client: Client,
  signal?: AbortSignal
): Promise<McpToolInfo[]> {
  const resp = await withTimeout(
    client.listTools({}, { timeout: MCP_CONNECT_TIMEOUT_MS, signal }),
    MCP_CONNECT_TIMEOUT_MS,
    '获取能力清单'
  )
  const tools = (resp.tools ?? []) as Tool[]
  const list = tools.map((t) => ({
    name: t.name,
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    chars: JSON.stringify({ d: t.description ?? '', s: t.inputSchema ?? {} }).length
  }))
  const e = entryOf(connectorId)
  e.tools = list
  return list
}

export interface ConnectorRuntimeInfo {
  connectorId: string
  transport: McpTransport
  config: McpConnectorConfig
}

/** 暖连接+刷新工具缓存(回合开始前调用;全部异常吞进状态,绝不打断回合)。
 *  已 ready 且有缓存的直接跳过(稳态零请求,prompt cache 前缀稳定) */
export async function warmMcpConnectors(items: ConnectorRuntimeInfo[]): Promise<void> {
  await Promise.all(
    items.map(async (it) => {
      const e = entryOf(it.connectorId)
      if (e.client && e.status === 'ready' && e.tools) return
      try {
        const client = await ensureClient(it.connectorId, it.transport, it.config)
        if (!e.tools) await refreshTools(it.connectorId, client)
      } catch {
        // 状态与 lastError 已在 ensureClient 里落好;UI 可见,不打断回合
      }
    })
  )
}

/** toolsFor 组装用:某连接器当前缓存的工具(没有=没连上,本轮不注入) */
export function cachedConnectorTools(connectorId: string): McpToolInfo[] {
  return entryOf(connectorId).tools ?? []
}

/** 转译名登记与反查(toolsFor 登记 → executeTool 精确分发) */
export function registerMcpToolBinding(mangled: string, binding: { connectorId: string; tool: string }): void {
  toolBindings.set(mangled, binding)
}

export function lookupMcpToolBinding(mangled: string): { connectorId: string; tool: string } | null {
  return toolBindings.get(mangled) ?? null
}

// ── 工具调用(审批之后的执行段) ───────────────────────────────────────────

/** 执行一次 MCP 工具调用;返回给模型的字符串(结果截断/错误人话都在这层收口) */
export async function invokeMcpTool(
  info: ConnectorRuntimeInfo & { name: string },
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  let client: Client
  try {
    client = await ensureClient(info.connectorId, info.transport, info.config)
  } catch (err) {
    return mcpErrorText(info.name, err)
  }
  try {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: MCP_CALL_TIMEOUT_MS,
      signal
    })
    const text = contentBlocksToText(result.content)
    if (result.isError) return truncateMcpResult(wrapToolErrorText(text))
    return truncateMcpResult(text || '该工具没有返回内容。')
  } catch (err) {
    // 请求级失败:连接可能已坏,清缓存让下次调用重连
    const e = entryOf(info.connectorId)
    if (e.client && !(err instanceof Error && /abort/i.test(err.message))) {
      // 保守起见不动连接(服务端业务错也会走到这),只有异常形态才重置:
      if (/fetch failed|socket hang up|ECONN|EPIPE|session/i.test(err instanceof Error ? err.message : String(err))) {
        try { await e.client.close() } catch { /* 尽力而为 */ }
        e.client = null
        e.tools = null
        e.status = 'stopped'
      }
    }
    return mcpErrorText(info.name, err)
  }
}

// ── 状态与清理 ─────────────────────────────────────────────────────────────

/** 技能中心详情浮窗的状态行数据 */
export function connectorRuntimeStatus(connectorId: string): {
  status: McpConnStatus
  transportKind: 'streamable-http' | 'sse' | 'stdio' | null
  toolCount: number
  lastError: string | null
} {
  const e = entryOf(connectorId)
  return {
    status: e.status,
    transportKind: e.transportKind,
    toolCount: e.tools?.length ?? 0,
    lastError: e.lastError
  }
}

/** 连接器配置/状态变更(编辑、停用、删除)后清运行态:下次回合按新配置重来 */
export function invalidateMcpConnector(connectorId: string): void {
  const e = conns.get(connectorId)
  if (e?.client) {
    // 尽力关闭;onclose 回调会清缓存
    try { void e.client.close() } catch { /* 尽力而为 */ }
  }
  conns.delete(connectorId)
  for (const [k, v] of toolBindings) {
    if (v.connectorId === connectorId) toolBindings.delete(k)
  }
}

/** 登出/切号/应用退出:关全部连接杀全部子进程 */
export async function closeAllMcp(): Promise<void> {
  const jobs: Promise<void>[] = []
  for (const [id, e] of conns) {
    if (e.client) {
      jobs.push(
        e.client.close().catch(() => { /* 尽力而为 */ })
      )
    }
    conns.delete(id)
  }
  toolBindings.clear()
  await Promise.all(jobs)
}
