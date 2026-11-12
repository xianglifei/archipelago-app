// 正文本机路径 autolink 扫描纯函数断言(2026-11-06 方案 A):
// 家目录形态识别/句读剥离/前缀守卫/防误伤,与选区「打开」的整段判定
import { describe, expect, it } from 'vitest'
import { isLocalPathText, resolveWorkspacePath, scanLocalPathSpans } from '../../src/shared/md-autolink-core'

describe('scanLocalPathSpans(家目录形态识别)', () => {
  it('中文句子里段的 /Users 路径完整识别(群岛真实形态)', () => {
    const text = '报告已存好:/Users/felix/群岛/Vivi-c82f48/open-issues-2026-11-06.md,请查收。'
    const spans = scanLocalPathSpans(text)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.path).toBe('/Users/felix/群岛/Vivi-c82f48/open-issues-2026-11-06.md')
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe(spans[0]!.path)
  })

  it('句末中文句读(。,」等)不属于路径,从尾部剥掉', () => {
    expect(scanLocalPathSpans('见/Users/a/b/c.md。')[0]!.path).toBe('/Users/a/b/c.md')
    expect(scanLocalPathSpans('见~/群岛/x.md,')[0]!.path).toBe('~/群岛/x.md')
    expect(scanLocalPathSpans('详见(/Users/a/b.md)后续')[0]!.path).toBe('/Users/a/b.md')
  })

  it('路径在行首/行中/多段混合都能扫出', () => {
    expect(scanLocalPathSpans('/Users/a/b.md')[0]!.path).toBe('/Users/a/b.md')
    const two = scanLocalPathSpans('从/Users/a/x.md 换到/Users/b/y.md 结束')
    expect(two.map((s) => s.path)).toEqual(['/Users/a/x.md', '/Users/b/y.md'])
  })

  it('~/ 家目录形态认(含中文用户名)', () => {
    expect(scanLocalPathSpans('备份在~/群岛/Momo-3f2a/日记.md')[0]!.path).toBe('~/群岛/Momo-3f2a/日记.md')
    expect(scanLocalPathSpans('用户/Users/费利克斯/群岛/a.md')[0]!.path).toBe('/Users/费利克斯/群岛/a.md')
  })

  it('防误伤:裸基座/日期/分数都不认', () => {
    // 裸 /Users/<名> 没有后续段
    expect(scanLocalPathSpans('目录是/Users/felix')).toEqual([])
    // 前一个字符是路径字符 → 中段不接
    expect(scanLocalPathSpans('xx/Users/a/b.md')).toEqual([])
    expect(scanLocalPathSpans('//Users/a/b.md')).toEqual([])
    // 日期与分数(无 .md 后缀)
    expect(scanLocalPathSpans('日期 2026/11/06 与 3/4')).toEqual([])
    expect(scanLocalPathSpans('~ 单字符不算')).toEqual([])
  })

  it('带空格的路径按 v1 口径截断到空格前(诚实降级:点击得「文件已不在原位」)', () => {
    const spans = scanLocalPathSpans('文件在/Users/a/my file.md 里')
    expect(spans[0]!.path).toBe('/Users/a/my')
  })

  it('句读后紧跟汉字时在句读处截断,中文尾巴不混入路径', () => {
    // 逗号后继续说话:路径止于 .md,「请查收」不进路径
    expect(scanLocalPathSpans('已存/Users/a/b.md,请查收')[0]!.path).toBe('/Users/a/b.md')
    // 基座后直接逗号+汉字:截完只剩裸基座,整条拒绝(不产出垃圾链接)
    expect(scanLocalPathSpans('目录是/Users/felix,里面都是文件')).toEqual([])
  })
})

