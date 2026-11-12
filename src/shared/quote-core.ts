import type { ChatQuote, QuoteKind } from './types'

// 选区引用纯逻辑(2026-11-02 聊天选区引用):限额/去重/回滚合并/入口净化/引用块拼装。
// 主进程(chat/groups/steward)与渲染端(quoteStore)共用,tests/unit 同源冒烟。
// 口径移植自 ZCode Conversation Selection 与 fi 0.6 选区引用(限额三家一致):
// 单条 8000 字 / 最多 8 条 / 总计 16000 字;去重键=类型+文本,重复添加按成功处理。

export const QUOTE_LIMITS = { single: 8000, count: 8, total: 16000 } as const

const QUOTE_KINDS: readonly QuoteKind[] = ['user', 'assistant', 'reasoning', 'note', 'relation']

export function isQuoteKind(value: unknown): value is QuoteKind {
  return typeof value === 'string' && (QUOTE_KINDS as readonly string[]).includes(value)
}

export function quoteDedupeKey(quote: ChatQuote): string {
  return `${quote.kind}\u0000${quote.text}`
}

export type AppendQuoteResult =
  | { ok: true; quotes: ChatQuote[]; duplicate: boolean }
  | { ok: false; reason: 'single' | 'count' | 'total' }

/** 追加一条引用:超单条上限拒绝;同类型同文本视为重复(按成功处理不重复入列);条数/总长上限拒绝 */
export function appendQuote(current: ChatQuote[], quote: ChatQuote): AppendQuoteResult {
  if (quote.text.length > QUOTE_LIMITS.single) return { ok: false, reason: 'single' }
  const key = quoteDedupeKey(quote)
  if (current.some((item) => quoteDedupeKey(item) === key)) {
    return { ok: true, quotes: current, duplicate: true }
  }
  if (current.length >= QUOTE_LIMITS.count) return { ok: false, reason: 'count' }
  const totalLength = current.reduce((sum, item) => sum + item.text.length, 0)
  if (totalLength + quote.text.length > QUOTE_LIMITS.total) return { ok: false, reason: 'total' }
  return { ok: true, quotes: [...current, quote], duplicate: false }
}

/** 发送失败回滚时把取走的引用并回(先取走的在前),按同一套上限与去重收口 */
export function mergeQuotes(primary: ChatQuote[], extra: ChatQuote[]): ChatQuote[] {
  const merged: ChatQuote[] = []
  const seen = new Set<string>()
  for (const quote of [...primary, ...extra]) {
    const key = quoteDedupeKey(quote)
    if (seen.has(key)) continue
    seen.add(key)
    const totalLength = merged.reduce((sum, item) => sum + item.text.length, 0)
    if (merged.length >= QUOTE_LIMITS.count || totalLength + quote.text.length > QUOTE_LIMITS.total) break
    merged.push(quote)
  }
  return merged
}

/**
 * 主进程入口净化:渲染层守卫只是体验,这里是闸——IPC 载荷按不可信处理,
 * 形状不对/类型不支持/文本非字符串的条目丢弃,超限按追加规则裁剪,全空返回 []。
 * 返回的引用保证:kind 合法、text 为 trim 后非空字符串、id 补字符串兜底。
 */
export function sanitizeQuotes(input: unknown): ChatQuote[] {
  if (!Array.isArray(input)) return []
  let out: ChatQuote[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const q = raw as Partial<ChatQuote>
    if (!isQuoteKind(q.kind)) continue
    if (typeof q.text !== 'string') continue
    const text = q.text.trim()
    if (!text) continue
    const botName = typeof q.botName === 'string' && q.botName.trim() ? q.botName.trim() : undefined
    const quote: ChatQuote = { id: typeof q.id === 'string' && q.id ? q.id : `q-${out.length}`, text, kind: q.kind, ...(botName ? { botName } : {}) }
    const result = appendQuote(out, quote)
    if (result.ok) out = result.quotes
  }
  return out
}

/** 引用块来源标头(居民世界文本,中文写死不翻;界面侧标签另走 i18n) */
const QUOTE_PROMPT_LABELS: Record<QuoteKind, string> = {
  user: '用户消息',
  assistant: '居民回复',
  reasoning: '思考过程',
  note: '过程旁白',
  relation: '私信记录'
}

/**
 * 引用块(模型可见形态):markdown 引用块 + 来源标注头,拼在用户消息投影尾部
 * (与附件说明行同机制,历史轮次持续可见、随压缩进摘要语境)。空引用返回空串。
 */
export function quoteLines(quotes: ChatQuote[] | undefined | null): string {
  if (!quotes || quotes.length === 0) return ''
  const parts = quotes.map((quote) => {
    const label = QUOTE_PROMPT_LABELS[quote.kind] + (quote.botName ? ` · ${quote.botName}` : '')
    const body = quote.text
      .split('\n')
      .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
      .join('\n')
    return `> 【引用 · ${label}】\n${body}`
  })
  return `\n\n${parts.join('\n\n')}`
}
