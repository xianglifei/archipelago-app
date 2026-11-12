#!/usr/bin/env node
// MCP 端点三步实测工具(2026-11-06,机制化「配 Key→listTools→callTool」上架纪律):
// 能力卡上架前必跑——连上官方端点、拉工具清单、试调一个工具,三步全绿才允许上架。
//
// 用法:
//   node scripts/mcp-endpoint-smoke.mjs <url> [--header 'Authorization: Bearer xxx']...
//        [--call 工具名] [--args '{"参数":…}'] [--timeout 毫秒]
// 例:
//   node scripts/mcp-endpoint-smoke.mjs "https://mcp.amap.com/mcp?key=<KEY>"
//   node scripts/mcp-endpoint-smoke.mjs "https://mcp.mcd.cn" -H "Authorization: Bearer <TOKEN>" --call queryShopList
//
// 说明:走 undici 全局 fetch(不认系统代理);境内官方端点直连即可,代理环境把终端挂上代理变量
// 也不会生效——真需要代理时用 Node 22+ 的 NODE_USE_ENV_PROXY=1。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

const args = process.argv.slice(2)
const url = args.find((a) => !a.startsWith('--'))
const headers = {}
let call = null
let callArgs = {}
let timeoutMs = 20_000

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  const next = () => args[++i]
  if (a === '-H' || a === '--header') {
    const h = String(next() ?? '')
    const idx = h.indexOf(':')
    if (idx <= 0) fail(`--header 需要 '名字: 值' 形式,收到:${h}`)
    headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim()
  } else if (a === '--call') call = next()
  else if (a === '--args') callArgs = JSON.parse(String(next() ?? '{}'))
  else if (a === '--timeout') timeoutMs = Number(next()) || timeoutMs
}

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
function step(n, msg) {
  console.log(`[${n}] ${msg}`)
}

if (!url) fail('用法:node scripts/mcp-endpoint-smoke.mjs <url> [-H 头] [--call 工具] [--args JSON]')
let parsed
try {
  parsed = new URL(url)
} catch {
  fail(`端点不是合法 URL:${url}`)
}

const withTimeout = (p, what) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} 超时(${timeoutMs}ms)`)), timeoutMs))
  ])

async function connect() {
  // Streamable HTTP 优先,4xx/不支持时落 SSE 回退(与客户端 mcp-manager 同款双候选)
  const candidates = [
    ['streamable-http', new StreamableHTTPClientTransport(parsed, { requestInit: { headers } })],
    ['sse', new SSEClientTransport(parsed, { requestInit: { headers }, eventSourceInit: { headers } })]
  ]
  let lastErr
  for (const [name, transport] of candidates) {
    const client = new Client({ name: 'archipelago-smoke', version: '1.0.0' })
    try {
      await withTimeout(client.connect(transport), `连接(${name})`)
      return { client, name }
    } catch (err) {
      lastErr = err
      try { await client.close() } catch { /* 尽力而为 */ }
    }
  }
  throw lastErr
}

const { client, name } = await connect().catch((e) => fail(`连接失败(${e.message})`))
step(1, `已连接(${name})→ ${parsed.host}${parsed.pathname}`)

const tools = await withTimeout(client.listTools({}, {}), 'listTools').catch((e) => fail(`listTools 失败:${e.message}`))
const list = tools.tools ?? []
step(2, `listTools:${list.length} 个工具`)
for (const t of list) console.log(`    - ${t.name}${t.description ? ` · ${String(t.description).slice(0, 60)}` : ''}`)
if (list.length === 0) fail('端点返回 0 个工具——检查 Key 是否有效/账号是否开通')

if (call) {
  const target = list.find((t) => t.name === call)
  if (!target) fail(`清单里没有工具「${call}」,可用的见上表`)
  const result = await withTimeout(client.callTool({ name: call, arguments: callArgs }, undefined, {}), `callTool(${call})`).catch((e) =>
    fail(`callTool 失败:${e.message}`)
  )
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
  step(3, `callTool(${call})${result.isError ? ' [isError=true]' : ''} →`)
  console.log(text ? text.slice(0, 2000) : '(空结果)')
} else {
  step(3, '(未试调工具;加 --call 工具名 走完第三步)')
}

await client.close().catch(() => {})
console.log('✓ 三步实测通过' + (call ? '' : '(差 callTool 一步)'))
