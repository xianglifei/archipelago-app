import { describe, expect, it } from 'vitest'
import {
  MCP_TOOL_PREFIX,
  applyTemplatePlaceholders,
  assignSlugs,
  buildStdioEnv,
  contentBlocksToText,
  effectiveStdioCommand,
  isMcpToolName,
  mcpErrorText,
  mcpSlug,
  mcpToolName,
  maskConfigForDisplay,
  parseManualMcpJson,
  planSchemaBudget,
  stdioNeedsCmdWrap,
  templatePlaceholders,
  truncateMcpResult,
  validateMcpConfig,
  wrapToolErrorText
} from '../../src/main/mcp-core'

describe('validateMcpConfig', () => {
  it('http:缺 url/非法 url/坏 headers 都给出人话错误', () => {
    expect(validateMcpConfig('http', {})).toContain('url')
    expect(validateMcpConfig('http', { url: 'not a url' })).toContain('合法')
    expect(validateMcpConfig('http', { url: 'ftp://x.com' })).toContain('http(s)')
    expect(validateMcpConfig('http', { url: 'https://a.com', headers: { A: 1 } })).toContain('headers.A')
  })
  it('http:合法配置返回 null,headers 缺省可', () => {
    expect(validateMcpConfig('http', { url: 'https://mcp.amap.com/mcp?key=k' })).toBeNull()
    expect(validateMcpConfig('http', { url: 'https://a.com', headers: { Authorization: 'Bearer x' } })).toBeNull()
  })
  it('stdio:缺 command/坏 args/坏 env 都给出人话错误', () => {
    expect(validateMcpConfig('stdio', {})).toContain('command')
    expect(validateMcpConfig('stdio', { command: 'npx', args: [1] })).toContain('args')
    expect(validateMcpConfig('stdio', { command: 'npx', env: { K: 2 } })).toContain('env.K')
  })
  it('stdio:合法配置返回 null', () => {
    expect(validateMcpConfig('stdio', { command: 'npx', args: ['-y', '@amap/amap-maps-mcp-server'], env: { K: 'v' } })).toBeNull()
  })
})

