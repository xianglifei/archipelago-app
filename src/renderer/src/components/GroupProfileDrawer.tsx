import { useEffect, useState } from 'react'
import { Save, Trash2, X } from 'lucide-react'
import type { Bot, GroupInfo } from '@shared/types'
import { api } from '../api'
import ResidentAvatar, { GroupAvatarStack } from './ResidentAvatar'
import { useTranslation } from '../i18n'

// 群右侧栏(2026-10-23 三轮评审):群管理——改群名、增删成员(复选即增删)。
// 2026-10-27:管理员解绑 Momo——值守可勾选可移出,被移出时主进程自动移交给名册首位;
// 底部补「解散群」入口(此前 groupsDelete 链路无 UI 消费者)。
export default function GroupProfileDrawer({
  group,
  onClose,
  onChanged
}: {
  group: GroupInfo
  onClose: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(group.name)
  const [memberIds, setMemberIds] = useState<string[]>(group.members.map((m) => m.id))
  const [bots, setBots] = useState<Bot[]>([])
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 解散二次确认:首次点击进入待确认态,3 秒不点自动退出
  const [confirmDissolve, setConfirmDissolve] = useState(false)
  const [dissolving, setDissolving] = useState(false)

  useEffect(() => {
    api.botsList().then(setBots).catch(console.error)
  }, [])

  function toggle(id: string): void {
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function save(): Promise<void> {
    if (memberIds.length === 0) {
      setError(t('group.needOneMember'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await api.groupsUpdate(group.id, { name, memberIds })
      setName(saved.name)
      setMemberIds(saved.members.map((m) => m.id))
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1200)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function dissolve(): Promise<void> {
    if (!confirmDissolve) {
      setConfirmDissolve(true)
      setTimeout(() => setConfirmDissolve(false), 3000)
      return
    }
    setDissolving(true)
    try {
      await api.groupsDelete(group.id)
      onChanged()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDissolving(false)
    }
  }

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <GroupAvatarStack members={group.members} size="lg" />
        <div className="drawer-head-info">
          <div className="drawer-tags">
            <span className="badge soft">{t('group.badge')}</span>
          </div>
          <div className="chat-sub">
            {t('group.createdAt', { date: group.createdAt.slice(0, 10), count: group.members.length })}
          </div>
        </div>
        <button className="icon-btn ghost-btn sm" onClick={onClose} title={t('common.close')}>
          <X size={14} />
        </button>
      </div>

      <label className="field-label">{t('group.name')}</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />

      <label className="field-label">{t('group.members')}</label>
      <div className="member-checks">
        {bots.map((bot) => {
          const checked = memberIds.includes(bot.id)
          return (
            <label key={bot.id} className={`check ${checked ? 'on' : ''}`}>
              <input type="checkbox" checked={checked} onChange={() => toggle(bot.id)} />
              <ResidentAvatar appearance={bot.appearance} fallbackName={bot.name} fallbackColor={bot.color} size="small" />
              {bot.name}
              {checked && bot.id === group.adminBotId && <span className="badge soft">{t('group.onDuty')}</span>}
            </label>
          )
        })}
      </div>
      <p className="perm-desc">
        {t('group.rosterHint')}
      </p>

      {error && <div className="wizard-error">{error}</div>}

      <div className="drawer-actions">
        <button
          className="btn ghost dissolve-btn"
          disabled={dissolving}
          onClick={() => void dissolve()}
        >
          <Trash2 size={14} /> {dissolving ? t('group.dissolving') : confirmDissolve ? t('group.dissolveConfirm') : t('group.dissolve')}
        </button>
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          {savedFlash ? (
            t('common.saved')
          ) : saving ? (
            t('common.saving')
          ) : (
            <>
              <Save size={14} /> {t('common.save')}
            </>
          )}
        </button>
      </div>
    </aside>
  )
}
