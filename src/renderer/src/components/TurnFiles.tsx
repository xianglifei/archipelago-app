import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, FolderOpen } from 'lucide-react'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { openFileSmart } from '../utils/open-file'
import {
  TURN_FILES_COLLAPSE,
  collectTurnFiles,
  sumTurnFileStats,
  type TurnFileEntry
} from '../utils/turn-files'
import type { TimelineItem } from '../utils/turn-display'

// 回合改动文件卡(2026-11-18 样式专项拍板:S3 极简头 + 行尾「打开 ▾」分裂胶囊 + 统计槽 +N −N):
// 挂在回合正文气泡之后(静默回信组同款),卡宽与消息列一致(.msg assistant 包裹)。
// 头部 = chevron 折整卡 + 「改动文件 · N」+ 右侧合计增删(全 0 不渲染数字槽——旧数据没有就不造假);
// 行 = 文件名(600)/目录(灰)+ 该文件 +N −N + 打开▾(主区=默认程序,▾=菜单:其他应用程序(mac)/在 Finder 显示);
// 折叠 = 列表超 5 行收成「其余 N 个」,整条热区(D3);行点击 = 打开,失败行内红字 3 秒自清。

interface MenuState {
  path: string
  x: number
  y: number
}

export function TurnFiles({ timeline }: { timeline: TimelineItem[] }) {
  const { t } = useTranslation()
  const entries = useMemo(() => collectTurnFiles(timeline), [timeline])
  const [open, setOpen] = useState(false) // 默认折叠(2026-11-18 走查拍板):只露头部条,点击展开清单
  const [expanded, setExpanded] = useState(false)
  const [openErr, setOpenErr] = useState<{ path: string; text: string } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [apps, setApps] = useState<string[]>([])

  const totals = useMemo(() => sumTurnFileStats(entries), [entries])
  const foldable = entries.length > TURN_FILES_COLLAPSE
  const visible = foldable && !expanded ? entries.slice(0, TURN_FILES_COLLAPSE) : entries

  // 应用候选懒加载:菜单第一次打开才拉(macOS 才有名单;空数组=非 mac,隐藏「其他应用程序…」项)
  useEffect(() => {
    if (!menu || apps.length > 0) return
    let alive = true
    void api
      .openWithApps()
      .then((list) => {
        if (alive) setApps(list)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [menu, apps.length])

  // 菜单外点击 / Esc 关闭(caret 按钮自带 stopPropagation,重开不会被本监听立即收走)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', esc)
    }
  }, [menu])

  if (entries.length === 0) return null

  async function openEntry(entry: TurnFileEntry): Promise<void> {
    const err = await openFileSmart(entry.path)
    if (err) {
      setOpenErr({ path: entry.path, text: err })
      setTimeout(() => setOpenErr((cur) => (cur && cur.path === entry.path ? null : cur)), 3000)
    } else {
      setOpenErr(null)
    }
  }

  async function openWith(entry: TurnFileEntry, app: string): Promise<void> {
    const err = await api.openWithApp(entry.path, app)
    if (err) {
      setOpenErr({ path: entry.path, text: err })
      setTimeout(() => setOpenErr((cur) => (cur && cur.path === entry.path ? null : cur)), 3000)
    }
  }

  const stats = (value: { add: number; del: number }): ReactNode => {
    if (value.add <= 0 && value.del <= 0) return null
    return (
      <span className="turn-files-stat">
        {value.add > 0 && <span className="add">+{value.add}</span>}
        {value.del > 0 && <span className="del">−{value.del}</span>}
      </span>
    )
  }

  return (
    <div className="turn-files">
      <button
        type="button"
        className="turn-files-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight size={12} className="turn-files-chevron" data-open={open || undefined} />
        <span className="turn-files-title">{t('chat.turnFiles.title', { count: entries.length })}</span>
        {stats(totals)}
      </button>
      {open && (
        <>
          <div className="turn-files-list">
            {visible.map((entry) => (
              <div
                key={entry.path}
                className={`turn-file-row${openErr && openErr.path === entry.path ? ' failed' : ''}`}
                role="button"
                tabIndex={0}
                title={entry.path}
                onClick={() => void openEntry(entry)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void openEntry(entry)
                  }
                }}
              >
                <span className="turn-file-name">{entry.fileName}</span>
                {entry.dirName && <span className="turn-file-dir">{entry.dirName}</span>}
                {stats(entry)}
                <span
                  className="turn-files-split"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <button type="button" className="t" onClick={() => void openEntry(entry)}>
                    {t('chat.turnFiles.open')}
                  </button>
                  <button
                    type="button"
                    className="c"
                    aria-label={t('chat.turnFiles.openMenu')}
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenu({ path: entry.path, x: e.clientX, y: e.clientY })
                    }}
                  >
                    <ChevronDown size={10} />
                  </button>
                </span>
              </div>
            ))}
            {openErr && (
              <div className="turn-files-error" role="status">
                {openErr.text}
              </div>
            )}
          </div>
          {foldable && (
            <button type="button" className="turn-files-fold" onClick={() => setExpanded((v) => !v)}>
              <span>
                {expanded
                  ? t('chat.turnFiles.collapse')
                  : t('chat.turnFiles.more', { count: entries.length - visible.length })}
              </span>
              <ChevronDown size={11} className={expanded ? 'up' : undefined} />
            </button>
          )}
        </>
      )}
      {menu && (
        <div
          className="turn-files-menu"
          role="menu"
          style={{ left: Math.max(8, menu.x - 150), top: menu.y + 6 }}
          onClick={(e) => e.stopPropagation()}
        >
          {apps.length > 0 && (
            <>
              <div className="turn-files-menu-label">{t('chat.turnFiles.openWithLabel')}</div>
              <div className="turn-files-menu-apps">
                {apps.map((app) => (
                  <button
                    key={app}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const entry = entries.find((e) => e.path === menu.path)
                      setMenu(null)
                      if (entry) void openWith(entry, app)
                    }}
                  >
                    <ExternalLink size={12} />
                    <span>{app}</span>
                  </button>
                ))}
              </div>
              <div className="turn-files-menu-sep" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null)
              void api.revealInFolder(menu.path)
            }}
          >
            <FolderOpen size={12} />
            <span>{t('chat.turnFiles.reveal')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
