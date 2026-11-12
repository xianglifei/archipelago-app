import { describe, it, expect } from 'vitest'
import { nextWeekly, advanceFrom } from '../../src/main/tasks-core'

// weekly 触发时刻纯逻辑(2026-11-06 codex 审查修复):weekday 非整数曾让 nextWeekly 的
// while 永远等不到 getDay() 相等,主进程整个挂死——现在前置 Number.isInteger 校验。

describe('nextWeekly 参数护栏', () => {
  const from = Date.parse('2026-11-06T00:00:00+08:00') // 周五

  it('非整数 weekday 返回 null(防死循环),不再挂死主进程', () => {
    expect(nextWeekly(1.5, '08:00', from)).toBeNull()
    expect(nextWeekly(0.5, '08:00', from)).toBeNull()
  })

  it('越界与非法时间同样拒绝', () => {
    expect(nextWeekly(-1, '08:00', from)).toBeNull()
    expect(nextWeekly(7, '08:00', from)).toBeNull()
    expect(nextWeekly(3, '25:00', from)).toBeNull()
  })

  it('合法整数照常算出下一个周三 08:00', () => {
    const next = nextWeekly(3, '08:00', from)
    expect(next).not.toBeNull()
    const d = new Date(next!)
    expect(d.getDay()).toBe(3)
    expect(d.getHours()).toBe(8)
  })

  it('advanceFrom 对非法 weekly 参数同样回落 null(登记/改期入口拿到的就是这个)', () => {
    expect(advanceFrom('weekly', { weekday: 1.5, time: '08:00' }, from)).toBeNull()
  })
})
