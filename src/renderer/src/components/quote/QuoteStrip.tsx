import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Quote, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { quoteStore, type QuoteRecord } from './quoteStore'
import { quoteSourceLabel } from './QuoteCards'

// 引用条(2026-11-02):挂在输入框内、附件区之上。收起=计数胶囊「引用 · N」;
// 展开=逐条预览(3 行截断,带来源小标)+ 单条移除 + 多于一条时「全部清除」;
// note 显示上次添加失败的原因,下次成功添加/删除/清空即消(口径对齐 fi chip)。

export function QuoteStrip({ quoteKey, record }: { quoteKey: string; record: QuoteRecord }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // 会话切换时收回展开态(新会话的引用条从胶囊重新开始)
  useEffect(() => {
    setOpen(false)
  }, [quoteKey])

  const hasContent = record.quotes.length > 0 || record.note !== null
  if (!hasContent) return null

  const note =
    record.note === 'single'
      ? t('quote.limitSingle')
      : record.note === 'count'
        ? t('quote.limitCount')
        : record.note === 'total'
          ? t('quote.limitTotal')
          : null

  return (
    <div className="quote-strip">
      <button
        type="button"
        className="quote-pill"
        aria-expanded={open}
        data-quote-count={record.quotes.length}
        onClick={() => setOpen((v) => !v)}
      >
        <Quote size={12} />
        {t('quote.count', { n: record.quotes.length })}
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {note !== null && <div className="quote-note">{note}</div>}
      {open && record.quotes.length > 0 && (
        <div className="quote-list">
          {record.quotes.map((q) => (
            <div className="quote-item" key={q.id}>
              <div className="quote-item-main">
                <div className="quote-item-label">{quoteSourceLabel(t, q)}</div>
                <div className="quote-item-text" title={q.text}>
                  {q.text}
                </div>
              </div>
              <button
                type="button"
                className="quote-item-x"
                aria-label={t('quote.remove')}
                title={t('quote.remove')}
                onClick={() => quoteStore.remove(quoteKey, q.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {record.quotes.length > 1 && (
            <button type="button" className="quote-clear" onClick={() => quoteStore.clear(quoteKey)}>
              {t('quote.clear')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
