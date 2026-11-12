import { useEffect, useState } from 'react'
import { Mail, MessageCircle, Settings, Sparkles } from 'lucide-react'
import { api, onWindowMaximized } from '../api'
import { useTranslation } from '../i18n'

/** 导航栏视图(2026-10-28 左侧导航栏方案):消息 = 既有消息界面;邮局 = 岛际信件;技能中心 = 技能货架与管理;设置 = 内嵌设置面板 */
export type RailView = 'messages' | 'post' | 'skills' | 'settings'

/** Windows 自绘窗口三键(2026-11-04 方案 C,Felix 拍板):frame:false + 左上 ─ □ ×,与 Mac 红绿灯同位
 *  (84px 导航栏顶部 38px 区);Windows 风格图标(三色圆点在 Windows 违和),关闭键 hover 红底。
 *  □/❐ 随最大化状态切换(主进程 EV 广播 + 挂载时查询)。登录屏无 NavRail,由 App 另挂 fixed 副本。 */
export function WinControls() {
  const { t } = useTranslation()
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    void api.windowIsMaximized().then(setMaximized).catch(console.error)
    return onWindowMaximized(setMaximized)
  }, [])
  return (
    <div className="rail-traffic win-controls">
      <button
        className="win-ctrl"
        title={t('win.minimize')}
        aria-label={t('win.minimize')}
        onClick={() => void api.windowMinimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        className="win-ctrl"
        title={maximized ? t('win.restore') : t('win.maximize')}
        aria-label={maximized ? t('win.restore') : t('win.maximize')}
        onClick={() => void api.windowToggleMaximize()}
      >
        {maximized ? (
          // 还原态 ❐:前小后大双矩形
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="2.5" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1" />
            <path d="M3 2.5 V1 H9.5 V7.5 H8" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        className="win-ctrl win-ctrl-close"
        title={t('win.close')}
        aria-label={t('win.close')}
        onClick={() => void api.windowClose()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  )
}

// 主界面最左侧 84px 窄导航栏:顶部窗口控制区(Mac=系统红绿灯/Windows=自绘三键,同位同高度)
// → 消息 / 邮局 / 技能中心(本期占位)→ 沉底设置。
// 栏内空白是窗口拖拽区(styles.css),按钮已显式 no-drag。
export default function NavRail({
  view,
  onSelect,
  updateBadge,
  postBadge
}: {
  view: RailView
  onSelect: (view: RailView) => void
  /** 设置按钮上的新版本红点(原侧栏底部齿轮红点随设置入口一并迁入) */
  updateBadge: boolean
  /** 邮局按钮上的未读信件红点(带数字) */
  postBadge: number
}) {
  const { t } = useTranslation()
  const isWin = window.archipelago.platform === 'win32'
  return (
    <nav className="nav-rail" aria-label={t('nav.main')}>
      {isWin ? <WinControls /> : <div className="rail-traffic" aria-hidden="true" />}
      <button
        className={`rail-btn ${view === 'messages' ? 'active' : ''}`}
        title={t('nav.messages')}
        aria-current={view === 'messages' ? 'true' : 'false'}
        onClick={() => onSelect('messages')}
      >
        <MessageCircle size={20} />
      </button>
      <button
        className={`rail-btn ${view === 'post' ? 'active' : ''}`}
        title={t('nav.post')}
        aria-current={view === 'post' ? 'true' : 'false'}
        onClick={() => onSelect('post')}
      >
        <Mail size={20} />
        {postBadge > 0 && (
          <span className="update-dot post-dot" title={t('nav.unreadLetters', { count: postBadge })}>
            {postBadge > 99 ? '99+' : postBadge}
          </span>
        )}
      </button>
      {/* 技能中心(2026-11-05 二期点亮):精选推荐货架 + 岛上技能管理 */}
      <button
        className={`rail-btn ${view === 'skills' ? 'active' : ''}`}
        title={t('nav.skills')}
        aria-current={view === 'skills' ? 'true' : 'false'}
        onClick={() => onSelect('skills')}
      >
        <Sparkles size={20} />
      </button>
      <div className="rail-spacer" aria-hidden="true" />
      <button
        className={`rail-btn ${view === 'settings' ? 'active' : ''}`}
        title={t('nav.settings')}
        aria-current={view === 'settings' ? 'true' : 'false'}
        onClick={() => onSelect('settings')}
      >
        <Settings size={20} />
        {updateBadge && <span className="update-dot" title={t('nav.newVersion')} />}
      </button>
    </nav>
  )
}
