import { useState } from 'react'
import { ClipboardList, Folder, FolderOpen, X } from 'lucide-react'
import ResidentAvatar from './ResidentAvatar'
import type { Bot, TaskThreadInfo } from '@shared/types'
import { api } from '../api'
import { useTranslation } from '../i18n'

// 新建任务·选居民(2026-11-06「新建任务」):加号菜单入口的单选弹窗——
// 全员可选(含主 Bot,P5 拍板:Momo 恰是最常被派活的);行菜单入口不经这里,直接开。
// 与 CreateGroupModal 同壳同语言,单选替代多选;建完返回线程,由 MainScreen 切到任务视图。
// 工作目录(2026-11-10 第一批):可选——选了就在建好后弹绑定授权卡(git 仓库自动隔离模式)。
export default function TaskModal({
  bots,
  onClose,
  onCreated
}: {
  bots: Bot[]
  onClose: () => void
  onCreated: (thread: TaskThreadInfo) => void
}) {
  const { t } = useTranslation()
  const [botId, setBotId] = useState<string | null>(null)
  const [workdir, setWorkdir] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pickWorkdir(): Promise<void> {
    const dir = await api.pickDirectory()
    if (dir) setWorkdir(dir)
  }

  async function start(): Promise<void> {
    if (!botId) {
      setError(t('taskModal.pick'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      onCreated(await api.taskThreadCreate(botId, workdir ?? undefined))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>
          <ClipboardList size={18} /> {t('taskModal.title')}
        </h2>
        <p className="modal-lead">{t('taskModal.pick')}</p>

        <div className="member-checks">
          {bots.map((bot) => {
            const picked = botId === bot.id
            return (
              <button
                key={bot.id}
                type="button"
                className={`check ${picked ? 'on' : ''}`}
                onClick={() => setBotId(picked ? null : bot.id)}
              >
                <ResidentAvatar appearance={bot.appearance} fallbackName={bot.name} fallbackColor={bot.color} size="small" />
                {bot.name}
                {bot.isMain ? <span className="badge soft">{t('common.steward')}</span> : null}
              </button>
            )
          })}
        </div>
        {bots.length === 0 && <p className="modal-lead">{t('group.noResidents')}</p>}

        <div className="task-workdir-row">
          {workdir ? (
            <>
              <FolderOpen size={15} />
              <span className="task-workdir-path" title={workdir}>
                {workdir}
              </span>
              <button type="button" className="icon-btn sm" title={t('common.cancel')} onClick={() => setWorkdir(null)}>
                <X size={13} />
              </button>
            </>
          ) : (
            <>
              <Folder size={15} />
              <button type="button" className="btn sm ghost" onClick={() => void pickWorkdir()}>
                {t('task.workdirPick')}
              </button>
            </>
          )}
        </div>

        {error && <div className="wizard-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn ghost" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={saving || !botId} onClick={() => void start()}>
            {saving ? t('common.loading') : t('taskModal.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
