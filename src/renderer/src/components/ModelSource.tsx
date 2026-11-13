import { useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import type { SettingsState } from '@shared/types'
import { PROVIDERS } from '@shared/providers'
import { api } from '../api'
import { useTranslation } from '../i18n'

// 模型来源(2026-11-13 BYOK 拍板 v3):岛务页 = 大切换台,两个来源直接展开,点一下就换大脑;
// 只有需要填东西的「我自己的 DeepSeek Key」进二级页(填 Key / 选模型 / 测连通)。
// 上一版把整张卡收成一行入口,选项被藏了一层——这版把选项还给岛务页。
const DEEPSEEK_MODELS = PROVIDERS.find((p) => p.id === 'deepseek')?.models ?? []
/** 两档模型 id 与 providers.ts 同名(两条通道共用,切通道不用重选模型) */
const MODEL_FLASH = 'deepseek-flash'
const MODEL_PRO = 'deepseek-v4-pro'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function pickDeepseekModel(modelId: string): string {
  return DEEPSEEK_MODELS.some((m) => m.id === modelId) ? modelId : MODEL_FLASH
}

/**
 * 岛务页「模型来源」卡。行为口径(原型 v3 §2):
 * - 当前档带「当前」标;两个来源并排,不藏折叠;
 * - 自带 Key 未配置:点行 = 进二级页填写;已配置未选中:点行 = 直接切换,行尾「修改」进二级页;
 * - 从自带 Key 点回群岛通道:行内一句确认(恢复按积分计费),不弹窗。
 */
export function ModelSourceCard({
  state,
  onOpenDetail,
  onChanged
}: {
  state: SettingsState
  onOpenDetail: () => void
  onChanged: (next: SettingsState) => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [confirmRelay, setConfirmRelay] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onRelay = state.model.providerId === 'archipelago'
  const byokModel = pickDeepseekModel(state.model.modelId)

  async function switchTo(providerId: string, modelId: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const next = await api.settingsSave({ providerId, modelId })
      onChanged(next)
      setConfirmRelay(false)
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  function handleRelayRow(): void {
    if (busy || onRelay) return
    setConfirmRelay(true)
  }

  function handleByokRow(): void {
    if (busy) return
    setConfirmRelay(false)
    if (state.model.providerId === 'deepseek') {
      onOpenDetail()
      return
    }
    if (state.hasByokKey) {
      // 已填过 Key 的人再切回来,不该被多收一步:点行直接生效
      void switchTo('deepseek', byokModel)
      return
    }
    onOpenDetail()
  }

  return (
    <div className="settings-card">
      <div
        className="model-src-row"
        data-current={onRelay || undefined}
        role="button"
        tabIndex={0}
        onClick={handleRelayRow}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleRelayRow()
          }
        }}
      >
        <span className="model-src-dot" data-on={onRelay || undefined} aria-hidden />
        <span className="model-src-main">
          <span className="model-src-name">{t('settings.modelSrcRelayTitle')}</span>
          <span className="model-src-sub">{t('settings.modelSrcRelaySub')}</span>
        </span>
        {onRelay && <span className="model-src-badge">{t('settings.modelSrcCurrent')}</span>}
      </div>

      <div
        className="model-src-row"
        data-current={!onRelay || undefined}
        role="button"
        tabIndex={0}
        onClick={handleByokRow}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleByokRow()
          }
        }}
      >
        <span className="model-src-dot" data-on={!onRelay || undefined} aria-hidden />
        <span className="model-src-main">
          <span className="model-src-name">{t('settings.modelSrcByokTitle')}</span>
          <span className="model-src-sub">
            {state.hasByokKey ? t('settings.modelSrcByokReady') : t('settings.modelSrcByokUnset')}
          </span>
        </span>
        <span className="model-src-side">
          {!onRelay && <span className="model-src-badge">{t('settings.modelSrcCurrent')}</span>}
          {state.hasByokKey ? (
            <button
              className="model-src-edit"
              onClick={(e) => {
                e.stopPropagation()
                onOpenDetail()
              }}
            >
              {t('settings.modelSrcEdit')}
            </button>
          ) : (
            !onRelay && (
              <button
                className="model-src-edit"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenDetail()
                }}
              >
                {t('settings.modelSrcFillIn')} <ChevronRight size={12} />
              </button>
            )
          )}
        </span>
      </div>

      {confirmRelay && (
        <div className="model-src-confirm">
          <span>{t('settings.modelSrcRelayConfirm')}</span>
          <span className="model-src-confirm-actions">
            <button className="btn sm ghost" disabled={busy} onClick={() => setConfirmRelay(false)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn sm primary"
              disabled={busy}
              onClick={() => void switchTo('archipelago', state.model.modelId)}
            >
              {busy ? <Loader2 size={12} className="spin" /> : null}
              {t('settings.modelSrcSwitchBack')}
            </button>
          </span>
        </div>
      )}

      {error && <div className="wizard-error">{error}</div>}
    </div>
  )
}

