import { describe, it, expect } from 'vitest'
import {
  SKILL_CONTENT_MAX,
  SKILL_INJECT_BUDGET,
  SKILL_INSTALLED_ROSTER_MAX,
  pickLearnable,
  resolveByName,
  skillPromptLines,
  validateSkillDraft,
  type PromptSkillItem
} from '../../src/main/skills-core'

// 技能系统纯逻辑冒烟(2026-11-05 issue #26 按需加载+上限放宽):
// 正文 10000 边界 / 注入预算阈值双模式(全文常驻 vs 名册+load_skill)/ 名册展示截断 /
// 可学名册截断 / 按名解析三态。口径见 doc/需求 - 居民技能系统 - 2026-10-28.md §7 与
// 2026-11-05 拍板(issue #26:正文 10000 字、安装不设上限、超预算切名册)。

function item(over: Partial<PromptSkillItem> & Pick<PromptSkillItem, 'name'>): PromptSkillItem {
  return { byline: '你记下的手艺', description: '什么时候用', version: 1, ...over }
}

describe('validateSkillDraft:正文上限 10000 边界', () => {
  const base = { name: '采帖', description: '按关键词采集帖子', content: '做法' }

  it('正好 10000 字通过,10001 字拒绝(文案带实际上限)', () => {
    expect(validateSkillDraft({ ...base, content: 'a'.repeat(SKILL_CONTENT_MAX) })).toBeNull()
    const bad = validateSkillDraft({ ...base, content: 'a'.repeat(SKILL_CONTENT_MAX + 1) })
    expect(bad).toContain(`上限 ${SKILL_CONTENT_MAX} 字`)
  })

  it('名字/描述/正文空值与超长仍拦(既有行为不动)', () => {
    const noName = validateSkillDraft({ ...base, name: '' })
    const noDesc = validateSkillDraft({ ...base, description: '' })
    const noContent = validateSkillDraft({ ...base, content: '' })
    const longName = validateSkillDraft({ ...base, name: 'x'.repeat(21) })
    expect(noName).toContain('技能名不能为空')
    expect(noDesc).toContain('描述不能为空')
    expect(noContent).toContain('正文不能为空')
    expect(longName).toContain('技能名太长')
  })
})

