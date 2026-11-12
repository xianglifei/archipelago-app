import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, RefreshCw, ExternalLink, FileWarning, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import type { ImageFullReadResult } from '@shared/types'
import { crumbSegments } from '@shared/md-reader-core'
import { fitScalePercent, zoomStepIn, zoomStepOut } from '@shared/img-viewer-core'
import { api, onImgViewerLoad } from '../api'
import { useTranslation } from '../i18n'
import { WinControls } from '../components/NavRail'

/** 读取结果三态:加载中(含切换图片)/失败(reason 查词典)/成功。
 *  read-error 是渲染层本地补的 IPC rejection 态(主进程结果联合里没有),见 load 的 reject 分支 */
type ImgViewerFailReason = Extract<ImageFullReadResult, { ok: false }>['reason'] | 'read-error'
type ReadState =
  | { kind: 'loading'; path: string }
  | { kind: 'error'; path: string; reason: ImgViewerFailReason }
  | { kind: 'ok'; path: string; dataUrl: string; size: number }

/** 缩放两态:适应窗口(跟随画布尺寸重算)/定值百分比(窗口变化不重算) */
type ZoomState = { mode: 'fit' } | { mode: 'pct'; pct: number }

const isWin = window.archipelago.platform === 'win32'

/** 字节数展示:KB/MB 一位小数(图片常以 MB 计;md 阅读器的小文件口径 ceil KB 不适用) */
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** 读失败 reason → 词典 key(MdReaderApp.errorTextKey 同款 switch 静态映射) */
function errorTextKey(reason: ImgViewerFailReason): string {
  switch (reason) {
    case 'read-error':
      return 'imgviewer.err.readError'
    case 'not-found':
      return 'imgviewer.err.notFound'
    case 'no-access':
      return 'imgviewer.err.noAccess'
    case 'not-image':
      return 'imgviewer.err.notImage'
    case 'too-large':
      return 'imgviewer.err.tooLarge'
    default:
      return 'imgviewer.err.badPath'
  }
}

