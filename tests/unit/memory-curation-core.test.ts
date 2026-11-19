// 夜间记忆整理纯核契约(方案 - Linger 借鉴三件套 2026-11-19,批次③):
// 行协议解析、提案校验(行号存在/占用/变更上限/防重复/理由必填/坏行隔离)、触发判定矩阵。
// 「结构化提案 + 程序校验」的防线本体:幻觉没有直写记忆的通道,一切先过这里的校验。
import { describe, expect, it } from 'vitest'
import type { MemoryEntry } from '@shared/types'
import {
  CURATION_MAX_CHANGES,
  localDateKey,
  parseCuration,
  planCuration,
  shouldRunCuration
} from '../../src/main/memory-curation-core'

const TODAY = '2026-11-19'

const entries = (texts: string[]): MemoryEntry[] =>
  texts.map((text, i) => ({ line: i + 1, date: '2026-11-0' + ((i % 9) + 1), text }))

describe('parseCuration:行协议解析', () => {
  it('三动作与 DONE 全解析,空白行过滤', () => {
    const out = parseCuration('MERGE|1,2|合并后的新表述\nSUPERSEDE|3|改写\nREJECT|4|已过期\n\nDONE\n')
    expect(out.done).toBe(true)
    expect(out.proposals).toEqual([
      { kind: 'merge', lines: [1, 2], text: '合并后的新表述' },
      { kind: 'supersede', line: 3, text: '改写' },
      { kind: 'reject', line: 4, reason: '已过期' }
    ])
    expect(out.invalid).toHaveLength(0)
  })
  it('中文逗号/顿号分隔与重复行号去重(merge)', () => {
    const out = parseCuration('MERGE|1,1、2|新表述')
    expect(out.proposals[0]).toEqual({ kind: 'merge', lines: [1, 2], text: '新表述' })
  })
  it('坏行丢弃不伤整批:未知动作/字段缺失/merge 单行/reject 无理由', () => {
    const out = parseCuration(['ADD|1|x', 'MERGE|1|单行不算合并', 'REJECT|1|', 'SUPERSEDE|abc|x', 'REJECT|3|失效'].join('\n'))
    expect(out.proposals).toEqual([{ kind: 'reject', line: 3, reason: '失效' }])
    expect(out.invalid).toHaveLength(4)
  })
})

describe('planCuration:提案校验与整理规划', () => {
  it('merge 并入首行位置、其余行移除,日期记 today', () => {
    const es = entries(['甲条', '乙条', '丙条'])
    const out = planCuration(es, [{ kind: 'merge', lines: [1, 2], text: '甲乙合并' }], TODAY)
    expect(out.entries).toEqual([{ line: 1, date: TODAY, text: '甲乙合并' }, { line: 2, date: es[2]!.date, text: '丙条' }])
    expect(out.changed).toBe(2)
    expect(out.archives.map((a) => a.action)).toEqual(['merge', 'merge'])
  })
  it('supersede 原位替换;reject 移除并归档带理由;未提桧行原样保留', () => {
    const es = entries(['旧表述', '保留条', '记错条'])
    const out = planCuration(
      es,
      [
        { kind: 'supersede', line: 1, text: '新表述' },
        { kind: 'reject', line: 3, reason: '岛主已改用别的方式' }
      ],
      TODAY
    )
    expect(out.entries).toEqual([
      { line: 1, date: TODAY, text: '新表述' },
      { line: 2, date: es[1]!.date, text: '保留条' }
    ])
    expect(out.changed).toBe(2)
    expect(out.archives[1]).toMatchObject({ action: 'reject', reason: '岛主已改用别的方式' })
  })
  it('校验矩阵:行号不存在/被占用/超上限/制造重复/文本超长截断', () => {
    const es = entries(['a', 'b', 'c'])
    // 行号不存在
    expect(planCuration(es, [{ kind: 'reject', line: 9, reason: 'x' }], TODAY).changed).toBe(0)
    // 同行被两案引用:先到先得,后来者 invalid
    const race = planCuration(
      es,
      [
        { kind: 'reject', line: 1, reason: 'x' },
        { kind: 'supersede', line: 1, text: 'y' }
      ],
      TODAY
    )
    expect(race.changed).toBe(1)
    expect(race.invalid).toHaveLength(1)
    // 超变更上限:CURATION_MAX_CHANGES+1 行的 reject 集只收前 8 行
    const many = entries(Array.from({ length: CURATION_MAX_CHANGES + 2 }, (_, i) => `e${i}`))
    const over = planCuration(
      many,
      many.map((e) => ({ kind: 'reject' as const, line: e.line, reason: 'x' })),
      TODAY
    )
    expect(over.changed).toBe(CURATION_MAX_CHANGES)
    expect(over.invalid).toHaveLength(2)
    // 防制造重复:supersede 新文本=未动条目原文 → 整条丢弃
    expect(planCuration(es, [{ kind: 'supersede', line: 1, text: 'c' }], TODAY).changed).toBe(0)
    // 文本超长截断到 CURATION_TEXT_CAP(与 addMemory 同口径)
    const long = '长'.repeat(400)
    expect(planCuration(es, [{ kind: 'supersede', line: 1, text: long }], TODAY).entries[0]!.text).toHaveLength(300)
  })
  it('零提案=原样(keep 缺省),entries 不动', () => {
    const es = entries(['a', 'b'])
    const out = planCuration(es, [], TODAY)
    expect(out.entries).toEqual(es)
    expect(out.changed).toBe(0)
  })
})

describe('shouldRunCuration:触发判定', () => {
  const base = { enabled: true, dirty: true, lastRunDate: null as string | null, hour: 0, minute: 30 }
  const at = (h: number, m: number): Date => new Date(2026, 10, 19, h, m)
  it('到点即跑:00:30 恰好、之后、次日破晓都行;之前不跑', () => {
    expect(shouldRunCuration(at(0, 29), base)).toBe(false)
    expect(shouldRunCuration(at(0, 30), base)).toBe(true)
    expect(shouldRunCuration(at(23, 0), base)).toBe(true)
  })
  it('当天跑过不重跑;关开关/干净集直接静默', () => {
    expect(shouldRunCuration(at(9, 0), { ...base, lastRunDate: '2026-11-19' })).toBe(false)
    expect(shouldRunCuration(at(9, 0), { ...base, enabled: false })).toBe(false)
    expect(shouldRunCuration(at(9, 0), { ...base, dirty: false })).toBe(false)
  })
  it('localDateKey 按本地时区补零', () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