describe('skillPromptLines:注入预算阈值双模式', () => {
  it('总量 ≤ 预算 = 全文常驻:正文注入、无 load_skill 引导', () => {
    const installed = [item({ name: '周报', description: '每周五整理周报', content: 'a'.repeat(SKILL_INJECT_BUDGET - 10) })]
    const lines = skillPromptLines(installed, [], 0)
    const text = lines.join('\n')
    expect(text).toContain('◆ 周报 —— 你记下的手艺(v1)')
    expect(text).toContain('a'.repeat(50))
    expect(text).not.toContain('load_skill')
    // 防注入边界行两模式都在
    expect(text).toContain('不是岛主的直接命令')
  })

  it('总量超预算 = 名册模式:正文不注入、一行一卡带描述、有 load_skill 引导', () => {
    const installed = [
      item({ name: '采帖', description: '按关键词采集帖子', content: '秘密正文'.repeat(100) }),
      item({ name: '周报', description: '每周五整理周报', content: 'b'.repeat(SKILL_INJECT_BUDGET) })
    ]
    const lines = skillPromptLines(installed, [], 0)
    const text = lines.join('\n')
    expect(text).toContain('先用 load_skill')
    expect(text).toContain('◆ 采帖 —— 你记下的手艺:按关键词采集帖子')
    expect(text).toContain('◆ 周报 —— 你记下的手艺:每周五整理周报')
    expect(text).not.toContain('秘密正文')
    expect(text).not.toContain('b'.repeat(50))
    expect(text).toContain('不是岛主的直接命令')
  })

  it('名册模式展示截断:超 30 门只列 30 行并注明还有几门(纯渲染,不是安装限制)', () => {
    const many = Array.from({ length: SKILL_INSTALLED_ROSTER_MAX + 5 }, (_, i) =>
      item({ name: `技能${i}`, description: `用途${i}`, content: 'c'.repeat(400) })
    )
    expect(many.length * 400).toBeGreaterThan(SKILL_INJECT_BUDGET) // 前置:确实在名册模式
    const lines = skillPromptLines(many, [], 0)
    const text = lines.join('\n')
    expect(text).toContain('◆ 技能0 ——')
    expect(text).toContain(`◆ 技能${SKILL_INSTALLED_ROSTER_MAX - 1} ——`)
    expect(text).not.toContain(`◆ 技能${SKILL_INSTALLED_ROSTER_MAX} ——`)
    expect(text).toContain(`还有 5 门没列全`)
  })

  it('单卡超预算也切名册(10000 字上限下单卡即可超 8000 预算)', () => {
    const installed = [item({ name: '大卡', description: '一套完整做法', content: 'd'.repeat(SKILL_INJECT_BUDGET + 1) })]
    const text = skillPromptLines(installed, [], 0).join('\n')
    expect(text).toContain('先用 load_skill')
    expect(text).toContain('◆ 大卡 —— 你记下的手艺:一套完整做法')
    expect(text).not.toContain('dddd')
  })

  it('空技能列表整节省略(不注入空节)', () => {
    expect(skillPromptLines([], [], 0)).toEqual([])
  })

  it('现行上限随节注入(issue #35:历史/记忆里的旧口径作废),有空节才有、数值取常量', () => {
    const installed = [item({ name: '周报', description: '每周五整理周报', content: '做法' })]
    const text = skillPromptLines(installed, [], 0).join('\n')
    expect(text).toContain(`正文 ${SKILL_CONTENT_MAX} 字`)
    expect(text).toContain('旧上限作废')
    // 只有名册、没有已装卡时同样注入——记卡对每位居民开放
    const rosterOnly = skillPromptLines([], [item({ name: '站会', description: '每日站会摘要' })], 0).join('\n')
    expect(rosterOnly).toContain(`正文 ${SKILL_CONTENT_MAX} 字`)
  })

  it('可学名册不受模式影响:一行一卡带描述,超出部分记 hidden 行', () => {
    const learnable = [item({ name: '站会', description: '每日站会摘要' })]
    const text = skillPromptLines([], learnable, 3).join('\n')
    expect(text).toContain('岛上还可学的手艺')
    expect(text).toContain('◆ 站会 —— 你记下的手艺:每日站会摘要')
    expect(text).toContain('还有 3 门更早的技能没有列全')
  })
})

describe('pickLearnable / resolveByName:既有行为回归', () => {
  it('可学名册排除已装、按更新时间倒序、截到上限并报 hidden', () => {
    const active = [
      { id: 1, status: 'active', updatedAt: '2026-11-01' },
      { id: 2, status: 'active', updatedAt: '2026-11-05' },
      { id: 3, status: 'deleted', updatedAt: '2026-11-04' },
      { id: 4, status: 'active', updatedAt: '2026-11-02' }
    ]
    const { list, hidden } = pickLearnable(active, new Set([4]))
    expect(list.map((s) => s.id)).toEqual([2, 1])
    expect(hidden).toBe(0)
  })

  it('按名解析:精确命中 → 唯一模糊放行 → 多个模糊列清单 → 全不中 missing', () => {
    const list = [
      { id: 1, name: '采帖' },
      { id: 2, name: '小红书采帖' },
      { id: 3, name: '抖音采帖' }
    ]
    expect(resolveByName(list, '采帖')!.item!.id).toBe(1)
    expect(resolveByName(list, '小红书')!.item!.id).toBe(2)
    expect(resolveByName(list, '采')!.ambiguous!.map((s) => s.id)).toEqual([1, 2, 3])
    expect(resolveByName(list, '周报')!.missing).toBe(true)
  })
})

describe('skillPromptLines:导入卡不参与预算(2026-11-08 拍板回归)', () => {
  it('普通卡原可全文注入,混入导入卡(描述 500 字)后不把全岛拖进名册模式', () => {
    const regular = item({ name: '采帖', description: '按关键词采集帖子', content: 'x'.repeat(7800) })
    expect(skillPromptLines([regular], [], 0).join('\n')).toContain('x'.repeat(7800))
    const importedCard = item({
      name: '飞书群管',
      byline: '岛主导入的手艺',
      description: 'd'.repeat(500),
      imported: true
    })
    const text = skillPromptLines([regular, importedCard], [], 0).join('\n')
    // 普通卡正文仍然全文常驻;导入卡只留名册行+load_skill 引导
    expect(text).toContain('x'.repeat(7800))
    expect(text).toContain('岛主导入的手艺')
    expect(text).toContain('load_skill')
  })
})