// 内置图片查看器(2026-11-06 拍板:独立单例窗 + 原样字节原图 + 适应窗口默认)。
// 壳对齐 md 阅读器(红绿灯位/面包屑/状态栏);画布棋盘格底(透明 PNG 边界诚实),
// 缩放=适应窗口默认 + 状态栏缩放键(超界原生滚动);「用系统应用打开」逃生舱常驻。
export default function ImgViewerApp() {
  const { t } = useTranslation()
  const [state, setState] = useState<ReadState>({ kind: 'loading', path: '' })
  const [natDims, setNatDims] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState<ZoomState>({ mode: 'fit' })
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null)
  // 连续切换图片时的过期读丢弃:只认最后一次发起的读
  const generationRef = useRef(0)
  const canvasRef = useRef<HTMLDivElement>(null)
  const crumbsRef = useRef<HTMLDivElement>(null)

  const load = useCallback((path: string) => {
    const gen = ++generationRef.current
    setState({ kind: 'loading', path })
    setNatDims(null)
    setZoom({ mode: 'fit' })
    void api.imageReadFull(path).then(
      (result) => {
        if (gen !== generationRef.current) return
        setState(
          result.ok
            ? { kind: 'ok', path, dataUrl: result.dataUrl, size: result.size }
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

  useEffect(() => onImgViewerLoad((e) => load(e.path)), [load])

  // 画布尺寸跟随窗口(适应模式的重算依据);ResizeObserver 比 window resize 稳(状态栏换行等内部变化也触发)
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setCanvasSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 长路径初始滚到最右(md-reader 同款细节):用户最关心末尾的文件名
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = crumbsRef.current
      if (el) el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
    })
    return () => cancelAnimationFrame(frame)
  }, [state.path])

  // 当前生效的显示百分比(适应=按画布重算;定值=直取),图片未就绪时不给值
  const displayPct =
    state.kind !== 'ok' || !natDims || !canvasSize
      ? null
      : zoom.mode === 'fit'
        ? fitScalePercent(natDims.w, natDims.h, canvasSize.w - 16, canvasSize.h - 16)
        : zoom.pct

  // 换图时滚回左上(适应模式天然满幅;定值大图的滚动位置不该继承上一张)
  useEffect(() => {
    const el = canvasRef.current
    if (el) {
      el.scrollTop = 0
      el.scrollLeft = 0
    }
  }, [state.path])

  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      if (displayPct == null) return
      setZoom({ mode: 'pct', pct: dir === 1 ? zoomStepIn(displayPct) : zoomStepOut(displayPct) })
    },
    [displayPct]
  )

  const ok = state.kind === 'ok' && natDims !== null
  const ext = ok ? (state.path.split('.').pop()?.toUpperCase() ?? '') : ''
  const shownPct = displayPct ?? 100
  // 定宽高渲染(等比):显式 width/height 防极长图把画布撑爆;适应模式由 fitScalePercent 钳制
  const imgStyle =
    ok && displayPct != null
      ? { width: `${Math.round((natDims!.w * displayPct) / 100)}px`, height: `${Math.round((natDims!.h * displayPct) / 100)}px` }
      : undefined

  const crumbs = crumbSegments(state.path)

  return (
    <div className="iv-window">
      <header className="iv-titlebar">
        {isWin ? (
          <WinControls />
        ) : (
          // Mac 红绿灯占位(trafficLightPosition x:11 y:14,与主窗口同位)
          <div className="iv-traffic-spacer" />
        )}
        <div className="iv-crumbs" ref={crumbsRef}>
          {crumbs.map((seg, i) => {
            const last = i === crumbs.length - 1
            return (
              <span key={`${seg}-${i}`} className={`iv-crumb${last ? ' leaf' : ''}`}>
                {seg}
                {!last && <span className="iv-crumb-sep">›</span>}
              </span>
            )
          })}
        </div>
      </header>

      <main className="iv-canvas" ref={canvasRef}>
        {state.kind === 'loading' && <div className="iv-hint">{t('imgviewer.loading')}</div>}
        {state.kind === 'error' && (
          <div className="iv-error">
            <FileWarning size={22} />
            <p>{t(errorTextKey(state.reason))}</p>
            <button type="button" className="iv-btn" onClick={() => load(state.path)}>
              <RefreshCw size={13} />
              {t('imgviewer.retry')}
            </button>
          </div>
        )}
        {state.kind === 'ok' && natDims === null && (
          /* 隐藏探针:先解码拿 naturalWidth/Height(顺带探出损坏文件 onError),拿到前显示读图态不做满幅闪现 */
          <img
            src={state.dataUrl}
            alt=""
            className="iv-probe"
            onLoad={(e) => {
              const el = e.currentTarget
              if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                setNatDims({ w: el.naturalWidth, h: el.naturalHeight })
              }
            }}
            onError={() => {
              setState((s) => (s.kind === 'ok' ? { kind: 'error', path: s.path, reason: 'not-image' } : s))
            }}
          />
        )}
        {state.kind === 'ok' && natDims === null && <div className="iv-hint">{t('imgviewer.loading')}</div>}
        {state.kind === 'ok' && natDims !== null && (
          <div className="iv-inner">
            <img src={state.dataUrl} alt={crumbs[crumbs.length - 1] ?? ''} style={imgStyle} draggable={false} />
          </div>
        )}
      </main>

      <footer className="iv-statusbar">
        <span>
          {ok
            ? `${natDims!.w} × ${natDims!.h} · ${ext} · ${formatBytes(state.kind === 'ok' ? state.size : 0)} · ${shownPct}%`
            : t('imgviewer.readonly')}
        </span>
        <span className="iv-status-actions">
          <span className="iv-zoom">
            <button
              type="button"
              title={t('imgviewer.zoomOut')}
              aria-label={t('imgviewer.zoomOut')}
              disabled={!ok}
              onClick={() => stepZoom(-1)}
            >
              <ZoomOut size={13} />
            </button>
            <button
              type="button"
              className="iv-zoom-pct"
              title={t('imgviewer.fitTip')}
              disabled={!ok}
              onClick={() => setZoom({ mode: 'fit' })}
            >
              {shownPct}%
            </button>
            <button
              type="button"
              title={t('imgviewer.zoomIn')}
              aria-label={t('imgviewer.zoomIn')}
              disabled={!ok}
              onClick={() => stepZoom(1)}
            >
              <ZoomIn size={13} />
            </button>
          </span>
          <button
            type="button"
            className="iv-btn"
            title={t('imgviewer.fitTip')}
            disabled={!ok}
            onClick={() => setZoom({ mode: 'fit' })}
          >
            <Maximize2 size={12} />
            {t('imgviewer.fit')}
          </button>
          <button type="button" className="iv-btn" disabled={!ok} onClick={() => setZoom({ mode: 'pct', pct: 100 })}>
            100%
          </button>
          <button
            type="button"
            className="iv-btn"
            title={t('imgviewer.refreshTip')}
            disabled={state.path === ''}
            onClick={() => load(state.path)}
          >
            <RefreshCw size={13} />
            {t('imgviewer.refresh')}
          </button>
          <button
            type="button"
            className="iv-btn"
            disabled={state.path === ''}
            onClick={() => void api.revealInFolder(state.path)}
          >
            <FolderOpen size={13} />
            {t('imgviewer.reveal')}
          </button>
          <button
            type="button"
            className="iv-btn"
            disabled={state.path === ''}
            onClick={() => void api.openPath(state.path)}
          >
            <ExternalLink size={13} />
            {t('imgviewer.openExternal')}
          </button>
        </span>
      </footer>
    </div>
  )
}
