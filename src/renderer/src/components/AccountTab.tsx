import { useEffect, useState } from 'react'
import { CircleHelp, Laptop, Loader2, LogOut } from 'lucide-react'
import type { SeaSessionState } from '@shared/types'
import { api, onAuthChanged } from '../api'
import { useTranslation } from '../i18n'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fmtSeen(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 设置「账号」页签(0.8 登录门口径):纯管理页——登录表单已由整屏登录门接管,
 * 这里只服务登录态(账号邮箱、设备列表、退出登录=全局锁)。第二期追加积分/兑换码/订阅。
 * 与岛务页的互联:本机卡提供「编辑本岛信息」入口跳岛务页签。
 */
export default function AccountTab({ onGoIsland }: { onGoIsland: () => void }) {
  const { t } = useTranslation()
  const [state, setState] = useState<SeaSessionState | null | 'loading'>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // 缓存优先(0.9.2 自走查 A5):先渲染本地 session 文件里的账号与设备(零网络,立即有数),
    // 后台 authRefresh 拉新回来原地静默换新;「加载中」只剩本地也无态的冷启动兜底
    api
      .authState()
      .then((s) => {
        if (s) setState(s)
      })
      .catch(() => {})
    api
      .authRefresh()
      .then((s) => setState(s ?? null))
      .catch(() => setState((cur) => (cur === 'loading' ? null : cur)))
    return onAuthChanged((e) => setState(e.state ?? null))
  }, [])

  if (state === 'loading') return <p className="modal-lead">{t('common.loading')}</p>
  // 正常流程不可达(能打开设置必已过登录门);兜底显示提示而非表单
  if (!state) return <p className="modal-lead">{t('account.lostSession')}</p>

  async function logout(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api.authLogout()
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }

  return (
    <div className="account-tab">
      {/* 账号卡(2026-10-26 评审升级为卡;2026-11-09 退出登录收进卡右侧,底部行撤) */}
      <div className="account-hero">
        <span className="account-hero-avatar">{state.account.email.slice(0, 1).toUpperCase()}</span>
        <div className="account-hero-who">
          <b>{state.account.email}</b>
          <span>{t('account.heroSub')}</span>
        </div>
        <button className="btn ghost account-logout" disabled={busy} onClick={() => void logout()}>
          {busy ? <Loader2 size={14} className="spin" /> : <LogOut size={14} />}
          {busy ? t('account.loggingOut') : t('account.logout')}
        </button>
      </div>

      {/* 卡片化(2026-11-09):灰色标题裸背景,设备行合并一卡(发丝线分组);
          本机行不再整行染色,靠「本机」徽章+主色图标区分 */}
      <label className="field-label card-section-title">
        {t('account.devices')}
        <span
          className="qmark"
          data-tip={t('account.devicesHint')}
          tabIndex={0}
          aria-label={t('account.devicesHint')}
        >
          <CircleHelp size={13} />
        </span>
      </label>
      <div className="settings-card">
        {state.devices.map((d) => {
          const isLocal = d.id === state.localDeviceId
          return (
            <div key={d.id} className={`settings-card-row account-dev-row ${isLocal ? 'local' : ''}`}>
              <Laptop size={18} />
              <div className="account-dev-who">
                <b>
                  {d.name}
                  {isLocal && <span className="account-dev-badge">{t('account.thisDevice')}</span>}
                </b>
                <span>
                  {d.islands.length > 0
                    ? d.islands.map((i) => t('account.island', { name: i.name })).join(t('account.islandJoin'))
                    : t('account.noIslands')}
                  {' '}
                  {t('account.lastActive')} {fmtSeen(d.lastSeenAt)}
                </span>
              </div>
              {isLocal && (
                <button className="btn ghost sm account-dev-link" onClick={onGoIsland}>
                  {t('account.editIsland')}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {error && <div className="wizard-error">{error}</div>}
    </div>
  )
}
