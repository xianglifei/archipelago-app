import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error website/invite-landing.js 是纯 JS Worker,无类型声明(tsconfig.test 未开 allowJs)
import landing from '../../website/invite-landing'

// B6 回归(2026-11-12 终审发现):sea 非 2xx(5xx/网关错误)此前会静默落到「已过期」对用户说谎;
// 修复后任何非 ok/异常/畸形 JSON 都走「服务暂不可用」诚实态。sea 对无效码/过期码的预期应答是
// 200+found:false(cloud/src/post.ts /post/invites/landing),非 ok 全部不是预期路径。
const FOUND_BODY = JSON.stringify({
  ok: true,
  data: { found: true, code: 'ABC234', expires_at: Date.now() + 86_400_000, islandName: '海岸岛', ownerName: '阿青' },
})

function jsonResponse(status: number, body: string) {
  return new Response(body, { status })
}

describe('invite-landing Worker 五态', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('有效码:渲染岛主名/邀请码/复制按钮', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, FOUND_BODY)))
    const out = await landing.fetch(new Request('https://qundao.app/i/ABC234'))
    const html = await out.text()
    expect(out.status).toBe(200)
    expect(html).toContain('海岸岛')
    expect(html).toContain('岛主 阿青')
    expect(html).toContain('复制邀请码')
  })

  it('200 但 found:false(无效/过期码):显「邀请函已过期」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, JSON.stringify({ ok: true, data: { found: false } }))))
    const html = await (await landing.fetch(new Request('https://qundao.app/i/ABC234'))).text()
    expect(html).toContain('邀请函已过期')
    expect(html).not.toContain('复制邀请码')
  })

  it('B6 核心:sea 5xx 显「邀请页暂时打不开」,不再冒充「已过期」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(502, 'bad gateway')))
    const html = await (await landing.fetch(new Request('https://qundao.app/i/ABC234'))).text()
    expect(html).toContain('邀请页暂时打不开')
    expect(html).not.toContain('邀请函已过期')
  })

  it('网络异常/超时(fetch 抛错):显「邀请页暂时打不开」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('synthetic network failure')
    }))
    const html = await (await landing.fetch(new Request('https://qundao.app/i/ABC234'))).text()
    expect(html).toContain('邀请页暂时打不开')
    expect(html).not.toContain('邀请函已过期')
  })

  it('200 但响应体非合法 JSON(畸形响应):显「邀请页暂时打不开」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, '<html>gateway page</html>')))
    const html = await (await landing.fetch(new Request('https://qundao.app/i/ABC234'))).text()
    expect(html).toContain('邀请页暂时打不开')
    expect(html).not.toContain('邀请函已过期')
  })

  it('非 /i/<code> 路径:404 交还 static assets 管线', async () => {
    const out = await landing.fetch(new Request('https://qundao.app/download'))
    expect(out.status).toBe(404)
  })
})
