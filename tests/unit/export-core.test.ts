import { describe, it, expect } from 'vitest'
import {
  buildExportMarkdown,
  escapeUserText,
  formatExportStamp,
  type ExportMessageRow
} from '../../src/shared/export-core'

// 对话导出 Markdown 纯逻辑冒烟(2026-11-02 多选消息导出):
// 头部元信息/说话人行/用户消息转义/居民正文原样/引用块复用/附件三态/排序缺位/群聊多名。
// 格式口径见 doc/需求 - 对话导出Markdown(多选消息分享) - 2026-11-02.md §3.4。

function row(over: Partial<ExportMessageRow> & Pick<ExportMessageRow, 'id' | 'speaker'>): ExportMessageRow {
  return { isOwner: false, content: '', createdAt: '2026-11-02T05:01:00.000Z', ...over }
}

describe('formatExportStamp:本机时区 yyyy-MM-dd HH:mm', () => {
  it('ISO 字符串格式化(按运行环境时区,断言形状不锚定时区偏移)', () => {
    expect(formatExportStamp('2026-11-02T05:01:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('非法时间返回空串', () => {
    expect(formatExportStamp('not-a-date')).toBe('')
  })
})

describe('escapeUserText:用户消息行首控制字符转义', () => {
  it('行首 # > - * + 转义', () => {
    expect(escapeUserText('# 标题')).toBe('\\# 标题')
    expect(escapeUserText('> 引用')).toBe('\\> 引用')
    expect(escapeUserText('- 事项')).toBe('\\- 事项')
    expect(escapeUserText('*重点*')).toBe('\\*重点*')
    expect(escapeUserText('+ 加号')).toBe('\\+ 加号')
  })

  it('有序标记转义(带空格才构成列表,无空格不动)', () => {
    expect(escapeUserText('1. 第一')).toBe('1\\. 第一')
    expect(escapeUserText('12) 第二')).toBe('12\\) 第二')
    expect(escapeUserText('1.5 公里')).toBe('1.5 公里')
  })

  it('行中字符不动,多行逐行处理,缩进保留', () => {
    expect(escapeUserText('C# 编程')).toBe('C# 编程')
    expect(escapeUserText('正常\n- 列表')).toBe('正常\n\\- 列表')
    expect(escapeUserText('  - 缩进项')).toBe('  \\- 缩进项')
  })
})

describe('buildExportMarkdown:整份文档拼装', () => {
  const base = {
    conversation: '与 Momo 的单聊',
    exportedAt: '2026-11-02T06:30:00.000Z'
  }

  it('空 rows 返回空串(主进程守卫「没有可导出的消息」)', () => {
    expect(buildExportMarkdown([], base)).toBe('')
  })

  it('头部元信息含会话与条数,文末署名', () => {
    const md = buildExportMarkdown([row({ id: 1, speaker: 'Felix', isOwner: true, content: '你好' })], base)
    expect(md).toContain('> 由「群岛」导出 · ')
    expect(md).toContain('· 与 Momo 的单聊 · 共 1 条')
    expect(md.endsWith('*由群岛(Archipelago)生成*')).toBe(true)
  })

  it('岛主行带(岛主)后缀且正文转义;居民行名字裸出、markdown 原样', () => {
    const md = buildExportMarkdown(
      [
        row({ id: 1, speaker: 'Felix', isOwner: true, content: '# 我说' }),
        row({ id: 2, speaker: 'Momo', content: '## 回应\n\n- 一条列表' })
      ],
      base
    )
    expect(md).toContain('**Felix(岛主)** ')
    expect(md).toContain('\\# 我说')
    expect(md).toContain('**Momo** ')
    expect(md).toContain('## 回应')
    expect(md).toContain('- 一条列表')
  })

  it('引用块复用 quoteLines 格式(含来源标签与 botName)', () => {
    const md = buildExportMarkdown(
      [
        row({
          id: 1,
          speaker: 'Felix',
          isOwner: true,
          content: '接着说',
          quotes: [{ id: 'q1', text: '上轮结论', kind: 'assistant', botName: 'Kiki' }]
        })
      ],
      base
    )
    expect(md).toContain('> 【引用 · 居民回复 · Kiki】')
    expect(md).toContain('> 上轮结论')
  })

  it('附件三态:图片有 dataURL 内联、读不到降级文件名、文件与文件夹只写名字不写路径', () => {
    const md = buildExportMarkdown(
      [
        row({
          id: 1,
          speaker: 'Felix',
          isOwner: true,
          content: '看图',
          attachments: [
            { kind: 'image', path: '/data/attachments/a.jpg', name: '猫.jpg' },
            { kind: 'image', path: '/data/attachments/b.jpg', name: '丢失.png' },
            { kind: 'file', path: '/Users/felix/秘密/报告.pdf', name: '报告.pdf' },
            { kind: 'dir', path: '/Users/felix/素材', name: '素材' }
          ]
        })
      ],
      base,
      new Map([['/data/attachments/a.jpg', 'data:image/jpeg;base64,QUJD']])
    )
    expect(md).toContain('![猫.jpg](data:image/jpeg;base64,QUJD)')
    expect(md).toContain('📷 丢失.png')
    expect(md).toContain('📎 报告.pdf')
    expect(md).toContain('📁 素材')
    expect(md).not.toContain('/Users/felix')
  })

  it('附件名里的方括号被清掉(防炸 md 语法)', () => {
    const md = buildExportMarkdown(
      [row({ id: 1, speaker: 'F', isOwner: true, content: 'x', attachments: [{ kind: 'file', path: '/t/a[b].txt', name: 'a[b].txt' }] })],
      base
    )
    expect(md).toContain('📎 a b .txt')
    expect(md).not.toContain('a[b].txt')
  })

  it('乱序传入按 id 升序;跳选的消息直接缺位,无省略标记', () => {
    const md = buildExportMarkdown(
      [row({ id: 7, speaker: 'Momo', content: '丙' }), row({ id: 2, speaker: 'Felix', isOwner: true, content: '甲' }), row({ id: 4, speaker: 'Momo', content: '乙' })],
      { ...base, conversation: '群聊 · 出海小队' }
    )
    const idxA = md.indexOf('甲')
    const idxB = md.indexOf('乙')
    const idxC = md.indexOf('丙')
    expect(idxA).toBeGreaterThan(0)
    expect(idxA).toBeLessThan(idxB)
    expect(idxB).toBeLessThan(idxC)
    expect(md).toContain('· 群聊 · 出海小队 · 共 3 条')
    expect(md).not.toContain('省略')
  })

  it('定时任务触发的居民消息在说话人行尾注记', () => {
    const md = buildExportMarkdown([row({ id: 1, speaker: 'Momo', content: '到点了', fromTask: true })], base)
    expect(md).toMatch(/\*\*Momo\*\* \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 定时任务/)
  })
})