describe('parseManualMcpJson', () => {
  it('解析 WorkBuddy 同型 mcpServers 配置', () => {
    const out = parseManualMcpJson(
      '{"mcpServers":{"ima-mcp":{"url":"https://ima.qq.com/mcp","type":"streamable-http"}}}'
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('ima-mcp')
    expect(out[0]!.transport).toBe('http')
  })
  it('stdio spec 解析为 stdio 传输', () => {
    const out = parseManualMcpJson(
      '{"mcpServers":{"amap":{"command":"npx","args":["-y","@amap/amap-maps-mcp-server"],"env":{"AMAP_MAPS_API_KEY":"k"}}}}'
    )
    expect(out[0]!.transport).toBe('stdio')
  })
  it('单 spec 直贴(无 mcpServers 包裹)可解析,名字取主机名', () => {
    const out = parseManualMcpJson('{"url":"https://gwmcp.lkcoffee.com/order/user/mcp"}')
    expect(out[0]!.name).toBe('gwmcp.lkcoffee.com')
  })
  it('非法 JSON/空 mcpServers/两不沾 spec 都报人话', () => {
    expect(() => parseManualMcpJson('{oops')).toThrow('JSON')
    expect(() => parseManualMcpJson('{"mcpServers":{}}')).toThrow('没有')
    expect(() => parseManualMcpJson('{"mcpServers":{"x":{"type":"http"}}}')).toThrow('url')
  })
})

describe('工具名转译', () => {
  it('中文名 slug 走短哈希且稳定;英文名直接可用', () => {
    expect(mcpSlug('瑞幸咖啡')).toBe(mcpSlug('瑞幸咖啡'))
    expect(mcpSlug('瑞幸咖啡')).toMatch(/^sv_[0-9a-f]{8}$/)
    expect(mcpSlug('didi-mcp')).toBe('didi_mcp')
  })
  it('assignSlugs 撞名加序号', () => {
    const map = assignSlugs([
      { id: 'a', name: 'My MCP' },
      { id: 'b', name: 'my_mcp' }
    ])
    expect(map.get('a')).toBe('my_mcp')
    expect(map.get('b')).toBe('my_mcp_2')
  })
  it('mcpToolName 加前缀、非法字符转码位保唯一、64 截断', () => {
    expect(mcpToolName('didi', 'taxi_create_order')).toBe(`${MCP_TOOL_PREFIX}didi__taxi_create_order`)
    const weird = mcpToolName('x', '怪 名/字')
    expect(weird.startsWith(`${MCP_TOOL_PREFIX}x__`)).toBe(true)
    expect(weird.slice(MCP_TOOL_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(weird).not.toBe(mcpToolName('x', '怪 名')) // 不同的名字不撞车
    const long = mcpToolName('s', 't'.repeat(80))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(isMcpToolName(long)).toBe(true)
    expect(isMcpToolName('write_file')).toBe(false)
  })
})

describe('buildStdioEnv', () => {
  it('白名单+覆盖,不透传任意进程变量', () => {
    process.env.MCP_TEST_LEAK = 'leak'
    const env = buildStdioEnv({ AMAP_MAPS_API_KEY: 'k1' })
    expect(env['AMAP_MAPS_API_KEY']).toBe('k1')
    expect(env['MCP_TEST_LEAK']).toBeUndefined()
    expect('PATH' in env || 'USERPROFILE' in env || 'HOME' in env).toBe(true)
    delete process.env.MCP_TEST_LEAK
  })
})

describe('Windows stdio 包装', () => {
  it('mac 上永不包装', () => {
    expect(stdioNeedsCmdWrap('npx.cmd', 'darwin')).toBe(false)
    expect(effectiveStdioCommand('npx', ['-y', 'x'], 'darwin')).toEqual({ command: 'npx', args: ['-y', 'x'] })
  })
  it('win:.cmd 后缀与裸 npx 都要 cmd /c', () => {
    expect(stdioNeedsCmdWrap('npx', 'win32')).toBe(true)
    expect(stdioNeedsCmdWrap('npx.cmd', 'win32')).toBe(true)
    expect(stdioNeedsCmdWrap('node', 'win32')).toBe(false)
    expect(effectiveStdioCommand('npx', ['-y', 'pkg'], 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'pkg']
    })
  })
})

describe('mcpErrorText', () => {
  it('401/429/网络/通用各有人话', () => {
    expect(mcpErrorText('瑞幸咖啡', new Error('Request failed with status code 401'))).toContain('钥匙不对')
    expect(mcpErrorText('麦当劳', new Error('429 rate limit exceeded'))).toContain('限流')
    expect(mcpErrorText('高德', new Error('fetch failed'))).toContain('连不上')
    expect(mcpErrorText('某服务', new Error('weird failure'))).toContain('weird failure')
  })
})

describe('planSchemaBudget', () => {
  const g = (id: string, chars: number, name = id) => ({ connectorId: id, name, chars })
  it('预算内全装;超了整组省略不拆半', () => {
    const plan = planSchemaBudget([g('a', 10_000), g('b', 10_000), g('c', 10_000)], 24_000)
    expect(plan.included.has('a')).toBe(true)
    expect(plan.included.has('b')).toBe(true)
    expect(plan.included.has('c')).toBe(false)
    expect(plan.omitted).toEqual([{ connectorId: 'c', name: 'c' }])
  })
  it('恰好装满的边界', () => {
    const plan = planSchemaBudget([g('a', 12_000), g('b', 12_000)], 24_000)
    expect(plan.omitted).toHaveLength(0)
    expect(plan.included.size).toBe(2)
  })
})

describe('模板占位符', () => {
  it('提取与替换', () => {
    const t = '{"url":"https://mcp.amap.com/mcp?key={{高德 Key}}","headers":{"Authorization":"Bearer {{麦当劳 Token}}"}}'
    expect(templatePlaceholders(t)).toEqual(['高德 Key', '麦当劳 Token'])
    const applied = applyTemplatePlaceholders(t, { '高德 Key': 'k123' })
    expect(applied).toContain('key=k123')
    expect(applied).toContain('{{麦当劳 Token}}')
  })
})

describe('maskConfigForDisplay', () => {
  it('URL 密钥参数与 headers 值打码,普通 query 不动', () => {
    const masked = maskConfigForDisplay(
      '{"url":"https://mcp.amap.com/mcp?key=abcdef123456&format=0","headers":{"Authorization":"Bearer sk-1234567890"}}'
    )
    expect(masked).not.toContain('abcdef123456')
    expect(masked).not.toContain('sk-1234567890')
    expect(masked).toContain('format=0')
    expect(masked).toContain('https://mcp.amap.com/mcp')
  })
})

describe('结果处理', () => {
  it('超长截断带说明', () => {
    const out = truncateMcpResult('x'.repeat(25_000))
    expect(out.length).toBeLessThan(21_000)
    expect(out).toContain('已截断')
    expect(truncateMcpResult('short')).toBe('short')
  })
  it('content 数组只取 text 段,图片/资源占位', () => {
    expect(contentBlocksToText([{ type: 'text', text: '杭州 晴' }, { type: 'image', data: 'xx' }])).toContain('杭州 晴')
    expect(contentBlocksToText([{ type: 'image' }])).toContain('暂不展示')
    expect(contentBlocksToText('直接字符串')).toBe('直接字符串')
  })
  it('isError 包装', () => {
    expect(wrapToolErrorText(' 参数缺失 ')).toContain('服务方返回了错误')
    expect(wrapToolErrorText('')).toContain('空错误')
  })
})