/**
 * 「我自己的 DeepSeek Key」二级页:Key / 模型 / 测连通 / 保存并使用。
 * 保存走 settingsSave(providerId+modelId(+apiKey))——主进程在同一个事务里把存量居民刷成新通道,
 * 所以「保存后立即对整座岛生效」不是文案,是事实。
 */
export function ByokDetail({
  state,
  onBack,
  onChanged
}: {
  state: SettingsState
  onBack: () => void
  onChanged: (next: SettingsState) => void
}) {
  const { t } = useTranslation()
  const [keyInput, setKeyInput] = useState('')
  const [modelId, setModelId] = useState(() => pickDeepseekModel(state.model.modelId))
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const keyReady = !!keyInput.trim() || state.hasByokKey

  async function testConnection(): Promise<void> {
    setTesting(true)
    setTestOk(null)
    setError(null)
    try {
      // 输入框留空时主进程测已存的那把,不必让用户把 Key 再贴一遍
      const r = await api.providerTest({ providerId: 'deepseek', modelId, apiKey: keyInput.trim() })
      if (r.ok) {
        const seconds = ((r.latencyMs ?? 0) / 1000).toFixed(1)
        setTestOk(t('settings.modelSrcTestOk', { seconds }))
      } else {
        setError(t('settings.modelSrcTestFail', { error: r.error ?? '' }))
      }
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setTesting(false)
    }
  }

  async function save(): Promise<void> {
    if (!keyReady || saving) return
    setSaving(true)
    setError(null)
    try {
      const next = await api.settingsSave({
        providerId: 'deepseek',
        modelId,
        apiKey: keyInput.trim() || undefined
      })
      onChanged(next)
      onBack()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="model-src-head">
        <button onClick={onBack}>
          <ChevronLeft size={13} /> {t('settings.tabIsland')}
        </button>
      </div>
      <h3 className="model-src-title">{t('settings.modelSrcByokTitle')}</h3>

      <label className="field-label card-section-title">{t('settings.modelSrcKeyLabel')}</label>
      <div className="settings-card pad">
        <div className="settings-card-row">
          <input
            className="input model-src-key-input"
            type="password"
            value={keyInput}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('settings.modelSrcKeyPlaceholder')}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <span className="model-src-key-state">
            {keyReady ? t('settings.modelSrcKeySaved') : t('settings.modelSrcKeyEmpty')}
          </span>
        </div>
        <div className="settings-card-row">
          <button className="btn sm ghost" disabled={testing || !keyReady} onClick={() => void testConnection()}>
            {testing ? <Loader2 size={12} className="spin" /> : null}
            {testing ? t('settings.modelSrcTesting') : t('settings.modelSrcTest')}
          </button>
          <span className="model-src-test">{testOk}</span>
        </div>
        <p className="model-src-hint">{t('settings.modelSrcKeyHint')}</p>
      </div>

      <label className="field-label card-section-title">{t('settings.modelSrcModelTitle')}</label>
      <div className="settings-card">
        <div
          className="model-src-row"
          role="button"
          tabIndex={0}
          onClick={() => setModelId(MODEL_FLASH)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setModelId(MODEL_FLASH)
            }
          }}
        >
          <span className="model-src-dot" data-on={modelId === MODEL_FLASH || undefined} aria-hidden />
          <span className="model-src-main">
            <span className="model-src-name">{t('settings.modelSrcFlash')}</span>
            <span className="model-src-sub">{t('settings.modelSrcFlashDesc')}</span>
          </span>
        </div>
        <div
          className="model-src-row"
          role="button"
          tabIndex={0}
          onClick={() => setModelId(MODEL_PRO)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setModelId(MODEL_PRO)
            }
          }}
        >
          <span className="model-src-dot" data-on={modelId === MODEL_PRO || undefined} aria-hidden />
          <span className="model-src-main">
            <span className="model-src-name">{t('settings.modelSrcPro')}</span>
            <span className="model-src-sub">{t('settings.modelSrcProDesc')}</span>
          </span>
        </div>
      </div>

      <p className="model-src-note">{t('settings.modelSrcByokNote')}</p>
      {error && <div className="wizard-error">{error}</div>}
      <div className="model-src-save">
        <button className="btn primary" disabled={!keyReady || saving} onClick={() => void save()}>
          {saving ? <Loader2 size={13} className="spin" /> : null}
          {t('settings.modelSrcSave')}
        </button>
        <span className="model-src-save-hint">{t('settings.modelSrcSaveHint')}</span>
      </div>
    </>
  )
}
