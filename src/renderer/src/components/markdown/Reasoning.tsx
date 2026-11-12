import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'

// 思考过程折叠块(参考 ZCode reasoning.tsx):默认收起;思考中收起态在「正在思考」后跑一行最新思考行,
// 每来一个 token 就把单行视口 scrollLeft 推到最右,旧字向左挤出——快慢即模型吐字速度;
// 用户点开看全文(吸底跟随),完成后收起为「思考了 N 秒」
const BOTTOM_LOCK_PX = 2

/** 取流式思考文本的最后一个非空行;key 用行号,同一行追加 token 时 key 不变、换行才变 */
export function lastReasoningLine(text: string): { key: number; text: string } | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line) return { key: i, text: line }
  }
  return null
}

export function Reasoning({
  text,
  live = false,
  elapsedMs = null
}: {
  text: string
  live?: boolean
  elapsedMs?: number | null
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [secs, setSecs] = useState(1)
  const [overflow, setOverflow] = useState(false)
  const startRef = useRef<number | null>(null)
  const viewportRef = useRef<HTMLSpanElement>(null)
  const lineRef = useRef<HTMLSpanElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const followBottomRef = useRef(true)

  // 收起态不跑秒表(省掉每秒整块重渲染),展开时按同一起点补算并持续更新
  useEffect(() => {
    if (!live) {
      startRef.current = null
      return
    }
    startRef.current ??= performance.now()
    if (!open) return
    const tick = (): void => {
      const started = startRef.current ?? performance.now()
      setSecs(Math.max(1, Math.ceil((performance.now() - started) / 1000)))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [live, open])

  const summary = live && !open ? lastReasoningLine(text) : null
  const summaryKey = summary?.key ?? null
  const summaryText = summary?.text ?? ''

  // 单行视口超宽后 overflow:hidden 会固定显示旧前缀,最新 token 被裁在右侧;
  // 每次内容增长把视口推到末尾;只在真溢出时挂两侧渐隐 mask,短文字不发虚
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || summaryKey === null) return
    const sync = (): void => {
      setOverflow(viewport.scrollWidth > viewport.clientWidth + 1)
      viewport.scrollLeft = viewport.scrollWidth
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(viewport)
    if (lineRef.current) observer.observe(lineRef.current)
    return () => observer.disconnect()
  }, [summaryKey, summaryText])

  // 展开态默认吸底跟随最新思考;用户主动上滚离底后暂停,滚回底部恢复
  useLayoutEffect(() => {
    if (!open) {
      followBottomRef.current = true
      return
    }
    const body = bodyRef.current
    if (body && followBottomRef.current) body.scrollTop = body.scrollHeight
  }, [open, text])

  function onBodyScroll(): void {
    const body = bodyRef.current
    if (!body) return
    followBottomRef.current = body.scrollHeight - body.clientHeight - body.scrollTop <= BOTTOM_LOCK_PX
  }

  const doneSecs = elapsedMs != null ? Math.max(1, Math.round(elapsedMs / 1000)) : null
  let label: ReactNode
  if (live && !open) label = <span className="reasoning-thinking">{t('reasoning.thinking')}</span>
  else if (live) label = t('reasoning.live', { secs })
  else if (doneSecs != null) label = t('reasoning.done', { secs: doneSecs })
  else label = t('reasoning.fallback')

  return (
    <div className={`reasoning${live ? ' live' : ''}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="reasoning-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Brain size={12} />
        <span className="reasoning-label">{label}</span>
        {summary && (
          <>
            <span className="reasoning-dot">·</span>
            <span ref={viewportRef} className="reasoning-line" data-overflow={overflow || undefined}>
              <span key={summary.key} ref={lineRef} className="reasoning-line-text">
                {summary.text}
              </span>
            </span>
          </>
        )}
        <ChevronRight size={12} className="reasoning-chevron" />
      </button>
      {open && (
        <div ref={bodyRef} className="reasoning-body" data-quote-source="reasoning" onScroll={onBodyScroll}>
          {text}
        </div>
      )}
    </div>
  )
}
