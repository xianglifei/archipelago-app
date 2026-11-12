import { useState } from 'react'
import { Dices, UserPlus } from 'lucide-react'
import type { Bot, BotAppearance } from '@shared/types'
import { randomIslanderName } from '@shared/names'
import { randomAppearance } from '@shared/avatar'
import { ARCHETYPES } from '@shared/archetypes'
import { api } from '../api'
import ResidentAvatar from './ResidentAvatar'
import AvatarPicker from './AvatarPicker'
import { useTranslation } from '../i18n'
import { displayName } from '../i18n/localized'

// 新建居民(2026-11-03 更名自「邀请居民」;2026-10-26 评审终版:三段式)——自上而下:①名字(左对齐 340px,带随机)
// ②性格(8 型一行平铺,2026-10-26 拍板:无「更多」折叠、无专属性格、删「傲娇」)
// ③形象(左预览与右侧底板+眼睛区等高)。
// 人设与模型不再要求用户填写:人设由居民在对话中自我迭代(0.6 update_resident),
// 模型跟随全局默认(需要时在居民档案里改);角色标签随三段式改版移除。
export default function InviteBotModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (bot: Bot) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [appearance, setAppearance] = useState<BotAppearance>(randomAppearance())
  const [archetype, setArchetype] = useState('gentle')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = ARCHETYPES.find((a) => a.id === archetype)

  async function create(): Promise<void> {
    if (!name.trim()) {
      setError(t('invite.needName'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      onCreated(
        await api.botsCreate({ name, role: '', persona: '', archetype, providerId: '', modelId: '', appearance })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal invite-modal invite-modal-v3">
        <h2>
          <UserPlus size={18} /> {t('invite.title')}
        </h2>
        <p className="modal-lead">{t('invite.lead')}</p>

        <label className="field-label">{t('invite.name')}</label>
        <div className="field-row invite-name-row">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('invite.namePlaceholder')}
            spellCheck={false}
          />
          <button className="btn ghost" title={t('invite.randomTip')} onClick={() => setName(randomIslanderName())}>
            <Dices size={14} /> {t('invite.random')}
          </button>
        </div>

        <label className="field-label">{t('invite.archetype')}</label>
        <div className="arch-grid">
          {ARCHETYPES.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`arch-cell ${archetype === a.id ? 'active' : ''}`}
              title={displayName(a) === a.name ? a.blurb : a.blurbEn}
              onClick={() => setArchetype(a.id)}
            >
              {displayName(a)}
            </button>
          ))}
        </div>
        {selected && (
          <p className="archetype-blurb invite-blurb">{displayName(selected) === selected.name ? selected.blurb : selected.blurbEn}</p>
        )}

        <label className="field-label">{t('invite.look')}</label>
        <div className="look-split">
          <div className="look-preview">
            <ResidentAvatar
              appearance={appearance}
              fallbackName={name || t('invite.residentFallback')}
              size="xl"
              className="look-avatar"
            />
          </div>
          <AvatarPicker value={appearance} onChange={setAppearance} />
        </div>

        {error && <div className="wizard-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn ghost" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void create()}>
            {saving ? t('invite.movingIn') : t('invite.invite')}
          </button>
        </div>
      </div>
    </div>
  )
}
