import { describe, it, expect } from 'vitest'
import {
  MAX_STEPS,
  REPEAT_STREAK_WARN,
  REPEAT_WARN_MAX_PER_TURN,
  EXHAUST_WARN_AHEAD,
  REPEAT_REMINDER,
  EXHAUST_REMINDER,
  EXHAUST_SUFFIX_TASK,
  EXHAUST_SUFFIX_CHAT,
  createRepeatGuard,
  noteToolCall,
  toolCallSignature
} from '../../src/main/turn-guard'

// 回合失控护栏纯逻辑冒烟(2026-11-03 方案 - 单聊回合步数上限与失控护栏):
// 重复检测语义 = ZCode model-anomaly.ts 同款——同签名连续 REPEAT_STREAK_WARN 次只在恰好命中
// 那次注入,streak 4、5…不重复注,断掉重达阈值才再注,每回合最多 REPEAT_WARN_MAX_PER_TURN 次;
// 签名 = 工具名 + 参数 stable JSON(键序无关)。

describe('toolCallSignature:稳定签名', () => {
  it('参数键序不同视为同签名', () => {
    expect(toolCallSignature('read_file', { path: '/a', offset: 3 })).toBe(
      toolCallSignature('read_file', { offset: 3, path: '/a' })
    )
  })

  it('嵌套对象的键序也归一(数组保序)', () => {
    expect(toolCallSignature('t', { a: { x: 1, y: [2, 3] } })).toBe(toolCallSignature('t', { a: { y: [2, 3], x: 1 } }))
    expect(toolCallSignature('t', { a: [1, 2] })).not.toBe(toolCallSignature('t', { a: [2, 1] }))
  })

  it('不同工具名或不同参数值签名不同', () => {
    expect(toolCallSignature('read_file', { path: '/a' })).not.toBe(toolCallSignature('list_dir', { path: '/a' }))
    expect(toolCallSignature('read_file', { path: '/a' })).not.toBe(toolCallSignature('read_file', { path: '/b' }))
  })
})

describe('noteToolCall:重复检测与注入节流', () => {
  it('同签名连续 3 次恰好在第 3 次命中注入,第 4 次不再注', () => {
    const s = createRepeatGuard()
    expect(noteToolCall(s, 'sig')).toBe(false)
    expect(noteToolCall(s, 'sig')).toBe(false)
    expect(noteToolCall(s, 'sig')).toBe(true)
    expect(noteToolCall(s, 'sig')).toBe(false)
  })

  it('断掉(换签名)后 streak 重置,重达阈值会再注入', () => {
    const s = createRepeatGuard()
    noteToolCall(s, 'a')
    noteToolCall(s, 'a')
    expect(noteToolCall(s, 'a')).toBe(true)
    expect(noteToolCall(s, 'b')).toBe(false) // streak 重置为 1
    noteToolCall(s, 'a')
    noteToolCall(s, 'a')
    expect(noteToolCall(s, 'a')).toBe(true)
  })

  it('每回合注入上限 3 次:注满后命中阈值也不再注', () => {
    const s = createRepeatGuard()
    // 三轮「断掉→连续 3 次同签名」,每轮第 3 次注入
    expect(noteToolCall(s, 'a')).toBe(false)
    expect(noteToolCall(s, 'a')).toBe(false)
    expect(noteToolCall(s, 'a')).toBe(true)
    expect(noteToolCall(s, 'b')).toBe(false)
    expect(noteToolCall(s, 'b')).toBe(false)
    expect(noteToolCall(s, 'b')).toBe(true)
    expect(noteToolCall(s, 'c')).toBe(false)
    expect(noteToolCall(s, 'c')).toBe(false)
    expect(noteToolCall(s, 'c')).toBe(true)
    // 第四轮:命中阈值但已注满
    expect(noteToolCall(s, 'd')).toBe(false)
    expect(noteToolCall(s, 'd')).toBe(false)
    expect(noteToolCall(s, 'd')).toBe(false)
    expect(s.warningsInjected).toBe(REPEAT_WARN_MAX_PER_TURN)
  })
})

describe('常量与收尾文案', () => {
  it('上限与护栏口径(2026-11-03 拍板:100 / 连续3次 / 每回合3次 / 提前10步)', () => {
    expect(MAX_STEPS).toBe(100)
    expect(REPEAT_STREAK_WARN).toBe(3)
    expect(REPEAT_WARN_MAX_PER_TURN).toBe(3)
    expect(EXHAUST_WARN_AHEAD).toBe(10)
  })

  it('任务/普通回合耗尽文案分家(任务口径=Felix 定稿:指路回「继续」续跑)', () => {
    expect(EXHAUST_SUFFIX_TASK).toContain('本次任务执行已到步数上限')
    expect(EXHAUST_SUFFIX_TASK).toContain('回复「继续」')
    expect(EXHAUST_SUFFIX_CHAT).toBe('\n\n(本轮工具步数已达上限,先停在这里;要继续的话跟我说一声。)')
  })

  it('两段注入提醒自带系统提示标记与阈值数字', () => {
    expect(REPEAT_REMINDER).toContain('[系统提示]')
    expect(REPEAT_REMINDER).toContain(`${REPEAT_STREAK_WARN} 次`)
    expect(EXHAUST_REMINDER).toContain('[系统提示]')
    expect(EXHAUST_REMINDER).toContain(`${EXHAUST_WARN_AHEAD} 步`)
  })
})
