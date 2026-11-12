import { describe, it, expect } from 'vitest'
import { SKILL_ROSTER_MAX, officialPromptLines } from '../../src/main/skills-core'

// 精选推荐名册注入(2026-11-05 二期):目录里本岛未装的卡进提示词名册,≤10 行+不推销约束;
// 装过的(已复制进岛)不再出现在官方小节(它们会进「岛上还可学的手艺」名册)。
// 口径见 doc/需求 - 技能中心(官方精选与岛上技能) - 2026-10-29.md §3。

function cards(n: number): { name: string; description: string }[] {
  return Array.from({ length: n }, (_, i) => ({ name: `技能${i + 1}`, description: `什么时候用 ${i + 1}` }))
}

describe('officialPromptLines:精选推荐名册', () => {
  it('目录为空或全装过 → 空数组(整节省略)', () => {
    expect(officialPromptLines([], new Set(), 0)).toEqual([])
    const installed = new Set(['飞书'])
    expect(officialPromptLines([{ name: '飞书', description: 'x' }], installed, 0)).toEqual([])
  })

  it('未装的进名册:小节标题 + 每卡一行(名字 —— 一句话)', () => {
    const lines = officialPromptLines(
      [
        { name: '飞书', description: '管飞书' },
        { name: '瑞幸咖啡', description: '点咖啡' }
      ],
      new Set(['瑞幸咖啡']),
      0
    )
    expect(lines[0]).toContain('精选推荐')
    expect(lines[0]).toContain('不要主动推销')
    expect(lines).toContain('◆ 飞书 —— 管飞书')
    expect(lines.join('\n')).not.toContain('瑞幸咖啡')
  })

  it('超过名册上限 10 行截断,并带「不止这些」提示', () => {
    const lines = officialPromptLines(cards(13), new Set(), 0)
    const cardLines = lines.filter((l) => l.startsWith('◆'))
    expect(cardLines.length).toBe(SKILL_ROSTER_MAX)
    expect(lines[lines.length - 1]).toContain('共 13 门')
  })

  it('hidden 提示计入目录侧未下发的余量', () => {
    const lines = officialPromptLines(cards(3), new Set(), 5)
    expect(lines[lines.length - 1]).toContain('共 8 门')
  })
})
