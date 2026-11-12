import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, ExternalLink, Quote } from 'lucide-react'
import type { QuoteKind } from '@shared/types'
import { isQuoteKind, QUOTE_LIMITS } from '@shared/quote-core'
import { isLocalPathText, resolveWorkspacePath } from '@shared/md-autolink-core'
import { copyText } from '../../utils/clipboard'
import { openFileSmart } from '../../utils/open-file'
import { useTranslation } from '../../i18n'

// 选区引用浮窗(2026-11-02):在聊天视图根挂监听,选中对话正文(带 data-quote-source 的容器)
// 弹「引用/复制」菜单,portal 到 body。守卫与坑清单移植自 fi 0.6 / ZCode 原版:
// - mouseup/touchend → setTimeout(0) 防抖,刻意不用 rAF(Electron 窗口被完全遮挡时
//   rAF 不触发、菜单永不弹;setTimeout 在隐藏页只是被节流仍会执行,fi 踩过)
// - 起止端点须落在同一个 data-quote-source 容器内(跨气泡拖选不弹)
// - 端点落在控件里不弹(按钮/输入框/菜单自身的文字不算对话正文)
// - 菜单 onPointerDown/onMouseDown preventDefault:点按钮不能让浏览器把选区折叠掉
// - Escape/选区塌掉/任意滚动/resize 关菜单;Escape 走 capture+stopPropagation,
//   不漏给审批面板的四档键盘(Escape=拒绝)
// - 超单条上限的选区弹只读提示而非静默消失

/** 选区端点落在这些控件里就不算正文选区(contenteditable 即输入框本体) */
const EXCLUDED_SELECTOR = [
  'button',
  'input',
  'textarea',
  'select',
  '[contenteditable]',
  '[role="button"]',
  '[data-quote-menu]'
].join(',')

export interface QuoteCandidate {
  text: string
  kind: QuoteKind
  /** 群聊里谁说的(data-quote-bot 容器才有;单聊空) */
  botName?: string
}

interface SelectionRect {
  center: number
  top: number
  bottom: number
}

type MenuSnapshot = ({ error: null } & QuoteCandidate & SelectionRect) | ({ error: 'single' } & SelectionRect)

/** 把当前 Selection 解析成菜单快照:null=不弹;single=超长提示;否则带选区矩形与文本/来源 */
function inspectSelection(rootEl: HTMLElement | null): MenuSnapshot | null {
  if (!rootEl || !rootEl.isConnected) return null
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  const startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer?.parentElement ?? null
  const endElement = range.endContainer instanceof Element ? range.endContainer : range.endContainer?.parentElement ?? null
  if (!startElement || !endElement) return null
  // 控件门禁只看两个端点:克隆整段 Range 会把 DOM 顺序里夹着的装饰性控件一并带上,
  // 据此判断会把合法正文误判成控件选区(fi 踩过的口径)
  if (startElement.closest(EXCLUDED_SELECTOR) || endElement.closest(EXCLUDED_SELECTOR)) return null
  const startSource = startElement.closest('[data-quote-source]')
  const endSource = endElement.closest('[data-quote-source]')
  // 同一容器守卫:跨气泡拖选不弹(引用语境会错乱);容器须在本视图内(侧栏等处选字不弹)
  if (!startSource || startSource !== endSource || !rootEl.contains(startSource)) return null
  const kind = startSource.getAttribute('data-quote-source')
  if (!isQuoteKind(kind)) return null
  const text = selection.toString().trim()
  if (!text) return null
  const rect = range.getBoundingClientRect()
  if (!(rect.width > 0 || rect.height > 0)) return null
  const position = { center: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom }
  if (text.length > QUOTE_LIMITS.single) return { error: 'single', ...position }
  const botName = startSource.getAttribute('data-quote-bot') ?? undefined
  return { error: null, text, kind, botName, ...position }
}

