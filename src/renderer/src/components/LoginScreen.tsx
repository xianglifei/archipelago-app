import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Lock, Mail, Waves } from 'lucide-react'
import type { SeaClaimIslandInfo } from '@shared/types'
import { api } from '../api'
import { Trans } from 'react-i18next'
import { useTranslation as useAppTranslation } from '../i18n'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 旧岛最后使用时间 → 认领卡短文案;今天/昨天/今年 MM-DD/往年 YYYY-MM-DD,读不出给 null(卡片隐藏该段) */
function fmtLastUsed(iso: string | null, today: string, yesterday: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const dayOf = (x: Date): string => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
  const now = new Date()
  if (dayOf(d) === dayOf(now)) return today
  const yd = new Date(now)
  yd.setDate(now.getDate() - 1)
  if (dayOf(d) === dayOf(yd)) return yesterday
  const pad = (n: number): string => String(n).padStart(2, '0')
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`
}

/**
 * 整屏登录门(0.8 账号即门):A1 邮箱页(Notion 式)→ B 六格验证码 → C 存量认领卡。
 * 登录成功(enter/wizard)由主进程完成挂载,这里 location.reload() 重新 boot 进主界面/向导;
 * 设计定稿见 doc/需求 - 0.8登录门与账号分区 - 2026-10-23.md 第三节。
 */
export default function LoginScreen() {
  const { t } = useAppTranslation()
  const [view, setView] = useState<'email' | 'code' | 'claim'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claim, setClaim] = useState<SeaClaimIslandInfo | null>(null)

  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  async function sendCode(): Promise<void> {
    if (!EMAIL_RE.test(email.trim())) {
      setError(t('login.badEmail'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await api.authRequestCode(email.trim())
      // 生产环境没有 dev_code:保留用户已输的码(旧码在服务端并未失效,重发不必清空)
      if (r.devCode) setCode(r.devCode)
      setView('code')
      setCountdown(60)
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  // OTP 六格输满即自动提交;手动点按钮时无参调用,取 state
  async function verify(codeInput?: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.authVerify(email.trim(), (codeInput ?? code).trim())
      if (next.next === 'claim') {
        setClaim(next.island)
        setView('claim')
        setBusy(false)
      } else {
        // enter / wizard:主进程已挂载,reload 重新 boot
        location.reload()
      }
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }

  async function confirmClaim(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api.authClaimConfirm()
      location.reload()
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }

  /** 不是我的岛:存量数据原样留给以后的账号,当前账号直接走建岛向导 */
  async function declineClaim(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api.authClaimDecline()
      location.reload()
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }

  const lastUsed = fmtLastUsed(claim?.lastUsedAt ?? null, t('login.today'), t('login.yesterday'))

  return (
    <div className="login-root">
      <div className="login-card">
        <div className="login-brand">
          <Waves size={26} />
          <span>{t('common.appName')}</span>
        </div>

        {view === 'email' && (
          <>
            <div className="login-head">
              <div className="login-title">{t('login.title')}</div>
              <div className="login-sub">{t('login.sub')}</div>
            </div>
            <input
              className="login-input-hero"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void sendCode()}
              placeholder="you@example.com"
              autoFocus
              spellCheck={false}
            />
            {error && <div className="login-error"><CircleAlert size={13} />{error}</div>}
            <button className="login-btn-primary big" disabled={busy} onClick={() => void sendCode()}>
              {busy ? t('login.sending') : t('login.getCode')}
            </button>
          </>
        )}

        {view === 'code' && (
          <>
            <div className="login-head">
              <div className="login-title">{t('login.codeTitle')}</div>
              <div className="login-sub">
                <Trans t={t} i18nKey="login.sentTo" values={{ email: email.trim() }} components={{ b: <b /> }} /> ·{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    setView('email')
                    setCode('')
                    setError(null)
                  }}
                >
                  {t('login.changeEmail')}
                </a>
              </div>
            </div>
            <OtpInput value={code} onChange={setCode} onComplete={(v) => void verify(v)} />
            {error && <div className="login-error"><CircleAlert size={13} />{error}</div>}
            <div className="login-resend">
              {countdown > 0 ? t('login.resendIn', { count: countdown }) : <a href="#" onClick={(e) => { e.preventDefault(); void sendCode() }}>{t('login.resend')}</a>}
            </div>
            {/* 2026-10-26 内测走查:验证码常被投进垃圾箱,提示从底部小字提为输入区下方的软提示条
                0.9.2 自走查(A1):精简为单行,只说「垃圾邮件箱」不缩写成「垃圾箱」 */}
            <div className="login-mail-hint">
              <Mail size={12} />
              {t('login.mailHint')}
            </div>
            <button
              className="login-btn-primary big"
              disabled={busy || code.length !== 6}
              onClick={() => void verify()}
            >
              {busy ? t('login.verifying') : t('login.verifyEnter')}
            </button>
          </>
        )}

        {view === 'claim' && claim && (
          <>
            <div className="login-head">
              <div className="login-title">{t('login.claimTitle')}</div>
              <div className="login-sub">{t('login.claimSub')}</div>
            </div>
            <div className="login-island">
              <div className="login-island-ico"><Waves size={20} /></div>
              <div>
                <b>{claim.name}</b>
                <span>
                  {t('login.claimMeta', { owner: claim.ownerName, count: claim.botCount })}
                  {lastUsed ? t('login.lastUsed', { time: lastUsed }) : ''}
                </span>
              </div>
            </div>
            <div className="login-note-strong">
              <Trans t={t} i18nKey="login.claimStrong" values={{ island: claim.name, email: email.trim() }} components={{ b: <b /> }} />
            </div>
            {error && <div className="login-error"><CircleAlert size={13} />{error}</div>}
            {/* 三按钮一行太挤且逻辑不齐(2026-10-26 评审):主路径通栏一行,两个"不绑当前账号"的次路径各带一行说明沉到第二行 */}
            <div className="login-actions-v2">
              <button className="login-btn-primary big claim-main" disabled={busy} onClick={() => void confirmClaim()}>
                {busy ? t('login.claiming') : t('login.claimGo')}
              </button>
              <div className="claim-alt-row">
                <button className="claim-alt" disabled={busy} onClick={() => setView('email')}>
                  <b>{t('login.altEmail')}</b>
                  <span>{t('login.altEmailSub')}</span>
                </button>
                <button className="claim-alt" disabled={busy} onClick={() => void declineClaim()}>
                  <b>{t('login.altNew')}</b>
                  <span>{t('login.altNewSub')}</span>
                </button>
              </div>
            </div>
            <div className="login-foot">
              <Lock size={12} />
              {t('login.foot')}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 六格 OTP 输入:隐藏 input 承载真实值与焦点,六格纯视觉(点击任意格聚焦输入);输满 6 位回调带最新值 */
function OtpInput({ value, onChange, onComplete }: { value: string; onChange: (v: string) => void; onComplete: (v: string) => void }) {
  const hiddenRef = useRef<HTMLInputElement | null>(null)
  // Backspace 兜底用的「删除前 DOM 值」快照(keydown 记,keyup 消费;null=本次不是退格)
  const backspacePreRef = useRef<string | null>(null)
  const digits = value.slice(0, 6).padEnd(6, ' ').split('')

  return (
    <div
      className="login-otp"
      onMouseDown={(e) => {
        e.preventDefault()
        hiddenRef.current?.focus()
      }}
    >
      {/* 2026-11-04 Windows 首测反馈:剩最左一位时 Backspace 删不掉。Mac 无法复现,根因待真机定位,
          先做三层防御:①input 从 1px 隐藏改为覆盖格子区的透明全宽层(规避 1px-input 一类平台怪癖,
          IME 候选窗/autofill 锚定也归位) ②onChange 显式回写受控值 ③keyup 兜底——若平台吞掉默认
          编辑行为导致 input 事件未派发(DOM 值仍等于旧值),显式执行删除。
          autoComplete 关闭:one-time-code 在 Windows 桌面无接收通道且连着 autofill 回填类怪癖。 */}
      <input
        ref={hiddenRef}
        className="login-otp-hidden"
        value={value}
        inputMode="numeric"
        autoComplete="off"
        onChange={(e) => {
          const next = e.target.value.replace(/\D/g, '').slice(0, 6)
          e.target.value = next // 防御②:显式回写,确保受控值与 DOM 恒一致
          onChange(next)
          if (next.length === 6) onComplete(next)
        }}
        onKeyDown={(e) => {
          // 防御③前置:记下删除前的 DOM 值。默认行为正常时 input 事件会把 DOM 改掉,keyup 一对即不等;
          // 只被平台吞掉(DOM 没变)才兜底。不能拿闭包 value 比——React 会赶在 keyup 前重渲染,
          // 闭包已换成新值,「正常删除」会被误判成「被吞」而连删两位
          if (e.key === 'Backspace') backspacePreRef.current = e.currentTarget.value
        }}
        onKeyUp={(e) => {
          // 防御③:平台吞掉默认编辑行为(input 事件未派发、DOM 值仍等于删除前快照)→显式删末位
          if (e.key === 'Backspace' && backspacePreRef.current !== null && e.currentTarget.value === backspacePreRef.current && value.length > 0) {
            const next = value.slice(0, -1)
            e.currentTarget.value = next
            onChange(next)
          }
          backspacePreRef.current = null
        }}
        autoFocus
        spellCheck={false}
      />
      {digits.map((d, i) => (
        <span key={i} className={`login-otp-box ${d !== ' ' ? 'fill' : ''} ${value.length === i ? 'cur' : ''}`}>
          {d === ' ' ? '' : d}
        </span>
      ))}
    </div>
  )
}
