import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, RefreshCw, ExternalLink, FileWarning } from 'lucide-react'
import type { MdTextReadResult } from '@shared/types'
import { crumbSegments } from '@shared/md-reader-core'
import { api, onMdReaderLoad } from '../api'
import { useTranslation } from '../i18n'
import { Markdown } from '../components/markdown/Markdown'
import { WinControls } from '../components/NavRail'
import { formatStamp } from '../utils/time'

/** 读取结果三态:加载中(含切换文件)/失败(reason 查词典)/成功 */
type ReadState =
  | { kind: 'loading'; path: string }
  | { kind: 'error'; path: string; reason: Extract<MdTextReadResult, { ok: false }>['reason'] }
  | { kind: 'ok'; path: string; content: string; size: number; mtimeMs: number }

const isWin = window.archipelago.platform === 'win32'

/** 字节数展示:KB 一位小数,不足 1KB 用字节(档案「文件」页签同口径) */
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  return `${(size / 1024).toFixed(1)} KB`
}

/** 读失败 reason → 词典 key(MarkdownImage.failTextKey 同款 switch 静态映射) */
function errorTextKey(reason: Extract<MdTextReadResult, { ok: false }>['reason']): string {
  switch (reason) {
    case 'not-found':
      return 'mdreader.err.notFound'
    case 'no-access':
      return 'mdreader.err.noAccess'
    case 'too-large':
      return 'mdreader.err.tooLarge'
    case 'binary':
      return 'mdreader.err.binary'
    case 'not-md':
      return 'mdreader.err.notMd'
    case 'read-error':
      return 'mdreader.err.readError'
    default:
      return 'mdreader.err.badPath'
  }
}

// 内置 Markdown 阅读器(2026-11-06 拍板:独立窗口 + 纯只读 + 只预览单态)。
// 打开时读盘一次即快照(D3:不 watch,状态条手动刷新);窗口壳对齐主窗口规格
// (Mac 红绿灯 / Windows 自绘三键同位);正文渲染复用聊天的 Markdown 组件,所见与气泡一致。
export default function MdReaderApp() {
  const { t } = useTranslation()
  const [state, setState] = useState<ReadState>({ kind: 'loading', path: '' })
  // 连续切换文件时的过期读丢弃:只认最后一次发起的读
  const generationRef = useRef(0)
  const crumbsRef = useRef<HTMLDivElement>(null)

  const load = useCallback((path: string) => {
    const gen = ++generationRef.current
    setState({ kind: 'loading', path })
    void api.filesReadText(path).then(
      (result) => {
        if (gen !== generationRef.current) return
        setState(
          result.ok
            ? { kind: 'ok', path, content: result.content, size: result.size, mtimeMs: result.mtimeMs }
            : { kind: 'error', path, reason: result.reason }
        )
      },
      // IPC 层 rejection(2026-11-06 codex 审查修复:桥断等罕见情形):进错误态并留重试,
      // 不留悬挂 promise 卡「读取中」
      () => {
        if (gen !== generationRef.current) return
        setState({ kind: 'error', path, reason: 'read-error' })
      }
    )
  }, [])

  useEffect(() => onMdReaderLoad((e) => load(e.path)), [load])

  // 长路径初始滚到最右(ZCode 同款细节):用户最关心末尾的文件名
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = crumbsRef.current
      if (el) el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
    })
    return () => cancelAnimationFrame(frame)
  }, [state.path])

  const crumbs = crumbSegments(state.path)

  return (
    <div className="mdr-window">
      <header className="mdr-titlebar">
        {isWin ? (
          <WinControls />
        ) : (
          // Mac 红绿灯占位(trafficLightPosition x:11 y:14,与主窗口同位)
          <div className="mdr-traffic-spacer" />
        )}
        <div className="mdr-crumbs" ref={crumbsRef}>
          {crumbs.map((seg, i) => {
            const last = i === crumbs.length - 1
            return (
              <span key={`${seg}-${i}`} className={`mdr-crumb${last ? ' leaf' : ''}`}>
                {seg}
                {!last && <span className="mdr-crumb-sep">›</span>}
              </span>
            )
          })}
        </div>
      </header>

      <main className="mdr-body">
        {state.kind === 'loading' && <div className="mdr-hint">{t('mdreader.loading')}</div>}
        {state.kind === 'error' && (
          <div className="mdr-error">
            <FileWarning size={22} />
            <p>{t(errorTextKey(state.reason))}</p>
            <button type="button" className="mdr-btn" onClick={() => load(state.path)}>
              <RefreshCw size={13} />
              {t('mdreader.retry')}
            </button>
          </div>
        )}
        {state.kind === 'ok' &&
          (state.content.length === 0 ? (
            <div className="mdr-hint">{t('mdreader.empty')}</div>
          ) : (
            <div className="mdr-pad">
              <Markdown content={state.content} />
            </div>
          ))}
      </main>

      <footer className="mdr-statusbar">
        <span>
          {state.kind === 'ok' && state.content.length > 0
            ? `${formatBytes(state.size)} · ${t('mdreader.modified')} ${formatStamp(new Date(state.mtimeMs).toISOString())} · UTF-8`
            : t('mdreader.readonly')}
        </span>
        <span className="mdr-status-actions">
          <button
            type="button"
            className="mdr-btn"
            title={t('mdreader.refreshTip')}
            disabled={state.path === ''}
            onClick={() => load(state.path)}
          >
            <RefreshCw size={13} />
            {t('mdreader.refresh')}
          </button>
          <button
            type="button"
            className="mdr-btn"
            disabled={state.path === ''}
            onClick={() => void api.revealInFolder(state.path)}
          >
            <FolderOpen size={13} />
            {t('mdreader.reveal')}
          </button>
          <button
            type="button"
            className="mdr-btn"
            disabled={state.path === ''}
            onClick={() => void api.openPath(state.path)}
          >
            <ExternalLink size={13} />
            {t('mdreader.openExternal')}
          </button>
        </span>
      </footer>
    </div>
  )
}
