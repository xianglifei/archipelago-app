import { createHash } from 'node:crypto'

// MCP 连接器纯逻辑层(2026-11-06):配置校验/手动 JSON 解析/工具名转译/env 白名单/
// Windows 命令改写/错误人话/预算截断/模板占位符——全部零 electron 零 SDK 依赖,
// 单测直接打这里(mcp-manager.ts 是 SDK 薄壳,mcp.ts 是 DB 层)。
// 需求与拍板口径:doc/需求 - MCP 连接器(居民 MCP 能力接入) - 2026-11-06.md
// 面向用户的呈现零 MCP 痕迹(精选推荐混排),本文件内部命名直白用 mcp/connector。

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 模型可见的 MCP 工具名前缀(行业惯例,Claude/Cursor 同款心智) */
export const MCP_TOOL_PREFIX = 'mcp__'
/** 单次工具结果注入上下文的字符上限(超出截断,防上下文爆) */
export const MCP_RESULT_MAX_CHARS = 20_000
/** 每居民 MCP 工具 schema 总预算(字符):超了按连接器整组降级(拍板点⑨) */
export const MCP_SCHEMA_BUDGET_CHARS = 24_000
/** 连接建立(含 stdio 进程冷启动)超时 */
export const MCP_CONNECT_TIMEOUT_MS = 10_000
/** 单次工具调用超时(群里有 600 次/分限流的官方端点,慢是常态不是异常) */
export const MCP_CALL_TIMEOUT_MS = 60_000
/** stdio 子进程 stdio 通道的 stderr 采样条数上限(调试用,防刷屏) */
export const MCP_STDERR_SAMPLE_MAX = 20

export type McpTransport = 'http' | 'stdio'

export interface McpHttpConfig {
  url: string
  headers?: Record<string, string>
}

export interface McpStdioConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type McpConnectorConfig = McpHttpConfig | McpStdioConfig

// ── DDL(store.ts migrate() 执行;纯逻辑文件单点,与 skills-core 同惯例) ──

export const MCP_DDL = `
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL,
  config TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  origin TEXT NOT NULL DEFAULT 'manual',
  catalog_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_installs (
  connector_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, bot_id)
);
`

// ── 配置校验(人话错误;UI 与手动添加共用) ──────────────────────────────

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 校验连接器配置;返回 null=合法,否则人话错误(中文,居民世界/岛主展示两用) */
export function validateMcpConfig(transport: McpTransport, raw: unknown): string | null {
  if (!isPlainRecord(raw)) return '连接器配置不是有效的 JSON 对象'
  if (transport === 'http') {
    const url = raw.url
    if (typeof url !== 'string' || !url.trim()) return '缺少服务地址(url)'
    try {
      const parsed = new URL(url.trim())
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return '服务地址必须是 http(s) 链接'
      }
    } catch {
      return '服务地址(url)不是合法链接'
    }
    if (raw.headers !== undefined) {
      if (!isPlainRecord(raw.headers)) return 'headers 必须是对象'
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v !== 'string') return `headers.${k} 的值必须是字符串`
      }
    }
    return null
  }
  const command = raw.command
  if (typeof command !== 'string' || !command.trim()) return '缺少启动命令(command)'
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
      return 'args 必须是字符串数组'
    }
  }
  if (raw.env !== undefined) {
    if (!isPlainRecord(raw.env)) return 'env 必须是对象'
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v !== 'string') return `env.${k} 的值必须是字符串`
    }
  }
  return null
}

export function asMcpConfig(transport: McpTransport, raw: unknown): McpConnectorConfig {
  const invalid = validateMcpConfig(transport, raw)
  if (invalid) throw new Error(invalid)
  return raw as McpConnectorConfig
}

// ── 手动添加:粘贴 JSON 解析(兼容业界 mcpServers 同型,WorkBuddy/Claude/Cursor 直贴) ──

export interface ParsedManualConnector {
  name: string
  transport: McpTransport
  config: McpConnectorConfig
}

/** 单个 server spec → 连接器;type 字段兼容 'http'/'streamable-http'/'sse'(统一走 http 传输,
 *  纯 SSE 端点由 http 传输的 SSE 回退兜住) */
function parseServerSpec(name: string, spec: unknown): ParsedManualConnector {
  if (!isPlainRecord(spec)) throw new Error(`「${name}」的配置不是 JSON 对象`)
  const declaredType = typeof spec.type === 'string' ? spec.type.toLowerCase() : ''
  if (typeof spec.url === 'string') {
    const config = asMcpConfig('http', spec)
    return { name, transport: 'http', config }
  }
  if (typeof spec.command === 'string') {
    const config = asMcpConfig('stdio', spec)
    return { name, transport: 'stdio', config }
  }
  throw new Error(
    `「${name}」缺服务地址(url)或启动命令(command)${declaredType ? `(声明了 type=${declaredType})` : ''}`
  )
}

