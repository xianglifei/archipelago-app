import { useMemo, useSyncExternalStore } from 'react'
import type { ChatQuote, QuoteKind } from '@shared/types'
import { appendQuote, mergeQuotes, type AppendQuoteResult } from '@shared/quote-core'

// 引用池(2026-11-02 聊天选区引用):模块级按会话分桶(单聊 bot: / 群聊 group:),
// 不进 React 状态、不落盘(内存态,重启即失,fi/ZCode 同款;已发送引用随消息落库不受影响)。
// note=上次添加失败的原因,在引用条上提示一行,下次成功添加/删除/清空即消。

export interface QuoteRecord {
  quotes: ChatQuote[]
  /** 上次添加失败的原因(超长/条数满/总长满),提示一行;成功添加/删除/清空即消 */
  note: 'single' | 'count' | 'total' | null
}

const EMPTY: QuoteRecord = { quotes: [], note: null }
const byConversation = new Map<string, QuoteRecord>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      // 订阅方异常不外溢
    }
  }
}

function commit(key: string, record: QuoteRecord): void {
  if (record.quotes.length === 0 && record.note === null) byConversation.delete(key)
  else byConversation.set(key, record)
  emit()
}

/** 会话分桶键:单聊/群聊各自隔离,互不可见 */
export function chatQuoteKey(botId: string): string {
  return `bot:${botId}`
}

export function groupQuoteKey(groupId: string): string {
  return `group:${groupId}`
}

let quoteSeq = 0

function makeQuoteId(): string {
  quoteSeq += 1
  try {
    return crypto.randomUUID()
  } catch {
    return `quote-${Date.now().toString(36)}-${quoteSeq}`
  }
}

/** 前端造一条引用:id 只用于逐条移除,不参与语义 */
export function makeChatQuote(text: string, kind: QuoteKind, botName?: string): ChatQuote {
  const id = makeQuoteId()
  return botName ? { id, text, kind, botName } : { id, text, kind }
}

export const quoteStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  record(key: string): QuoteRecord {
    return byConversation.get(key) ?? EMPTY
  },
  add(key: string, quote: ChatQuote): AppendQuoteResult {
    const current = quoteStore.record(key)
    const result = appendQuote(current.quotes, quote)
    if (result.ok) commit(key, { quotes: result.quotes, note: null })
    else commit(key, { quotes: current.quotes, note: result.reason })
    return result
  },
  remove(key: string, quoteId: string): void {
    commit(key, { quotes: quoteStore.record(key).quotes.filter((q) => q.id !== quoteId), note: null })
  },
  clear(key: string): void {
    commit(key, EMPTY)
  },
  /** 取走并清空(发送即消费;无引用时不动桶,避免无谓通知) */
  take(key: string): ChatQuote[] {
    const quotes = quoteStore.record(key).quotes
    if (quotes.length > 0) commit(key, EMPTY)
    return quotes
  },
  /** 发送失败回滚:把取走的引用并回(先取走的在前),按同一套上限与去重收口 */
  restore(key: string, quotes: ChatQuote[]): void {
    if (quotes.length === 0) return
    commit(key, { quotes: mergeQuotes(quotes, quoteStore.record(key).quotes), note: null })
  }
}

/** 订阅引用池(空 key 恒空记录,引用稳定的快照供 useSyncExternalStore 用) */
export function useQuoteRecord(key: string): QuoteRecord {
  const getSnapshot = useMemo(() => () => quoteStore.record(key), [key])
  return useSyncExternalStore(quoteStore.subscribe, getSnapshot, getSnapshot)
}
