import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')

/**
 * 渲染层 CSP 的源码契约静态断言。
 * 锚点:构建期 Vite 会把体积小的 KaTeX 字体内联成 `data:font/woff2;base64,...`
 * (out/renderer/assets/markdown-*.css),而 CSP 没写 font-src 时回落到 default-src 'self',
 * 生产包里这些字体被直接拦掉——dev 下字体走 URL 不触发,只有预览/打包才复现,属于典型「构建期才暴露」的缺口。
 * 因此 font-src 必须显式放行 'self' 与 data:。
 */
const PAGES = ['index.html', 'md-reader.html', 'img-viewer.html']

describe('渲染层 CSP 契约(静态)', () => {
  for (const page of PAGES) {
    it(`${page}: font-src 显式放行 'self' 与 data:(内联 KaTeX 字体不被拦)`, () => {
      const html = readFileSync(join(ROOT, 'src/renderer', page), 'utf8')
      const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)
      expect(m, `${page} 应有 CSP meta`).not.toBeNull()
      const csp = (m as RegExpMatchArray)[1]!
      const fontSrc = csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith('font-src'))
      expect(fontSrc, `${page} 缺 font-src,会回落到 default-src 拦掉 data: 字体`).toBeDefined()
      expect(fontSrc).toContain("'self'")
      expect(fontSrc).toContain('data:')
    })
  }
})
