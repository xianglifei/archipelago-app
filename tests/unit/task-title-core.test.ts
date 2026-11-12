// 任务会话标题净化(2026-11-06「新建任务」P3):模型起的标题不可信——带引号/句读/解释句,
// sanitizeTaskTitle 统一净化;手改标题走宽松口径。纯逻辑单测同源验证。
import { describe, expect, it } from 'vitest'
import { sanitizeManualTitle, sanitizeTaskTitle, TASK_TITLE_MANUAL_MAX, TASK_TITLE_MAX } from '@shared/task-title-core'

describe('sanitizeTaskTitle(模型起的标题)', () => {
  it('净味直通', () => {
    expect(sanitizeTaskTitle('整理九张海边照片')).toBe('整理九张海边照片')
  })

  it('剥包裹引号(单层/嵌套/中西文)', () => {
    expect(sanitizeTaskTitle('「整理照片」')).toBe('整理照片')
    expect(sanitizeTaskTitle('“整理照片”')).toBe('整理照片')
    expect(sanitizeTaskTitle('「『周报』」')).toBe('周报')
    expect(sanitizeTaskTitle('"整理照片"')).toBe('整理照片')
  })

  it('引号外带句读交替剥净(集成测试抓出的组合:模型常输出「标题」。)', () => {
    expect(sanitizeTaskTitle('「整理海边照片」。')).toBe('整理海边照片')
    expect(sanitizeTaskTitle('“周报素材”!')).toBe('周报素材')
    expect(sanitizeTaskTitle('「『调研』」…')).toBe('调研')
  })

  it('去尾部句读(含重复)', () => {
    expect(sanitizeTaskTitle('整理照片。')).toBe('整理照片')
    expect(sanitizeTaskTitle('写周报!!')).toBe('写周报')
    expect(sanitizeTaskTitle('调研一下…')).toBe('调研一下')
  })

  it('压空白成单空格(换行/连续空格),标题不折行', () => {
    expect(sanitizeTaskTitle('整理\n\n本周  照片')).toBe('整理 本周 照片')
  })

  it('超上限截断(代理对安全,emoji 不切半)', () => {
    expect(sanitizeTaskTitle('这是一个特别特别特别特别特别长的任务标题')).toHaveLength(TASK_TITLE_MAX)
    const emojiTitle = sanitizeTaskTitle('🌊'.repeat(20))
    expect(emojiTitle).not.toBeNull()
    const withEmoji = [...emojiTitle!]
    // 截断后每个码点仍完整
    expect(withEmoji.every((c) => c === '🌊')).toBe(true)
    expect(withEmoji.length).toBe(TASK_TITLE_MAX)
  })

  it('净化后为空返回 null(保持「新任务」)', () => {
    expect(sanitizeTaskTitle('')).toBeNull()
    expect(sanitizeTaskTitle('   ')).toBeNull()
    expect(sanitizeTaskTitle('「」')).toBeNull()
    expect(sanitizeTaskTitle('。。。')).toBeNull()
  })
})

describe('sanitizeManualTitle(岛主手改的标题)', () => {
  it('只压空白,引号句读想带就带', () => {
    expect(sanitizeManualTitle('「周报」第 42 期。')).toBe('「周报」第 42 期。')
  })

  it('超上限截到 40;空返回 null', () => {
    expect(sanitizeManualTitle('长'.repeat(60))).toHaveLength(TASK_TITLE_MANUAL_MAX)
    expect(sanitizeManualTitle('   ')).toBeNull()
  })
})
