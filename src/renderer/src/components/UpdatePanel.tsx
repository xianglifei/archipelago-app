import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CircleHelp,
  Download,
  ExternalLink,
  Loader2,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  Sparkles
} from 'lucide-react'
import type { UpdateState } from '@shared/types'
import { api, onUpdateState } from '../api'
import { formatStamp } from '../utils/time'
import { Markdown } from './markdown/Markdown'
import { useTranslation } from '../i18n'

function formatMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

// 关于:检查 / 下载(优先原地更新,失败自动退安装包)/ sha512 校验 / 重启更新或打开安装包
export default function UpdatePanel() {
  const { t } = useTranslation()
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    api.updateState().then(setState).catch(console.error)
    return onUpdateState(({ state }) => setState(state))
  }, [])

  if (!state) return <p className="modal-lead">{t('common.loading')}</p>

  const available = !!state.version && !state.skipped && !state.rolloutExcluded
  const progress = state.downloadProgress
  const pct =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0

  // hero 卡内状态行(2026-11-09 卡片化:小字状态不裸奔在背景上):常态绿/灰一行,罕见态(错误横幅/
  // 跳过行/新版本卡)信息量大,仍留在卡外自占一块
  let heroStatus: { text: string; ok: boolean } | null = null
  if (state.devMode) heroStatus = { text: t('update.devMode'), ok: false }
  else if (state.status === 'unsupported') heroStatus = { text: t('update.unsupported'), ok: false }
  else if (!available && state.status === 'error') heroStatus = null
  else if (!available && state.lastCheckedAt)
    heroStatus = {
      text: `${t('update.upToDate')} · ${t('update.lastChecked', { time: formatStamp(state.lastCheckedAt) })}`,
      ok: true
    }
  else if (!available && !state.lastCheckedAt) heroStatus = { text: t('update.neverChecked'), ok: false }

  return (
    <div className="update-panel">
      {/* 版本信息(2026-11-09 走查定稿):标准「灰标题+卡」;状态小字并进标题括号,有则带括号出现 */}
      <label className="field-label card-section-title">
        {heroStatus ? t('update.titleWithStatus', { title: t('update.versionTitle'), status: heroStatus.text }) : t('update.versionTitle')}
      </label>
      <div className="settings-card">
        <div className="settings-card-row">
          <span className="toggle-title qmark-host">
            {t('update.versionLabel')}
            <span
              className="qmark qmark-down"
              data-tip={t('update.securityNote')}
              tabIndex={0}
              aria-label={t('update.securityNote')}
            >
              <CircleHelp size={13} />
            </span>
          </span>
          <span className="update-row-right">
            <span className="update-version num">v{state.currentVersion}</span>
            <button
              className="btn ghost"
              disabled={state.status !== 'idle' && state.status !== 'error'}
              onClick={() => void api.updateCheck()}
            >
              {state.status === 'checking' ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              {state.status === 'checking' ? t('update.checking') : t('update.check')}
            </button>
          </span>
        </div>
      </div>

      {state.status === 'error' && !available && (
        <div className="wizard-error">
          <AlertCircle size={13} /> {state.lastError}
          {state.downloadUrl && (
            <>
              {' '}
              <a className="link" href={state.downloadUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={12} /> {t('update.downloadPage')}
              </a>
            </>
          )}
        </div>
      )}

      {state.rolloutExcluded && state.version && (
        <p className="update-hint">{t('update.rolloutWaiting', { version: state.version })}</p>
      )}

      {state.skipped && state.version && !state.mandatory && (
        <div className="update-skipped">
          <span>{t('update.skipped', { version: state.version })}</span>
          <button className="btn ghost" onClick={() => void api.updateSkip(state.version!)}>
            {t('update.restore')}
          </button>
        </div>
      )}

      {/* 可用更新(2026-11-09 卡片化兼容):同款灰标题+软卡;日志收白底内面板,进度/按钮同卡 */}
      {available && (
        <>
          <label className="field-label card-section-title">{t('update.availableTitle')}</label>
          <div className="settings-card pad update-card">
            <div className="update-card-head">
            <Sparkles size={15} />
            <span className="update-version">{t('update.newVersion', { version: state.version })}</span>
            {state.mandatory && <span className="update-mandatory">{t('update.mandatory')}</span>}
            {state.releaseDate && <span className="update-hint">{state.releaseDate}</span>}
          </div>

          {state.notes && (
            <div className="update-notes">
              <Markdown content={state.notes} />
            </div>
          )}

          {state.status === 'downloading' && progress ? (
            <div className="update-actions">
              <div className="update-progress">
                <i style={{ width: `${pct}%` }} />
              </div>
              <span className="update-hint">
                {progress.received > 0
                  ? `${pct}% · ${formatMB(progress.received)} / ${formatMB(progress.total)}`
                  : t('update.preparing')}
              </span>
              <button className="btn ghost" onClick={() => void api.updateCancel()}>
                {t('common.cancel')}
              </button>
            </div>
          ) : state.status === 'downloaded' ? (
            state.installMode === 'inplace' ? (
              <div className="update-actions">
                <button className="btn primary" onClick={() => void api.updateInstall()}>
                  <RotateCcw size={14} /> {t('update.restartUpdate')}
                </button>
                <span className="update-hint">
                  {t('update.inplaceHint')}
                </span>
                {state.downloadUrl && (
                  <a className="link" href={state.downloadUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} /> {t('update.useInstaller')}
                  </a>
                )}
              </div>
            ) : (
              <div className="update-actions">
                <button className="btn primary" onClick={() => void api.updateOpen()}>
                  <PackageOpen size={14} /> {t('update.openInstaller')}
                </button>
                <span className="update-hint">{t('update.installerHint')}</span>
              </div>
            )
          ) : (
            <div className="update-actions">
              <button className="btn primary" disabled={!state.downloadUrl} onClick={() => void api.updateDownload()}>
                <Download size={14} /> {t('update.download')}
              </button>
              {!state.mandatory && (
                <button className="btn ghost" onClick={() => void api.updateSkip(state.version!)}>
                  {t('update.skipVersion')}
                </button>
              )}
              {state.downloadUrl && (
                <a className="link" href={state.downloadUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} /> {t('update.dlPage')}
                </a>
              )}
            </div>
          )}

          {state.status === 'error' && state.lastError && (
            <div className="update-hint err">
              <AlertCircle size={13} /> {state.lastError}
            </div>
          )}
          </div>
        </>
      )}

      {/* 卡片化(2026-11-09):标题裸在背景上(灰色常规体,视觉重量让给卡片),两个开关合并一张卡 */}
      <label className="field-label card-section-title">{t('update.prefsTitle')}</label>
      <div className="update-prefs-card">
        <div className="update-toggle">
          <label htmlFor="pref-auto-check">
            {/* 说明收进标题旁问号浮窗(2026-11-09,与设置各页同标准);qmark-host 提供 4px 定标间距。
                图标拦点击转发:label 绑着 checkbox,点图标不许误触开关 */}
            <span className="toggle-title qmark-host">
              {t('update.autoCheckTitle')}
              <span
                className="qmark"
                data-tip={t('update.autoCheckHint')}
                tabIndex={0}
                aria-label={t('update.autoCheckHint')}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
              >
                <CircleHelp size={13} />
              </span>
            </span>
          </label>
          <input
            id="pref-auto-check"
            type="checkbox"
            className="switch"
            checked={state.prefs.autoCheck}
            onChange={(e) => void api.updateSetPrefs({ autoCheck: e.target.checked })}
          />
        </div>
        <div className="update-toggle">
          <label htmlFor="pref-auto-download">
            <span className="toggle-title qmark-host">
              {t('update.autoDlTitle')}
              <span
                className="qmark"
                data-tip={t('update.autoDlHint')}
                tabIndex={0}
                aria-label={t('update.autoDlHint')}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
              >
                <CircleHelp size={13} />
              </span>
            </span>
          </label>
          <input
            id="pref-auto-download"
            type="checkbox"
            className="switch"
            checked={state.prefs.autoDownload}
            onChange={(e) => void api.updateSetPrefs({ autoDownload: e.target.checked })}
          />
        </div>
      </div>
    </div>
  )
}