/** 解析手动粘贴的 JSON:支持 {mcpServers:{名:spec}}(业界同型)或单个 spec 对象 */
export function parseManualMcpJson(text: string): ParsedManualConnector[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('粘贴的内容不是合法 JSON')
  }
  if (!isPlainRecord(data)) throw new Error('粘贴的内容必须是 JSON 对象')
  if (isPlainRecord(data.mcpServers)) {
    const entries = Object.entries(data.mcpServers)
    if (entries.length === 0) throw new Error('mcpServers 里没有任何连接器')
    return entries.map(([name, spec]) => parseServerSpec(name, spec))
  }
  // 单 spec 直贴:{url:...} 或 {command:...};名字没有来源,取主机名/命令名
  if (typeof data.url === 'string' || typeof data.command === 'string') {
    const fallback =
      typeof data.url === 'string'
        ? safeHost(data.url)
        : String(data.command).split(/[\\/]/).pop() || 'connector'
    return [parseServerSpec(fallback || 'connector', data)]
  }
  throw new Error('没认出连接器配置:需要 {mcpServers:{…}} 或 {url:…}/{command:…}')
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/[^\w.-]/g, '') || 'connector'
  } catch {
    return 'connector'
  }
}

// ── 工具名转译 ─────────────────────────────────────────────────────────────

/** 连接器名 → slug([a-z0-9_],中文等转下划线;全不可用字符则取短哈希,保稳定可复现) */
export function mcpSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
    .replace(/_+$/g, '')
  if (base) return base
  return `sv_${createHash('sha1').update(name).digest('hex').slice(0, 8)}`
}

/** 给一组连接器分配全局唯一 slug(撞名加序号):转译表构建期一次性算好 */
export function assignSlugs(connectors: { id: string; name: string }[]): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()
  for (const c of connectors) {
    const base = mcpSlug(c.name) || 'sv'
    let slug = base
    let n = 2
    while (used.has(slug)) {
      slug = `${base}_${n}`
      n += 1
    }
    used.add(slug)
    out.set(c.id, slug)
  }
  return out
}

/** 工具原名的合法化:合法字符保留;非法字符逐个转「_+码位36进制」保唯一
 *  (整串转下划线会让不同中文名互相撞成同一个 'tool') */
function sanitizeToolPart(tool: string): string {
  const out = tool.replace(/[^A-Za-z0-9_-]/g, (ch) => `_${ch.charCodeAt(0).toString(36)}`)
  return out || 'tool'
}

/** 转译:连接器 slug + 服务方工具名 → 模型可见名(OpenAI function name ≤64 字符) */
export function mcpToolName(slug: string, tool: string): string {
  const full = `${MCP_TOOL_PREFIX}${slug}__${sanitizeToolPart(tool)}`
  return full.length <= 64 ? full : full.slice(0, 64)
}

/** 反解前缀判定(不含注册表;精确分发走 mcp-manager 的注册表) */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX)
}

// ── env 白名单(stdio 子进程不透传全量环境) ────────────────────────────────

const ENV_ALLOW = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'USERPROFILE',
  'SYSTEMROOT',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES'
])

/** 组装子进程 env:白名单系统变量 + 配置的 env 覆盖(如 AMAP_MAPS_API_KEY) */
export function buildStdioEnv(custom: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ENV_ALLOW) {
    const v = process.env[key]
    if (v !== undefined) out[key] = v
  }
  if (custom) {
    for (const [k, v] of Object.entries(custom)) {
      if (v !== undefined) out[k] = v
    }
  }
  return out
}

// ── Windows stdio 专项:.cmd/.bat 必须 shell 方式跑(Node ≥18.20 硬限制) ────

/** 是否需要 cmd /c 包装:仅 Windows;除 .cmd/.bat 后缀外,裸 npx/npm 等包管理器命令
 *  在 Windows 上实际是 npx.cmd,spawn 直跑同样报 EINVAL,一并包装(纯函数,单测打 win 分支) */
export function stdioNeedsCmdWrap(command: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  const c = command.trim()
  if (/\.(cmd|bat)$/i.test(c)) return true
  const base = (c.split(/[\\/]/).pop() ?? '').toLowerCase()
  return ['npx', 'npm', 'pnpm', 'yarn', 'bunx'].includes(base)
}

/** 实际 spawn 的 command/args:Windows 上 npx → cmd /c npx …(纯函数,单测可打 win 分支) */
export function effectiveStdioCommand(
  command: string,
  args: string[] | undefined,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  const rest = args ?? []
  if (stdioNeedsCmdWrap(command, platform)) {
    return { command: 'cmd', args: ['/c', command.trim(), ...rest] }
  }
  return { command: command.trim(), args: rest }
}

// ── 错误人话(进 tool result,居民世界文本,中文不翻) ─────────────────────

