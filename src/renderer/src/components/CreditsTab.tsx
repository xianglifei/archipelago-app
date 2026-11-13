import { useEffect, useRef, useState } from 'react'
import { CircleHelp, Coins, Loader2, RefreshCw } from 'lucide-react'
import type { CreditsSnapshot } from '@shared/types'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { i18nLang } from '../i18n/localized'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fmtMilli(milli: number): string {
  return (milli / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}
function fmtDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function sourceLabel(t: (k: string) => string, source: string): string {
  const map: Record<string, string> = {
    code: t('credits.srcCode'),
    signup: t('credits.srcSignup'),
    grant: t('credits.srcGrant'),
    campaign: t('credits.srcCampaign')
  }
  return map[source] ?? source
}

/**
 * 设置「套餐与积分」页签(四段式;2026-10-27 走查改版):
 * ① 余额 + 批次到期提示(低余额预警条) ② 兑换积分(默认按钮入口,点击展开)
 * ③ 近 7 天消耗(柱状图:从第一个有消耗的日子起显示、最右固定今天,零消耗的前置日期不占位)
 * ④ 获取记录(最底部,只展示获得——兑换/赠送/注册赠送;消耗记录不再混入)
 */
export default function CreditsTab({
  providerId,
  onOpenModelSource
}: {
  /** 当前模型来源(2026-11-13 BYOK):archipelago=群岛通道(积分计费),其余=自备 Key(不花积分) */
  providerId?: string
  onOpenModelSource?: () => void
}): React.ReactNode {
  const { t } = useTranslation()
  const [snap, setSnap] = useState<CreditsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  // 兑换码输入框:低余额「去充值」直达(滚动+聚焦)
  const codeRef = useRef<HTMLInputElement>(null)
  const [redeeming, setRedeeming] = useState(false)
  const [redeemOk, setRedeemOk] = useState<string | null>(null)
  // 手动刷新(截图评审 v6:余额旁给一粒刷新钮——聊完想立刻看花了多少)
  const [refreshing, setRefreshing] = useState(false)

  // quiet=true:后台静默拉新失败不报错——屏上已有缓存数据时不打扰(0.9.2 自走查 A5)
  const load = (force: boolean, quiet = false): void => {
    api
      .creditsGet(force)
      .then((s) => {
        setSnap(s)
        setError(null)
      })
      .catch((err) => {
        if (!quiet) setError(errMsg(err))
      })
  }

  function manualRefresh(): void {
    setRefreshing(true)
    api
      .creditsGet(true)
      .then((s) => {
        setSnap(s)
        setError(null)
      })
      .catch((err) => setError(errMsg(err)))
      .finally(() => setRefreshing(false))
  }

  useEffect(() => {
    // 缓存优先(截图评审 v6 收紧口径):只有「本会话内」的内存缓存可作首屏(命中秒开),
    // 重启/隔天不再吃旧数字——积分敏感,旧值先上屏再跳变落差大;无缓存时老老实实居中加载态
    load(false)
    load(true, true)
  }, [])

  async function redeem(): Promise<void> {
    const trimmed = code.trim().toUpperCase()
    if (!trimmed) return
    setRedeeming(true)
    setRedeemOk(null)
    setError(null)
    try {
      const result = await api.creditsRedeem(trimmed)
      setRedeemOk(
        t('credits.redeemOk', {
          amount: result.creditedCredits.toLocaleString(i18nLang()),
          days: result.grantDays
        })
      )
      setCode('')
      load(true)
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setRedeeming(false)
    }
  }

  // 冷启动/会话内缓存已过期:页面中间转圈加载(截图评审 v6:给个像样的加载态,不再左上角裸文字)
  if (!snap && !error) {
    return (
      <div className="credits-loading">
        <Loader2 size={18} className="spin" />
        {t('common.loading')}
      </div>
    )
  }
  if (!snap) return <p className="modal-lead">{error}</p>

  const balance = snap.balanceMilli
  // 自带 Key 下余额与「能不能聊」无关(2026-11-13 BYOK):低余额/用尽预警一律不顶,
  // 否则用户会以为自己的 Key 被余额卡住了。余额、兑换、获取记录照常保留——切回通道立刻要用。
  const byok = !!providerId && providerId !== 'archipelago'
  const low = !byok && balance > 0 && balance < 200_000 // <200 积分且未用尽
  const exhausted = !byok && balance <= 0
  // 到期提示取「还有余额且最先到期」的批次
  const activeBatches = snap.batches.filter((b) => b.remainingMilli > 0)
  const nearest = activeBatches.length
    ? activeBatches.reduce((a, b) => (a.expiresAt < b.expiresAt ? a : b))
    : null
  const nearestSum = nearest
    ? activeBatches.filter((b) => b.expiresAt === nearest.expiresAt).reduce((s, b) => s + b.remainingMilli, 0)
    : 0
  // 获取记录只展示获得(兑换/赠送/注册赠送),按时间倒序;
  // 消耗记录不混入(2026-10-27 走查改版:联网搜索等扣费行出现在"获取"里是错的)
  const recordRows = snap.batches
    .map((b, i) => ({
      key: `b${i}`,
      at: b.createdAt,
      amountMilli: b.amountMilli,
      expiresAt: b.expiresAt,
      label: sourceLabel(t, b.source)
    }))
    .sort((a, b) => b.at - a.at)
  // 近 7 天消耗:从第一个有消耗的日子起显示(前面零消耗的日期不占位),最右固定今天
  const daily = snap.daily ?? []
  const firstCostIdx = daily.findIndex((d) => d.costMilli > 0)
  const chartDays = firstCostIdx >= 0 ? daily.slice(firstCostIdx) : []
  const maxCost = Math.max(1, ...chartDays.map((d) => d.costMilli))

  return (
    <div className="credits-tab">
      {byok ? (
        <div className="credits-warnbar byok">
          {t('credits.byokNotice')}
          {onOpenModelSource && (
            <button className="link-btn" onClick={onOpenModelSource}>
              {t('credits.byokSwitch')}
            </button>
          )}
        </div>
      ) : (
        (low || exhausted) && (
          <div className="credits-warnbar">
            {exhausted ? t('credits.warnExhausted') : t('credits.warnLow')}
            {/* 输入框常驻后「去充值」改道:聚焦兑换码输入框 */}
            <button
              className="link-btn"
              onClick={() => {
                codeRef.current?.scrollIntoView({ block: 'center' })
                codeRef.current?.focus()
              }}
            >
              {t('credits.goTopUp')}
            </button>
          </div>
        )
      )}

      {/* 卡片化(2026-11-09 全设置页统一):灰色标题裸背景,余额/兑换/图表/记录进卡 */}
      <label className="field-label card-section-title">{t('credits.balanceTitle')}</label>
      <div className="credits-hero settings-card pad">
        <Coins size={22} />
        <b className="num">{fmtMilli(balance)}</b>
        <span className="hint">
          {t('credits.unit')}
          {nearest && nearestSum > 0
            ? t('credits.expiryPart', { amount: fmtMilli(nearestSum), date: fmtDate(nearest.expiresAt) })
            : ''}
        </span>
        <button
          className="icon-btn ghost-btn sm credits-refresh"
          title={t('credits.refresh')}
          disabled={refreshing}
          onClick={manualRefresh}
        >
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
        </button>
      </div>

      <label className="field-label card-section-title qmark-host">
        {t('credits.redeemTitle')}
        {/* 积分包购买渠道提示(2026-11-09):与各页同款问号浮窗;间距走 .qmark-host 定标 */}
        <span
          className="qmark"
          data-tip={t('credits.redeemHint')}
          tabIndex={0}
          aria-label={t('credits.redeemHint')}
        >
          <CircleHelp size={13} />
        </span>
      </label>
      {/* 兑换码输入常驻(2026-11-09 走查):不再折叠成入口按钮,左标签右输入+兑换 */}
      <div className="settings-card pad">
        <div className="credits-redeem">
          <span className="toggle-title">{t('credits.codeLabel')}</span>
          <input
            ref={codeRef}
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t('credits.codePlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void redeem()
            }}
          />
          <button className="btn primary" disabled={redeeming || !code.trim()} onClick={() => void redeem()}>
            {redeeming ? <Loader2 size={14} className="spin" /> : null}
            {redeeming ? t('credits.redeeming') : t('credits.redeem')}
          </button>
        </div>
        {redeemOk && <div className="credits-redeem-ok">{redeemOk}</div>}
        {error && <div className="wizard-error">{error}</div>}
      </div>

      <label className="field-label card-section-title">{t('credits.chartTitle')}</label>
      <div className="settings-card pad">
        {chartDays.length === 0 ? (
          <p className="hint credits-chart-empty">{t('credits.chartEmpty')}</p>
        ) : (
          <div className="credits-chart">
            {chartDays.map((d, i) => {
              const pct = d.costMilli > 0 ? (d.costMilli / maxCost) * 100 : 0
              return (
                <div
                  key={d.date}
                  className="credits-chart-col"
                  title={t('credits.chartTip', { date: d.date, amount: fmtMilli(d.costMilli) })}
                >
                  {/* 数值骑柱顶(2026-11-09 走查):与柱子同一百分比绝对定位,贴着柱顶浮动;
                      零消耗也显 0(压在 3px 零线上方);柱子百分比基准=纯绘图区(plot) */}
                  <div className="credits-chart-plot">
                    <span className="credits-chart-val num" style={{ bottom: `calc(${pct}% + 3px)` }}>
                      {fmtMilli(d.costMilli)}
                    </span>
                    <div
                      className="credits-chart-bar"
                      data-zero={d.costMilli <= 0 || undefined}
                      style={d.costMilli > 0 ? { height: `${pct}%` } : undefined}
                    />
                  </div>
                  <span className="credits-chart-date num" data-today={i === chartDays.length - 1 || undefined}>
                    {i === chartDays.length - 1 ? t('credits.today') : d.date.slice(5)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <label className="field-label card-section-title">{t('credits.ledgerTitle')}</label>
      <div className="settings-card pad">
        {recordRows.length === 0 ? (
          <p className="hint credits-chart-empty">{t('credits.ledgerEmpty')}</p>
        ) : (
          <div className="credits-ledger">
            {recordRows.map((r) => (
              <div key={r.key} className="credits-ledger-row">
                <span className="credits-ledger-pill">{r.label}</span>
                <span className="credits-ledger-time num">{fmtTime(r.at)}</span>
                <span className="credits-ledger-amount num">+{fmtMilli(r.amountMilli)}</span>
                <span className="credits-ledger-exp num">{t('credits.ledgerExpiry', { date: fmtDate(r.expiresAt) })}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