/** 菜单定位:选区上方 8px 优先、放不下放下方、左右 clamp 到视口 12px 边距,随自身尺寸重算 */
function positionMenu(menu: HTMLElement, snap: SelectionRect): void {
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(12, Math.min(window.innerWidth - rect.width - 12, snap.center - rect.width / 2))}px`
  const preferredTop = snap.top - rect.height - 8 >= 12 ? snap.top - rect.height - 8 : snap.bottom + 8
  menu.style.top = `${Math.max(12, Math.min(window.innerHeight - rect.height - 12, preferredTop))}px`
}

export function QuoteSelection({
  rootRef,
  resolveBase,
  onAdd
}: {
  /** 聊天视图根:选区须落在它内部才弹菜单 */
  rootRef: RefObject<HTMLElement | null>
  /** 工作区基准(2026-11-06 后缀规则):选中相对路径(产出/xxx.md)时「打开」按它解析;缺省只认绝对形态 */
  resolveBase?: string | null
  onAdd(candidate: QuoteCandidate): void
}) {
  const { t } = useTranslation()
  const [snap, setSnap] = useState<MenuSnapshot | null>(null)
  const [copied, setCopied] = useState(false)
  const timerRef = useRef(0)
  const copiedTimerRef = useRef(0)
  const snapRef = useRef<MenuSnapshot | null>(null)

  const close = useCallback(() => {
    window.clearTimeout(timerRef.current)
    window.clearTimeout(copiedTimerRef.current)
    setCopied(false)
    setSnap(null)
  }, [])

  useEffect(() => {
    snapRef.current = snap
  }, [snap])

  useEffect(() => {
    const schedule = () => {
      window.clearTimeout(timerRef.current)
      // setTimeout(0) 而非 rAF:窗口被遮挡时 rAF 完全不触发(Electron occlusion),菜单会永不弹出
      timerRef.current = window.setTimeout(() => {
        setSnap(inspectSelection(rootRef.current))
      }, 0)
    }
    const onSelectionChange = () => {
      if (document.getSelection()?.isCollapsed ?? true) close()
    }
    // Escape 捕获且拦截:菜单开着时不漏给审批面板(Escape=拒绝)/其他全局快捷键
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (snapRef.current !== null && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('mouseup', schedule)
    document.addEventListener('touchend', schedule, { passive: true })
    document.addEventListener('keyup', schedule)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('scroll', close, { passive: true, capture: true })
    document.addEventListener('keydown', onKeyDownCapture, true)
    window.addEventListener('resize', close)
    return () => {
      window.clearTimeout(timerRef.current)
      window.clearTimeout(copiedTimerRef.current)
      document.removeEventListener('mouseup', schedule)
      document.removeEventListener('touchend', schedule)
      document.removeEventListener('keyup', schedule)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', onKeyDownCapture, true)
      window.removeEventListener('resize', close)
    }
  }, [rootRef, close])

  const menuRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu || !snap) return
    const position = () => positionMenu(menu, snap)
    position()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position)
    observer?.observe(menu)
    return () => observer?.disconnect()
  }, [snap])

  if (!snap) return null
  // 捕获为局部常量:函数声明提升使外层早退的收窄进不了闭包,显式定值后 TS 可收窄
  const current = snap
  // 选区恰好是本机路径时才亮「打开」键(前缀/后缀多一个字都不算);相对路径按视图给的基准解析,
  // 解析不出(无基准)则不亮键——不产点了没反应的按钮
  const openTarget =
    current.error === null ? resolveWorkspacePath(resolveBase ?? null, isLocalPathText(current.text) ?? '') : null

  function onCopy(): void {
    if (current.error !== null) return
    void copyText(current.text).then(() => {
      setCopied(true)
      // 复制反馈亮 1.2s 后收起(期间选区保留,可接着点引用)
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(close, 1200)
    })
  }

  function onQuote(): void {
    if (current.error !== null) return
    onAdd({ text: current.text, kind: current.kind, botName: current.botName })
    close()
  }

  return createPortal(
    <div
      ref={menuRef}
      className="quote-menu"
      data-quote-menu=""
      style={{ left: 12, top: 12 }}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
    >
      {current.error === 'single' ? (
        <div className="quote-menu-note">{t('quote.limitSingle')}</div>
      ) : (
        <>
          <button type="button" className="quote-menu-btn" onClick={onQuote}>
            <Quote size={13} />
            {t('quote.action')}
          </button>
          <button type="button" className="quote-menu-btn" onClick={onCopy}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? t('quote.copied') : t('quote.copy')}
          </button>
          {openTarget && (
            // 选区恰好是一个本机路径(2026-11-06 方案 B):加「打开」键,.md 进阅读器其余系统打开
            <button
              type="button"
              className="quote-menu-btn"
              onClick={() => {
                void openFileSmart(openTarget)
                close()
              }}
            >
              <ExternalLink size={13} />
              {t('quote.openFile')}
            </button>
          )}
        </>
      )}
    </div>,
    document.body
  )
}
