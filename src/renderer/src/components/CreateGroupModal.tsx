import { useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import ResidentAvatar from './ResidentAvatar'
import type { Bot, GroupInfo } from '@shared/types'
import { api } from '../api'
import { useTranslation } from '../i18n'

// 建群(M5.1;2026-10-27 管理员解绑 Momo):全员普通候选,第一个勾选的成员任群值守;
// 建群时提示费用特征(需求文档群聊注记);至少勾选一位居民(值守必是成员)
export default function CreateGroupModal({
  bots,
  onClose,
  onCreated
}: {
  bots: Bot[]
  onClose: () => void
  onCreated: (group: GroupInfo) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 值守=第一个勾选的成员(确定性规则,群名册与群规提示都可预期)
  const adminId = memberIds[0] ?? null

  function toggle(id: string): void {
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function create(): Promise<void> {
    if (!name.trim()) {
      setError(t('group.needName'))
      return
    }
    if (memberIds.length === 0) {
      setError(t('group.needMember'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      // 2026-10-23 评审:群公告字段取消,恒传空串(旧群存量的公告展示仍兼容)
      onCreated(await api.groupsCreate({ name, announcement: '', memberIds, adminBotId: adminId ?? undefined }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>
          <MessageSquarePlus size={18} /> {t('group.createTitle')}
        </h2>
        <p className="modal-lead">
          {t('group.createLead')}
        </p>

        <label className="field-label">{t('group.name')}</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('group.namePlaceholder')} />

        <label className="field-label">{t('group.members')}</label>
        <div className="member-checks">
          {bots.map((bot) => {
            const checked = memberIds.includes(bot.id)
            return (
              <label key={bot.id} className={`check ${checked ? 'on' : ''}`}>
                <input type="checkbox" checked={checked} onChange={() => toggle(bot.id)} />
                <ResidentAvatar appearance={bot.appearance} fallbackName={bot.name} fallbackColor={bot.color} size="small" />
                {bot.name}
                {checked && bot.id === adminId && <span className="badge soft">{t('group.onDuty')}</span>}
              </label>
            )
          })}
        </div>
        {bots.length === 0 && <p className="modal-lead">{t('group.noResidents')}</p>}

        {error && <div className="wizard-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn ghost" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void create()}>
            {saving ? t('group.creating') : t('group.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
