// 居民正文内嵌图 src 分流纯函数断言(2026-11-05):渲染层降级判定与主进程路径口径的共用底座
import { describe, expect, it } from 'vitest'
import { classifyMarkdownImageSrc, IMAGE_DISPLAY_MAX_BYTES } from '../../src/shared/markdown-image-core'

describe('classifyMarkdownImageSrc', () => {
  it('data: URL 直用', () => {
    expect(classifyMarkdownImageSrc('data:image/png;base64,AAA')).toEqual({ kind: 'data' })
  })

  it('http/https 一律 remote(CSP 不放行,降级链接)', () => {
    expect(classifyMarkdownImageSrc('https://example.com/a.png')).toEqual({ kind: 'remote' })
    expect(classifyMarkdownImageSrc('http://example.com/a.png')).toEqual({ kind: 'remote' })
  })

  it('unix 绝对路径 → local 原样', () => {
    expect(classifyMarkdownImageSrc('/Users/felix/群岛/岛屿档案/图.png')).toEqual({
      kind: 'local',
      path: '/Users/felix/群岛/岛屿档案/图.png'
    })
  })

  it('本地路径里的 URI 转义解码一次(markdown 链接常见 %20)', () => {
    expect(classifyMarkdownImageSrc('/Users/felix/My%20Files/a.png')).toEqual({
      kind: 'local',
      path: '/Users/felix/My Files/a.png'
    })
  })

  it('解码失败的路径原样保留,不抛错', () => {
    expect(classifyMarkdownImageSrc('/tmp/a%zz.png')).toEqual({ kind: 'local', path: '/tmp/a%zz.png' })
  })

  it('Windows 盘符路径(正反斜杠)→ local', () => {
    expect(classifyMarkdownImageSrc('C:\\Users\\felix\\a.png')).toEqual({
      kind: 'local',
      path: 'C:\\Users\\felix\\a.png'
    })
    expect(classifyMarkdownImageSrc('C:/Users/felix/a.png')).toEqual({ kind: 'local', path: 'C:/Users/felix/a.png' })
  })

  it('file:// URL 解码为 local 路径,含 Windows 盘符形式', () => {
    expect(classifyMarkdownImageSrc('file:///Users/felix/a%20b.png')).toEqual({
      kind: 'local',
      path: '/Users/felix/a b.png'
    })
    expect(classifyMarkdownImageSrc('file:///C:/Users/felix/a.png')).toEqual({
      kind: 'local',
      path: 'C:/Users/felix/a.png'
    })
  })

  it('file:// 带非 localhost 主机不认(网络路径不管)', () => {
    expect(classifyMarkdownImageSrc('file://nas/share/a.png')).toEqual({ kind: 'unsupported' })
  })

  it('~ 家目录前缀 → local(展开交给主进程)', () => {
    expect(classifyMarkdownImageSrc('~/Pictures/a.png')).toEqual({ kind: 'local', path: '~/Pictures/a.png' })
  })

  it('其余 scheme 与相对路径 unsupported(降级链接,不当本机文件)', () => {
    expect(classifyMarkdownImageSrc('mailto:a@b.c')).toEqual({ kind: 'unsupported' })
    expect(classifyMarkdownImageSrc('app://local/x.png')).toEqual({ kind: 'unsupported' })
    expect(classifyMarkdownImageSrc('charts/a.png')).toEqual({ kind: 'unsupported' })
    expect(classifyMarkdownImageSrc('./charts/a.png')).toEqual({ kind: 'unsupported' })
    expect(classifyMarkdownImageSrc('')).toEqual({ kind: 'unsupported' })
    expect(classifyMarkdownImageSrc('   ')).toEqual({ kind: 'unsupported' })
  })

  it('展示上限常量 = 8MB(与主进程 readImageForDisplay 共用)', () => {
    expect(IMAGE_DISPLAY_MAX_BYTES).toBe(8 * 1024 * 1024)
  })
})
