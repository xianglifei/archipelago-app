import { describe, it, expect } from 'vitest'
import {
  QUOTE_LIMITS,
  appendQuote,
  mergeQuotes,
  sanitizeQuotes,
  quoteLines,
  quoteDedupeKey,
  isQuoteKind
} from '../../src/shared/quote-core'
import type { ChatQuote } from '../../src/shared/types'

// 选区引用纯逻辑冒烟(2026-11-02 聊天选区引用):限额/去重/回滚合并/入口净化/引用块拼装。
// 限额口径 = ZCode Conversation Selection 与 fi 0.6 选区引用三家一致:
// 单条 8000 字 / 最多 8 条 / 总计 16000 字。

function quote(text: string, kind: ChatQuote['kind'] = 'assistant', botName?: string): ChatQuote {
  return botName ? { id: `id-${text.slice(0, 8)}-${kind}`, text, kind, botName } : { id: `id-${text.slice(0, 8)}-${kind}`, text, kind }
}

describe('appendQuote:追加与限额', () => {
  it('新条目追加成功', () => {
    const r = appendQuote([], quote('你好'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.quotes).toHaveLength(1)
  })

  it('同类型同文本视为重复:按成功处理且不重复入列', () => {
    const first = appendQuote([], quote('同一句话'))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const again = appendQuote(first.quotes, quote('同一句话'))
    expect(again.ok).toBe(true)
    if (again.ok) {
      expect(again.duplicate).toBe(true)
      expect(again.quotes).toHaveLength(1)
    }
  })

  it('同文本不同类型不去重(用户消息与居民回复各算一条)', () => {
    const first = appendQuote([], quote('同一句话', 'user'))
    expect(first.ok).toBe(true)
    const again = appendQuote(first.ok ? first.quotes : [], quote('同一句话', 'assistant'))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.quotes).toHaveLength(2)
  })

  it('超单条上限拒绝(single)', () => {
    const r = appendQuote([], quote('长'.repeat(QUOTE_LIMITS.single + 1)))
    expect(r).toEqual({ ok: false, reason: 'single' })
  })

  it('恰好等于单条上限可入列', () => {
    const r = appendQuote([], quote('长'.repeat(QUOTE_LIMITS.single)))
    expect(r.ok).toBe(true)
  })

  it('条数达上限拒绝(count)', () => {
    let current: ChatQuote[] = []
    for (let i = 0; i < QUOTE_LIMITS.count; i++) {
      const r = appendQuote(current, quote(`第${i}条`))
      if (r.ok) current = r.quotes
    }
    expect(current).toHaveLength(QUOTE_LIMITS.count)
    const r = appendQuote(current, quote('多出来的'))
    expect(r).toEqual({ ok: false, reason: 'count' })
  })

  it('总长超上限拒绝(total)', () => {
    // 两条 7000 字:单条均合规,合计 14000;第三条 2500 字使总数 16500 > 16000
    const current: ChatQuote[] = [quote('a'.repeat(7000)), quote('b'.repeat(7000))]
    const r = appendQuote(current, quote('c'.repeat(2500)))
    expect(r).toEqual({ ok: false, reason: 'total' })
    // 换一条短的仍可入列
    const ok = appendQuote(current, quote('短的'))
    expect(ok.ok).toBe(true)
  })
})

describe('mergeQuotes:发送失败回滚合并', () => {
  it('先取走的在前,与残余按去重与上限收口', () => {
    const taken = [quote('甲'), quote('乙')]
    const stayed = [quote('乙'), quote('丙')]
    const merged = mergeQuotes(taken, stayed)
    expect(merged.map((q) => q.text)).toEqual(['甲', '乙', '丙'])
  })

  it('合并超出条数上限时截断(取走的优先保留)', () => {
    const taken = Array.from({ length: QUOTE_LIMITS.count - 1 }, (_, i) => quote(`取走${i}`))
    const stayed = [quote('残余'), quote('装不下')]
    const merged = mergeQuotes(taken, stayed)
    expect(merged).toHaveLength(QUOTE_LIMITS.count)
    expect(merged.map((q) => q.text)).toEqual([...Array.from({ length: QUOTE_LIMITS.count - 1 }, (_, i) => `取走${i}`), '残余'])
  })
})

describe('sanitizeQuotes:主进程入口净化', () => {
  it('非数组输入返回空', () => {
    expect(sanitizeQuotes(undefined)).toEqual([])
    expect(sanitizeQuotes('not-array')).toEqual([])
    expect(sanitizeQuotes({})).toEqual([])
  })

  it('丢弃形状不对的条目(坏类型/空文本/非对象)', () => {
    const out = sanitizeQuotes([quote('好的'), null, 42, 'str', { kind: 'assistant', text: '' }, { kind: 'hack', text: 'x' }, { kind: 'user', text: 123 }])
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toBe('好的')
  })

  it('文本 trim、botName 空串归一为缺省、id 缺失补兜底', () => {
    const out = sanitizeQuotes([{ kind: 'assistant', text: '  空白包裹  ', botName: '  ' }])
    expect(out).toEqual([{ id: 'q-0', text: '空白包裹', kind: 'assistant' }])
  })

  it('超限载荷按追加规则裁剪(条数/总长/超长单条)', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, kind: 'user' as const, text: `条目${i}` }))
    expect(sanitizeQuotes(many)).toHaveLength(QUOTE_LIMITS.count)
    const tooLong = [{ kind: 'user' as const, text: '长'.repeat(QUOTE_LIMITS.single + 5) }]
    expect(sanitizeQuotes(tooLong)).toEqual([])
  })
})

describe('quoteLines:引用块(模型可见形态,中文写死)', () => {
  it('空引用返回空串', () => {
    expect(quoteLines(undefined)).toBe('')
    expect(quoteLines([])).toBe('')
  })

  it('单条:来源标头 + 逐行 > 前缀,以两个换行开头拼在正文后', () => {
    const out = quoteLines([quote('第一行\n第二行', 'assistant')])
    expect(out).toBe('\n\n> 【引用 · 居民回复】\n> 第一行\n> 第二行')
  })

  it('多行文本的空行折为裸 >,多条之间空一行', () => {
    const out = quoteLines([quote('上段\n\n下段', 'reasoning'), quote('第二段', 'note')])
    expect(out).toBe('\n\n> 【引用 · 思考过程】\n> 上段\n>\n> 下段\n\n> 【引用 · 过程旁白】\n> 第二段')
  })

  it('带 botName 时标头追加来源居民(群聊口径)', () => {
    const out = quoteLines([quote('群里的话', 'assistant', 'Momo')])
    expect(out).toContain('【引用 · 居民回复 · Momo】')
  })
})

describe('杂项', () => {
  it('quoteDedupeKey:类型与文本共同决定', () => {
    expect(quoteDedupeKey(quote('a', 'user'))).not.toBe(quoteDedupeKey(quote('a', 'assistant')))
    expect(quoteDedupeKey(quote('a'))).toBe(quoteDedupeKey(quote('a')))
  })

  it('isQuoteKind:五类合法,其余拒绝(tool 经拍板砍掉)', () => {
    for (const k of ['user', 'assistant', 'reasoning', 'note', 'relation']) expect(isQuoteKind(k)).toBe(true)
    expect(isQuoteKind('tool')).toBe(false)
    expect(isQuoteKind(undefined)).toBe(false)
    expect(isQuoteKind(42)).toBe(false)
  })
})
