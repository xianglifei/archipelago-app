// 内置 md 阅读器纯函数断言(2026-11-06 只读拍板):入口分流判定/读取边界/二进制嗅探/面包屑切段
import { describe, expect, it } from 'vitest'
import {
  crumbSegments,
  isMarkdownPath,
  looksBinary,
  MD_READER_TEXT_MAX_BYTES
} from '../../src/shared/md-reader-core'

describe('isMarkdownPath(入口分流与读取校验同源)', () => {
  it('.md / .markdown 认,大小写不敏感', () => {
    expect(isMarkdownPath('/Users/felix/群岛/Momo-3f2a/报告.md')).toBe(true)
    expect(isMarkdownPath('C:\\Users\\felix\\清单.MARKDOWN')).toBe(true)
    expect(isMarkdownPath('/tmp/notes.Md')).toBe(true)
  })

  it('易混后缀不认:mdx / markdowns / 无后缀 / 裸 .md 目录假名', () => {
    expect(isMarkdownPath('/tmp/a.mdx')).toBe(false)
    expect(isMarkdownPath('/tmp/a.markdowns')).toBe(false)
    expect(isMarkdownPath('/tmp/README')).toBe(false)
    expect(isMarkdownPath('/tmp/.md')).toBe(true) // 文件名叫 .md 也算 md(诚实口径:后缀即身份)
  })

  it('空串与目录路径', () => {
    expect(isMarkdownPath('')).toBe(false)
    expect(isMarkdownPath('/Users/felix/群岛/')).toBe(false)
  })
})

describe('looksBinary(NUL 嗅探)', () => {
  it('含 NUL 字节即二进制(UTF-8 文本任何合法内容都不出 \\0)', () => {
    expect(looksBinary(new Uint8Array([0x61, 0x00, 0x62]))).toBe(true)
  })

  it('纯文本(含中文 UTF-8 多字节)不是二进制', () => {
    const head = new TextEncoder().encode('# 群岛调研报告\n正文…')
    expect(looksBinary(head)).toBe(false)
  })

  it('空文件头不是二进制', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false)
  })
})

describe('crumbSegments(面包屑)', () => {
  it('unix 绝对路径切段,过滤空段', () => {
    expect(crumbSegments('/Users/felix/群岛/Momo-3f2a/报告.md')).toEqual([
      'Users',
      'felix',
      '群岛',
      'Momo-3f2a',
      '报告.md'
    ])
  })

  it('Windows 反斜杠路径同样切段', () => {
    expect(crumbSegments('C:\\Users\\felix\\清单.md')).toEqual(['C:', 'Users', 'felix', '清单.md'])
  })

  it('空串与裸根', () => {
    expect(crumbSegments('')).toEqual([])
    expect(crumbSegments('/')).toEqual([])
  })
})

describe('读取上限常量', () => {
  it('256KB(ZCode 同款口径),超限在主进程 stat 阶段即拦,不截断不降级', () => {
    expect(MD_READER_TEXT_MAX_BYTES).toBe(256 * 1024)
  })
})
