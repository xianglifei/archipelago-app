import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')

/** 官网三页(website/README.md:三页 header 导航共享同源口径,改导航须三页同步) */
const PAGES = ['index.html', 'download.html', 'whatsnew.html']

/**
 * 文档入口的源码契约(2026-11-13 需求):三页导航都在「新功能」与「下载」之间挂「文档」,
 * 点了跳去文档站。断言三页同构 + 相邻顺序 + 目标地址,防止以后只改一页,
 * 或把地址退回 docs.qundao.app 根路径(根路径是 301 → /docs,白吃一跳)。
 */
function pageNav(file: string): string {
  const html = readFileSync(join(ROOT, 'website', file), 'utf8')
  const m = html.match(/<nav class="site-page-nav"[\s\S]*?<\/nav>/)
  if (!m) throw new Error(`website/${file} 里找不到 header 导航(.site-page-nav)`)
  return m[0]
}

interface NavItem {
  label: string
  href: string
}

function navItems(nav: string): NavItem[] {
  return [...nav.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/g)].map((m) => ({
    href: m[1] ?? '',
    label: (m[2] ?? '').trim(),
  }))
}

describe('官网 header 导航:文档入口(静态契约)', () => {
  it.each(PAGES)('%s 的导航顺序是 首页 → 新功能 → 文档 → 下载', (file) => {
    const labels = navItems(pageNav(file)).map((i) => i.label)
    expect(labels).toEqual(['首页', '新功能', '文档', '下载'])
  })

  it.each(PAGES)('%s 的「文档」指向文档站文章首页,不绕 301', (file) => {
    const doc = navItems(pageNav(file)).find((i) => i.label === '文档')
    expect(doc?.href).toBe('https://docs.qundao.app/docs')
  })

  it.each(PAGES)('%s 的「文档」夹在「新功能」和「下载」之间', (file) => {
    const labels = navItems(pageNav(file)).map((i) => i.label)
    expect(labels.indexOf('文档')).toBe(labels.indexOf('新功能') + 1)
    expect(labels.indexOf('文档')).toBe(labels.indexOf('下载') - 1)
  })

  // 第四个入口把导航撑宽约 52px:320px 屏上「下载」原本会溢出约 15px(无头 Chrome 实测),
  // 收窄横向内边距后回到 320 内。设计稿重建(build_site.py)会抹掉这条,故用契约断言钉住。
  it.each(PAGES)('%s 保留 ≤340px 的窄屏导航内边距,第四个入口不会挤出屏', (file) => {
    const html = readFileSync(join(ROOT, 'website', file), 'utf8')
    expect(html).toContain('@media(max-width:340px){.site-page-nav a')
  })
})