/** 把 MCP 调用/连接异常翻译成居民能看懂、能转述岛主的一句话 */
export function mcpErrorText(connectorName: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const msg = raw.toLowerCase()
  const name = `「${connectorName}」`
  if (/401|unauthorized|invalid[_ ]?(token|key|api)|authentication/i.test(msg)) {
    return `${name}说钥匙不对(401):岛主可能需要在技能中心重新配置这个服务的 Key 或令牌。`
  }
  if (/403|forbidden|permission/i.test(msg)) {
    return `${name}拒绝了这次请求(403):账号可能没有开通对应权限,岛主可以到服务方后台看看。`
  }
  if (/429|rate.?limit|too many/i.test(msg)) {
    return `${name}限流了(429):调用太频繁,稍等一会儿再试。`
  }
  if (/timed? ?out|etimedout|esockettimedout/i.test(msg)) {
    return `${name}半天没响应(超时):服务可能临时不可用,稍后再试。`
  }
  if (/abort/i.test(msg)) {
    return `${name}的这次调用被中止(回合停止)。`
  }
  if (/econnrefused|enotfound|econnreset|fetch failed|network|socket hang up|getaddrinfo/i.test(msg)) {
    return `${name}连不上(网络问题):检查电脑能否上网;服务方故障就稍后再试。`
  }
  return `${name}调用出错:${raw}`
}

// ── 预算截断(每居民 MCP schema 总预算,超了按连接器整组降级,拍板点⑨) ─────

export interface BudgetGroup {
  connectorId: string
  name: string
  /** 该连接器全部工具的 schema 字符总量(描述+参数) */
  chars: number
}

export interface BudgetPlan {
  included: Set<string>
  omitted: { connectorId: string; name: string }[]
}

/** 贪心装箱:按传入顺序整组装入,装不下的整组省略(不拆半套工具,免得居民看见半只手) */
export function planSchemaBudget(groups: BudgetGroup[], budget = MCP_SCHEMA_BUDGET_CHARS): BudgetPlan {
  const included = new Set<string>()
  const omitted: { connectorId: string; name: string }[] = []
  let used = 0
  for (const g of groups) {
    if (used + g.chars <= budget) {
      included.add(g.connectorId)
      used += g.chars
    } else {
      omitted.push({ connectorId: g.connectorId, name: g.name })
    }
  }
  return { included, omitted }
}

// ── 目录模板占位符(config_template:密钥只留中文占位,占位名即安装输入框标签) ──

const PLACEHOLDER_RE = /\{\{([^{}]+)\}\}/g

/** 提取模板里的占位符名(去重保序):'{{高德 Key}}' → '高德 Key' */
export function templatePlaceholders(template: string): string[] {
  const out: string[] = []
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const name = m[1]!.trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** 用岛主填的值替换占位符;缺值原样保留(校验层会拦) */
export function applyTemplatePlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (whole, name: string) => {
    const v = values[name.trim()]
    return v === undefined || v === '' ? whole : v
  })
}

const SECRET_QUERY_RE = /^(key|token|access[_-]?token|api[_-]?key|secret)$/i

/** 展示用打码:headers 值/env 值/URL 里的 key|token 类 query 参数,长值留头 4 字符 */
export function maskConfigForDisplay(configJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(configJson)
  } catch {
    return configJson
  }
  const mask = (v: string): string =>
    v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-2)}`
  const walk = (node: unknown): unknown => {
    if (!isPlainRecord(node)) return node
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        out[k] = maskIfSecret(k, v)
      } else if (isPlainRecord(v)) {
        // headers/env 整个对象里的值都按密钥对待
        const sub: Record<string, unknown> = {}
        for (const [sk, sv] of Object.entries(v)) {
          sub[sk] = typeof sv === 'string' ? mask(sv) : sv
        }
        out[k] = sub
      } else {
        out[k] = v
      }
    }
    return out
  }
  const maskIfSecret = (k: string, v: string): string => {
    if (SECRET_QUERY_RE.test(k)) return mask(v)
    // URL 里 ?key=xxx&token=yyy 的打码
    if (/^https?:/i.test(v)) {
      try {
        const u = new URL(v)
        let changed = false
        for (const [qk, qv] of Array.from(u.searchParams.entries())) {
          if (SECRET_QUERY_RE.test(qk) && qv) {
            u.searchParams.set(qk, mask(qv))
            changed = true
          }
        }
        return changed ? u.toString() : v
      } catch {
        return v
      }
    }
    return v
  }
  return JSON.stringify(walk(parsed), null, 2)
}

// ── 结果截断 ───────────────────────────────────────────────────────────────

/** 工具结果字符截断(尾部注明,居民知道被截了不是漏了) */
export function truncateMcpResult(text: string, max = MCP_RESULT_MAX_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[内容过长,已截断。原结果约 ${text.length} 字符;需要后半部分就让居民分次调用、缩小查询范围。]`
}

/** MCP callTool 返回的 content 数组 → 纯文本(v1 只取 text 段,其余占位说明) */
export function contentBlocksToText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (!isPlainRecord(b)) continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') parts.push('[该工具返回了图片内容,本版本暂不展示]')
    else if (b.type === 'resource') parts.push('[该工具返回了资源内容,本版本暂不展示]')
  }
  return parts.join('\n')
}

/** isError 标记的调用结果:正文前加人话前缀(服务方业务报错,不是连接故障) */
export function wrapToolErrorText(text: string): string {
  const t = text.trim()
  if (!t) return '该服务返回了一个空错误。'
  return `服务方返回了错误:${t}`
}
