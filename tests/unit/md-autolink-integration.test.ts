// autolink 全链路集成断言(2026-11-06 走查二连反馈):scan 纯函数过≠渲染出链接——
// 用真实 react-markdown 管线(插件+urlTransform+MdLink)渲染断言 <a>,覆盖 Felix 两次走查原话形态。
// window.archipelago 桩:Markdown 链路 import 链上有 api 模块(模块级取 window.archipelago),node 环境须先挂桩。
import { vi, describe, expect, it } from 'vitest'

vi.hoisted(() => {
  const stub = {
    platform: 'darwin',
    on: () => () => undefined,
    openPath: () => Promise.resolve(''),
    mdReaderOpen: () => Promise.resolve(),
    filesReadText: () => Promise.resolve({ ok: false, reason: 'bad-path' })
  }
  ;(globalThis as Record<string, unknown>).window = { archipelago: stub }
})

import React from 'react'
const { renderToStaticMarkup } = await import('react-dom/server')
const { Markdown, WorkspaceBaseContext } = await import('../../src/renderer/src/components/markdown/Markdown')

const WS = '/Users/xianglifei/群岛/Cici-d269d2'

describe('autolink 真渲染管线(插件→urlTransform→MdLink)', () => {
  it('纯文本绝对路径(走查二连原话:行首+全角括号尾巴)渲染成可点链接', () => {
    const html = renderToStaticMarkup(
      React.createElement(Markdown, {
        content: '已存好：\n\n/Users/xianglifei/群岛/Cici-d269d2/reports/open-issues-20261106.md（7.5 KB，107 行）\n\n里面收了这些。'
      })
    )
    expect(html).toContain('<a')
    expect(html).toContain('/Users/xianglifei/群岛/Cici-d269d2/reports/open-issues-20261106.md')
  })

  it('中文句中相对路径(走查一原话)在有工作区基准时渲染成链接,title 给解析后绝对路径', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        WorkspaceBaseContext.Provider,
        { value: WS },
        React.createElement(Markdown, {
          content: '存好了。\n\n文件:产出/内圣外王与外圣内王_2026-11-06.md(约 920 字符)\n\n结构是按原话拆的。'
        })
      )
    )
    expect(html).toContain('<a')
    expect(html).toContain('产出/内圣外王与外圣内王_2026-11-06.md')
    expect(html).toContain(`title="${WS}/产出/内圣外王与外圣内王_2026-11-06.md"`)
  })

  it('相对路径无工作区基准(邮局信件等)还原纯文本,不产死链', () => {
    const html = renderToStaticMarkup(
      React.createElement(Markdown, { content: '文件:产出/报告.md 请查收' })
    )
    expect(html).not.toContain('<a')
  })

  it('反引号内联代码里的整段路径也渲染成可点链接(走查二连:居民惯用 `路径` 强调)', () => {
    const html = renderToStaticMarkup(
      React.createElement(Markdown, { content: '报告在 `/Users/a/群岛/b.md` 里。' })
    )
    expect(html).toContain('<a')
    expect(html).toContain('/Users/a/群岛/b.md')
    // 保持 code 视觉:链接内仍是 <code>
    expect(html).toContain('<code>')
  })

  it('代码块里的路径不产链接(块级代码=脚本语境,刻意不动)', () => {
    const html = renderToStaticMarkup(
      React.createElement(Markdown, { content: '```\n/Users/a/b/c.md\n```' })
    )
    expect(html).not.toContain('<a')
  })
})
