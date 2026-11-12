import { useState } from 'react'
import type { Bot, BotAppearance } from '@shared/types'
import { appearanceFromId } from '@shared/avatar'
import { api } from '../api'
import ResidentAvatar from './ResidentAvatar'
import AvatarPicker from './AvatarPicker'
import { useTranslation } from '../i18n'

// 编辑头像弹窗(2026-10-23 评审改版):左右结构——左边拼合预览,右边上造型下眼睛。
// 配色已整体取消,打开即归一到原色(variant A)。草稿模式——保存才落库,取消/点遮罩/Esc 都原样返回。
export default function AvatarEditModal({
  bot,
  onClose,
  onSaved
}: {
  bot: Bot
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<BotAppearance>(() => {
    const a = bot.appearance ?? appearanceFromId(bot.id)
    return { shape: a.shape, variant: 0, eye: a.eye }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await api.botsUpdate(bot.id, { appearance: draft })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="modal avatar-edit-modal">
        <h2>{t('avatar.editTitle')}</h2>
        <div className="ap-split">
          <div className="ap-side">
            <div className="ap-preview">
              <ResidentAvatar appearance={draft} fallbackName={bot.name} size="xl" />
            </div>
          </div>
          <AvatarPicker value={draft} onChange={setDraft} />
        </div>
        {error && <div className="wizard-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn ghost" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            {saving ? t('common.saving') : t('avatar.saveAvatar')}
          </button>
        </div>
      </div>
    </div>
  )
}
