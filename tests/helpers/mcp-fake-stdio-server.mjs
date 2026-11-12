// MCP stdio 冒烟用假服务器(2026-11-06):echo 工具回显文本并回报 FAKE_KEY 环境变量,
// 用于验证 StdioClientTransport 真实子进程路径(spawn/env 白名单注入)。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'fake-stdio', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: '回声,并回报环境变量 FAKE_KEY 是否注入',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
    }
  ]
}))
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: `echo:${String(req.params.arguments?.text ?? '')} envKey=${process.env.FAKE_KEY ?? 'MISSING'}` }]
}))
await server.connect(new StdioServerTransport())