describe('后缀规则(.md 结尾 + 含 /,2026-11-06 走查反馈补)', () => {
  it('Felix 走查原话:工作区相对路径完整识别,括号尾巴不吞', () => {
    const text = '文件:产出/内圣外王与外圣内王_2026-11-06.md(约 920 字符)'
    const spans = scanLocalPathSpans(text)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.path).toBe('产出/内圣外王与外圣内王_2026-11-06.md')
    expect(spans[0]!.relative).toBe(true)
  })

  it('任意绝对路径也认(/tmp 等,此前缀规则不覆盖的形态;空格分隔最干净)', () => {
    const s = scanLocalPathSpans('存在 /tmp/notes/草稿.md 里')[0]!
    expect(s.path).toBe('/tmp/notes/草稿.md')
    expect(s.relative).toBe(false)
  })

  it('中文贴在绝对标记前(见/Users/…、备份在~/…)从标记处裁齐,句子前缀不进路径', () => {
    expect(scanLocalPathSpans('见/Users/a/b/c.md。')[0]!.path).toBe('/Users/a/b/c.md')
    expect(scanLocalPathSpans('备份在~/群岛/Momo-3f2a/日记.md')[0]!.path).toBe('~/群岛/Momo-3f2a/日记.md')
    // 中文贴在非家目录绝对路径前(存在/tmp/…):词法上与真相对路径(产出/x.md)不可区分,
    // 按相对处理交工作区解析,点开得到诚实的「文件已不在原位」
    const glued = scanLocalPathSpans('存在/tmp/notes/草稿.md')[0]!
    expect(glued.path).toBe('存在/tmp/notes/草稿.md')
    expect(glued.relative).toBe(true)
  })

  it('URL 不误伤:https://…/readme.md 不产链接(冒号守卫)', () => {
    expect(scanLocalPathSpans('详见 https://example.com/docs/readme.md 文档')).toEqual([])
    expect(scanLocalPathSpans('详见https://example.com/docs/readme.md')).toEqual([])
  })

  it('裸文件名(无 /)不认;.mdx 不认', () => {
    expect(scanLocalPathSpans('把文件改成报告.md 即可')).toEqual([])
    expect(scanLocalPathSpans('见产出/notes.mdx 附录')).toEqual([])
  })

  it('markdown 后缀大小写不敏感', () => {
    expect(scanLocalPathSpans('产出/Report.MD 已存')[0]!.path).toBe('产出/Report.MD')
  })
})

describe('resolveWorkspacePath(相对路径按工作区解析)', () => {
  it('相对路径拼基准;绝对/~ 形态原样;无基准 null', () => {
    expect(resolveWorkspacePath('/Users/f/群岛/Vivi-3f2a', '产出/x.md')).toBe(
      '/Users/f/群岛/Vivi-3f2a/产出/x.md'
    )
    expect(resolveWorkspacePath('/Users/f/群岛/Vivi-3f2a/', '产出/x.md')).toBe(
      '/Users/f/群岛/Vivi-3f2a/产出/x.md'
    )
    expect(resolveWorkspacePath(null, '产出/x.md')).toBeNull()
    expect(resolveWorkspacePath(null, '/Users/a/b.md')).toBe('/Users/a/b.md')
    expect(resolveWorkspacePath('/Users/f/群岛/V', '~/x.md')).toBe('~/x.md')
  })
})

describe('isLocalPathText(选区「打开」的整段判定)', () => {
  it('整段恰好是路径 → 返回路径', () => {
    expect(isLocalPathText('/Users/felix/群岛/a.md')).toBe('/Users/felix/群岛/a.md')
    expect(isLocalPathText(' ~/群岛/b.md ')).toBe('~/群岛/b.md')
  })

  it('混有其他文字/多段/无斜杠 → null(前缀后缀多一个字都不算)', () => {
    expect(isLocalPathText('路径是/Users/a/b.md')).toBeNull()
    expect(isLocalPathText('/Users/a/b.md。')).toBeNull()
    expect(isLocalPathText('报告.md')).toBeNull()
    expect(isLocalPathText('')).toBeNull()
    expect(isLocalPathText('普通选中文本')).toBeNull()
  })

  it('相对路径整段选中也是路径(选区「打开」交由调用方按工作区解析)', () => {
    expect(isLocalPathText('产出/内圣外王_2026-11-06.md')).toBe('产出/内圣外王_2026-11-06.md')
    expect(isLocalPathText('/tmp/x.md')).toBe('/tmp/x.md')
  })
})
