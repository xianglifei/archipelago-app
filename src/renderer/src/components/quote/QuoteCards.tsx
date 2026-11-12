import type { ChatQuote, QuoteKind } from '@shared/types'
import { useTranslation } from '../../i18n'

// 引用卡(2026-11-02):用户消息携带的引用在气泡上方独立成块(历史回看一直可见),
// 与附件块的呈现模式同构。来源标签走 i18n;注入 prompt 的引用块中文写死(shared/quote-core)。

/** 词典函数的本地形态(与 ChatView 的 TFn 同款,避免引 i18next 类型) */
type TFn = (key: string, opts?: Record<string, unknown>) => string

/** 来源类型 → 词典 key(显式枚举,check-i18n-keys 可静态校验;群聊 assistant 带「XX 说」格式) */
const QUOTE_TYPE_KEY: Record<QuoteKind, string> = {
  user: 'quote.typeUser',
  assistant: 'quote.typeAssistant',
  reasoning: 'quote.typeReasoning',
  note: 'quote.typeNote',
  relation: 'quote.typeRelation'
}

export function quoteSourceLabel(t: TFn, quote: ChatQuote): string {
  if (quote.kind === 'assistant' && quote.botName) return t('quote.typeByBot', { name: quote.botName })
  return t(QUOTE_TYPE_KEY[quote.kind])
}

export function QuoteCards({ quotes }: { quotes?: ChatQuote[] }) {
  const { t } = useTranslation()
  if (!quotes || quotes.length === 0) return null
  return (
    <div className="quote-cards">
      {quotes.map((q) => (
        <div className="quote-card" key={q.id}>
          <div className="quote-card-label">{quoteSourceLabel(t, q)}</div>
          <div className="quote-card-text">{q.text}</div>
        </div>
      ))}
    </div>
  )
}
