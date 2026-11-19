import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, Folder, FolderOpen, Play, Settings, SquareKanban, Undo2, X } from 'lucide-react'
import type { BoardCard, Bot, CardActionResult, CardStatus } from '@shared/types'
import { api, onCardsChanged, onThreadsChanged } from '../api'
import ResidentAvatar from './ResidentAvatar'
import { useTranslation } from '../i18n'

// 看板(2026-11-19 需求 - 看板:卡片与任务会话联动):全岛一块四列板(待办/进行中/待审阅/已完成),
// 卡片=未开跑的任务会话预约+进度投影——四列归属由主进程读时推导随 cardsList 下发,本组件零推导;
// 状态刷新走无载荷广播重拉(onCardsChanged/onThreadsChanged,同 PostView 口径)。
// 第二批:看板/列表双视图+点列排序(偏好 meta KV 持久)+齿轮设置(收尾提示词模板+只读诊断)。
// 执行/完成复用任务会话链路:点「执行」主进程建线程+投正文,进度自动流转;不支持拖拽(产品原则)。

/** 当天 HH:mm、跨天 M/D HH:mm(口径同 PostView.formatTime) */
function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

type SortKey = 'seq' | 'title' | 'status' | 'lastRun' | 'created'
const statusRank: Record<CardStatus, number> = {
  todo: 0,
  running: 1,
  review: 2,
  done: 3
}

export default function KanbanView({ bots, onOpenTask }: { bots: Bot[]; onOpenTask: (threadId: string) => void }) {
  const { t } = useTranslation()
  const [cards, setCards] = useState<BoardCard[]>([])
  const [loaded, setLoaded] = useState(false)
  const [viewMode, setViewMode] = useState<'board' | 'list'>('board')
  const [doneOpen, setDoneOpen] = useState(false)
  // null=关闭;{card:null}=新建;{card}=编辑
  const [editor, setEditor] = useState<{ card: BoardCard | null } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('seq')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  // 完成时的轻提示(需求 §13-3,不弹窗):几秒自消
  const [hint, setHint] = useState<string | null>(null)
  // 动作进行中的卡片 id(按钮防连点;执行链后半段在主进程后台推进,不占这个位)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!hint) return
    const id = setTimeout(() => setHint(null), 5000)
    return () => clearTimeout(id)
  }, [hint])

  const refresh = (): void => {
    api
      .cardsList()
      .then((list) => {
        setCards(list)
        setLoaded(true)
      })
      .catch(console.error)
  }

  useEffect(() => {
    refresh()
    // ThreadsChanged 一起订:线程标题自动生成/结束状态影响卡片摘要展示
    const offs = [onCardsChanged(refresh), onThreadsChanged(refresh)]
    return () => offs.forEach((off) => off())
  }, [])

  // 偏好(meta KV):视图模式与已完成折叠随用随存
  useEffect(() => {
    api
      .cardsPrefsGet()
      .then((p) => {
        setViewMode(p.viewMode)
        setDoneOpen(!p.doneCollapsed)
      })
      .catch(console.error)
  }, [])

  const byCol = useMemo(
    () => ({
      todo: cards.filter((c) => c.status === 'todo'),
      running: cards.filter((c) => c.status === 'running'),
      review: cards.filter((c) => c.status === 'review'),
      done: cards.filter((c) => c.status === 'done')
    }),
    [cards]
  )

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...cards].sort((a, b) => {
      let r: number
      if (sortKey === 'seq') r = a.seq - b.seq
      else if (sortKey === 'title') r = (a.displayTitle || a.body).localeCompare(b.displayTitle || b.body)
      else if (sortKey === 'status') r = statusRank[a.status] - statusRank[b.status]
      else if (sortKey === 'lastRun') r = (a.lastRunStartedAt ?? '').localeCompare(b.lastRunStartedAt ?? '')
      else r = a.createdAt.localeCompare(b.createdAt)
      return r * dir
    })
  }, [cards, sortKey, sortDir])

  const botOf = (id: string | null): Bot | null => (id ? (bots.find((b) => b.id === id) ?? null) : null)

  /** 卡片动作统一出口:防连点 + ok=false 人话提示;返回动作是否成功(完成后的轻提示要看它) */
  async function act(id: string, fn: () => Promise<CardActionResult>): Promise<boolean> {
    if (busyId) return false
    setBusyId(id)
    try {
      const r = await fn()
      if (!r.ok) {
        window.alert(r.message)
        return false
      }
      return true
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusyId(null)
    }
  }

  /** 完成(两段式/直接):成功且有会话时给一条轻提示——会话治理出口在岛主手里(需求 §13-3) */
  async function doneCard(card: BoardCard): Promise<void> {
    const ok = await act(card.id, () => api.cardDone(card.id))
    if (ok && card.threadId) setHint(t('board.doneHint'))
  }

  /** 点卡片主体:进编辑器=卡片详情面板(走查拍板:编辑/删除收进编辑器,「打开会话」也在里面;卡上只留执行/完成/撤销) */
  function openCard(card: BoardCard): void {
    setEditor({ card })
  }

  function switchView(mode: 'board' | 'list'): void {
    setViewMode(mode)
    void api.cardsPrefsSet({ viewMode: mode }).catch(console.error)
  }

  function toggleDone(): void {
    setDoneOpen((v) => {
      const next = !v
      void api.cardsPrefsSet({ doneCollapsed: !next }).catch(console.error)
      return next
    })
  }

  function renderBadges(card: BoardCard): ReactNode {
    // 角标互斥链:未指派(待办)/ 准备中 > 收尾中 > 进行中(三点动效,复用 .thinking-dots);
    // 「等你拍板」与「未成」在链外叠加(需求 §6.4)
    const items: {
      key: string
      label: string
      cls?: string
      dots?: boolean
    }[] = []
    if (card.status === 'todo' && !card.botId) items.push({ key: 'unassigned', label: t('board.unassigned') })
    if (card.preparing) items.push({ key: 'preparing', label: t('board.badgePreparing') })
    else if (card.finishing) items.push({ key: 'finishing', label: t('board.badgeFinishing') })
    else if (card.status === 'running') items.push({ key: 'running', label: t('board.colRunning'), dots: true })
    if (card.awaiting)
      items.push({
        key: 'awaiting',
        label: t('board.badgeAwaiting'),
        cls: 'warn'
      })
    if (card.error)
      items.push({
        key: 'failed',
        label: t('board.badgeFailed'),
        cls: 'danger'
      })
    if (items.length === 0) return null
    return (
      <div className="kanban-badges">
        {items.map((it) => (
          <span key={it.key} className={`kanban-badge${it.cls ? ` ${it.cls}` : ''}`}>
            {it.label}
            {it.dots && (
              <span className="thinking-dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
            )}
          </span>
        ))}
      </div>
    )
  }

  /** 状态行内动作簇(看板卡与列表行共用) */
  function renderActions(card: BoardCard): ReactNode {
    const busy = busyId === card.id
    return (
      <>
        {(card.status === 'todo' || card.status === 'review') && (
          <button
            type="button"
            className="btn sm"
            disabled={busy || !card.botId}
            title={!card.botId ? t('board.unassigned') : ''}
            onClick={() => void act(card.id, () => api.cardRun(card.id))}
          >
            <Play size={12} /> {card.status === 'todo' ? t('board.run') : t('board.rerun')}
          </button>
        )}
        {card.status === 'review' && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => void doneCard(card)}>
            <SquareKanban size={12} /> {t('board.done')}
          </button>
        )}
        {card.status === 'done' && (
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            onClick={() =>
              void api
                .cardUndone(card.id)
                .then(() => refresh())
                .catch((err) => window.alert(err instanceof Error ? err.message : String(err)))
            }
          >
            <Undo2 size={12} /> {t('board.undone')}
          </button>
        )}
      </>
    )
  }

  function renderCard(card: BoardCard): ReactNode {
    const bot = botOf(card.botId)
    return (
      <div key={card.id} className="kanban-card" onClick={() => openCard(card)}>
        <div className="kanban-card-top">
          <span className="kanban-seq">{t('board.cardSeq', { seq: card.seq })}</span>
          {bot ? (
            <span className="kanban-assignee">
              <ResidentAvatar appearance={bot.appearance} fallbackName={bot.name} fallbackColor={bot.color} size="small" />
              {bot.name}
            </span>
          ) : (
            <span className="kanban-assignee none">{t('board.unassigned')}</span>
          )}
        </div>
        <div className="kanban-card-title">{card.displayTitle || t('board.unnamed')}</div>
        {card.body && <p className="kanban-card-body">{card.body}</p>}
        {renderBadges(card)}
        {card.error && <p className="kanban-card-error">{card.error}</p>}
        {card.threadId && card.threadArchived && <p className="kanban-card-note">{t('board.sessionEnded')}</p>}
        {/* 动作排(阻止冒泡,不触发打开会话/编辑) */}
        <div className="kanban-card-actions" onClick={(e) => e.stopPropagation()}>
          {renderActions(card)}
        </div>
      </div>
    )
  }

  function renderColumn(key: 'todo' | 'running' | 'review', title: string, list: BoardCard[]): ReactNode {
    return (
      <section className="kanban-col" key={key}>
        <div className="kanban-col-title">
          <span>{title}</span>
          <span>{list.length}</span>
        </div>
        <div className="kanban-cards">{list.map(renderCard)}</div>
      </section>
    )
  }

  function renderListHead(key: SortKey, label: string): ReactNode {
    const active = sortKey === key
    return (
      <button
        type="button"
        className={`kanban-th${active ? ' on' : ''}`}
        onClick={() => {
          if (active) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
          else {
            setSortKey(key)
            setSortDir('asc')
          }
        }}
      >
        {label}
        {active && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    )
  }

  const statusLabel = (s: CardStatus): string =>
    s === 'todo' ? t('board.colTodo') : s === 'running' ? t('board.colRunning') : s === 'review' ? t('board.colReview') : t('board.colDone')

  function renderRow(card: BoardCard): ReactNode {
    const bot = botOf(card.botId)
    return (
      <tr key={card.id} className="kanban-row" onClick={() => openCard(card)}>
        <td className="kanban-seq">{t('board.cardSeq', { seq: card.seq })}</td>
        <td className="kanban-cell-title">
          {card.displayTitle || t('board.unnamed')}
          {card.error && <span className="kanban-badge danger">{t('board.badgeFailed')}</span>}
          {card.awaiting && <span className="kanban-badge warn">{t('board.badgeAwaiting')}</span>}
          {card.threadArchived && <span className="kanban-card-note"> {t('board.sessionEnded')}</span>}
        </td>
        <td>
          {bot ? (
            <span className="kanban-assignee">
              <ResidentAvatar appearance={bot.appearance} fallbackName={bot.name} fallbackColor={bot.color} size="small" />
              {bot.name}
            </span>
          ) : (
            <span className="kanban-assignee none">{t('board.unassigned')}</span>
          )}
        </td>
        <td>{statusLabel(card.status)}</td>
        <td>{formatTime(card.lastRunStartedAt)}</td>
        <td>{formatTime(card.createdAt)}</td>
        <td className="kanban-row-actions" onClick={(e) => e.stopPropagation()}>
          {renderActions(card)}
        </td>
      </tr>
    )
  }

  // 设置为二级页面(2026-11-19 走查拍板):整页替换板面/列表,左上返回、右上保存
  if (settingsOpen) return <KanbanSettingsPage onBack={() => setSettingsOpen(false)} />

  return (
    <div className="kanban-view">
      <div className="kanban-head">
        <h1>{t('board.title')}</h1>
        <span className="kanban-count">{cards.length}</span>
        <span className="kanban-spacer" />
        <div className="kanban-view-toggle">
          <button type="button" className={viewMode === 'board' ? 'on' : ''} onClick={() => switchView('board')}>
            {t('board.tabBoard')}
          </button>
          <button type="button" className={viewMode === 'list' ? 'on' : ''} onClick={() => switchView('list')}>
            {t('board.tabList')}
          </button>
        </div>
        <button type="button" className="btn sm primary" onClick={() => setEditor({ card: null })}>
          {t('board.newCard')}
        </button>
        <button type="button" className="icon-btn sm" title={t('board.settings')} onClick={() => setSettingsOpen(true)}>
          <Settings size={15} />
        </button>
      </div>
      {hint && <div className="kanban-hint">{hint}</div>}

      {loaded && cards.length === 0 ? (
        <div className="kanban-empty">
          <SquareKanban size={32} />
          <p>{t('board.empty')}</p>
          <p className="sub">{t('board.emptyHint')}</p>
        </div>
      ) : viewMode === 'board' ? (
        <div className="kanban-board">
          {renderColumn('todo', t('board.colTodo'), byCol.todo)}
          {renderColumn('running', t('board.colRunning'), byCol.running)}
          {renderColumn('review', t('board.colReview'), byCol.review)}
          <section className="kanban-col">
            <button type="button" className="kanban-done-toggle" onClick={() => toggleDone()}>
              {t(doneOpen ? 'board.doneToggleHide' : 'board.doneToggleShow', {
                count: byCol.done.length
              })}
            </button>
            {doneOpen && <div className="kanban-cards">{byCol.done.map(renderCard)}</div>}
          </section>
        </div>
      ) : (
        <div className="kanban-list-wrap">
          <table className="kanban-list">
            <thead>
              <tr>
                {renderListHead('seq', t('board.listSeq'))}
                {renderListHead('title', t('board.listTitle'))}
                <th className="kanban-th-plain">{t('board.listResident')}</th>
                {renderListHead('status', t('board.listStatus'))}
                {renderListHead('lastRun', t('board.listLastRun'))}
                {renderListHead('created', t('board.listCreated'))}
                <th className="kanban-th-blank" />
              </tr>
            </thead>
            <tbody>{sorted.map(renderRow)}</tbody>
          </table>
        </div>
      )}

      {editor && (
        <KanbanCardEditor
          bots={bots}
          card={editor.card}
          onOpenTask={onOpenTask}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

/** 应用内确认弹窗(走查拍板):删卡/放弃未保存改动等二选一确认,不再用系统 confirm */
function KanbanConfirm({
  message,
  danger,
  onConfirm,
  onClose
}: {
  message: string
  /** 危险动作:确认键红底(删卡) */
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal kanban-confirm">
        <p className="kanban-confirm-msg">{message}</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
            {t('board.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

// 新建/编辑卡弹窗:与 TaskModal 同壳(居民单选列表 + 工作目录行),正文/目录随 textarea 手填;
// 执行过的卡正文与工作目录锁定(主进程也有同款守卫,这里先给灰显+说明)
function KanbanCardEditor({
  bots,
  card,
  onOpenTask,
  onClose,
  onSaved
}: {
  bots: Bot[]
  card: BoardCard | null
  onOpenTask: (threadId: string) => void
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(card?.title ?? '')
  const [body, setBody] = useState(card?.body ?? '')
  const [botId, setBotId] = useState<string | null>(card?.botId ?? null)
  const [workdir, setWorkdir] = useState<string | null>(card?.workdirPath ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 删除确认(走查拍板:删卡入口收进编辑器,应用内弹窗确认)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const locked = !!card?.threadId

  // 未保存确认(需求 §6.2):编辑比初始值有变 / 新建已填任一字段,关闭前确认一次(应用内弹窗)
  const [confirmClose, setConfirmClose] = useState(false)
  const dirty = card
    ? title !== card.title || body !== card.body || botId !== card.botId || workdir !== card.workdirPath
    : title.trim() !== '' || body.trim() !== '' || botId !== null || workdir !== null

  function requestClose(): void {
    if (dirty) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  async function pickWorkdir(): Promise<void> {
    const dir = await api.pickDirectory()
    if (dir && !locked) setWorkdir(dir)
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    const input = { title, body, botId, workdirPath: workdir }
    try {
      if (card) await api.cardUpdate(card.id, input)
      else await api.cardCreate(input)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  function removeCard(): void {
    if (!card) return
    api
      .cardDelete(card.id)
      .then(() => onSaved())
      .catch((err) => window.alert(err instanceof Error ? err.message : String(err)))
  }

  return (
    <>
      <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
        <div className="modal kanban-editor">
          <div className="kanban-editor-head">
            <h2>
              <SquareKanban size={18} /> {t(card ? 'board.editorTitleEdit' : 'board.editorTitleNew')}
            </h2>
            {card?.threadId && !card.threadArchived && (
              <button type="button" className="btn sm ghost" onClick={() => onOpenTask(card.threadId!)}>
                {t('board.openSession')}
              </button>
            )}
          </div>

          <label className="kanban-field">
            <span>{t('board.fieldTitle')}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
          </label>

          <label className="kanban-field">
            <span>{t('board.fieldBody')}</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} disabled={locked} />
            {locked && <p className="kanban-locked-note">{t('board.bodyLocked')}</p>}
          </label>

          <div className="kanban-field">
            <span>{t('board.fieldAssignee')}</span>
            {/* 居民单选:横向换行 chips(走查拍板,弃纵向滚动列表) */}
            <div className="kanban-pick-row">
              {bots.map((bot) => {
                const picked = botId === bot.id
                return (
                  <button
                    key={bot.id}
                    type="button"
                    className={`kanban-chip${picked ? ' on' : ''}`}
                    title={bot.isMain ? t('common.steward') : undefined}
                    onClick={() => setBotId(picked ? null : bot.id)}
                  >
                    <ResidentAvatar appearance={bot.appearance} fallbackName={bot.name} fallbackColor={bot.color} size="small" />
                    {bot.name}
                  </button>
                )
              })}
            </div>
            {bots.length === 0 && <p className="modal-lead">{t('group.noResidents')}</p>}
          </div>

          <div className="kanban-field">
            <span>{t('board.fieldWorkdir')}</span>
            <div className="task-workdir-row">
              {workdir ? (
                <>
                  <FolderOpen size={15} />
                  <span className="task-workdir-path" title={workdir}>
                    {workdir}
                  </span>
                  {!locked && (
                    <button type="button" className="icon-btn sm" title={t('common.cancel')} onClick={() => setWorkdir(null)}>
                      <X size={13} />
                    </button>
                  )}
                </>
              ) : (
                !locked && (
                  <>
                    <Folder size={15} />
                    <button type="button" className="btn sm ghost" disabled={locked} onClick={() => void pickWorkdir()}>
                      {t('task.workdirPick')}
                    </button>
                  </>
                )
              )}
            </div>
          </div>

          {error && <div className="wizard-error">{error}</div>}

          <div className="modal-actions">
            {card && (
              <button className="btn ghost danger-ghost" disabled={saving} onClick={() => setConfirmDelete(true)}>
                {t('board.delete')}
              </button>
            )}
            <button className="btn ghost" disabled={saving} onClick={requestClose}>
              {t('common.cancel')}
            </button>
            <button className="btn primary" disabled={saving} onClick={() => void save()}>
              {saving ? t('common.loading') : t('board.save')}
            </button>
          </div>
        </div>
      </div>
      {confirmClose && <KanbanConfirm message={t('board.unsavedConfirm')} onConfirm={onClose} onClose={() => setConfirmClose(false)} />}
      {confirmDelete && card && (
        <KanbanConfirm
          danger
          message={t('board.deleteConfirm', { title: card.displayTitle || t('board.unnamed') })}
          onConfirm={() => removeCard()}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </>
  )
}

// 看板设置·二级页面(2026-11-19 第二批;走查两轮拍板:页化+删诊断+即时保存):
// 即时保存与全局设置页 2026-11-09 走查统一——档位点击即存,提示词停顿 600ms 自动落库(离开冲刷),
// 无保存按钮、无未保存确认。顺序:智能 > 什么都不做 > 发送提示词;提示词文本域内联在选项正下方。
// 内容沿用设置页设计规范总纲(小节标题灰常规体/内容进 .settings-card);不进全局设置页。
function KanbanSettingsPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'none' | 'prompt' | 'smart'>('smart')
  const [text, setText] = useState('')
  const [defaults, setDefaults] = useState<string>('')
  const [customized, setCustomized] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // 即时保存的家伙什:600ms 停顿定时器 + 最新输入(ref 供卸载冲刷,闭包不陈)
  const saveTimer = useRef<number | null>(null)
  const latest = useRef({
    text: '',
    mode: 'smart' as 'none' | 'prompt' | 'smart',
    defaults: '',
    loaded: false
  })
  latest.current = { text, mode, defaults, loaded }

  useEffect(() => {
    api
      .cardsPrefsGet()
      .then((p) => {
        setDefaults(p.finishPromptDefault)
        setMode(p.finishMode)
        const effective = p.finishPrompt ?? p.finishPromptDefault
        setText(effective)
        setCustomized(p.finishPrompt !== null)
        setLoaded(true)
      })
      .catch(console.error)
  }, [])

  useEffect(() => {
    if (!savedFlash) return
    const id = setTimeout(() => setSavedFlash(false), 1500)
    return () => clearTimeout(id)
  }, [savedFlash])

  async function flushSave(): Promise<void> {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const s = latest.current
    if (!s.loaded || s.mode !== 'prompt') return
    // 空/等于默认文案 → null(用默认);其余=自定义
    const next = s.text === s.defaults ? null : s.text
    try {
      const p = await api.cardsPrefsSet({ finishPrompt: next })
      setCustomized(p.finishPrompt !== null)
      setSavedFlash(true)
    } catch (err) {
      console.error(err)
    }
  }

  function pickMode(next: 'none' | 'prompt' | 'smart'): void {
    setMode(next)
    if (!loaded) return
    void api.cardsPrefsSet({ finishMode: next }).catch(console.error)
  }

  function onTextChange(raw: string): void {
    setText(raw)
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => void flushSave(), 600)
  }

  // 离开页面(返回/切视图卸载)冲刷未落库的输入
  useEffect(
    () => () => {
      if (saveTimer.current !== null) void flushSave()
    },
    []
  )

  const choices: {
    key: 'none' | 'prompt' | 'smart'
    name: string
    desc: string
  }[] = [
    {
      key: 'smart',
      name: t('board.finishSmart'),
      desc: t('board.finishSmartDesc')
    },
    {
      key: 'none',
      name: t('board.finishNone'),
      desc: t('board.finishNoneDesc')
    },
    {
      key: 'prompt',
      name: t('board.finishPromptLabel'),
      desc: t('board.finishPromptDesc')
    }
  ]

  return (
    <div className="kanban-view">
      <div className="kanban-head">
        <button type="button" className="icon-btn sm" title={t('common.back')} onClick={onBack}>
          <ArrowLeft size={16} />
        </button>
        <h1>{t('board.settings')}</h1>
      </div>

      <div className="kanban-settings">
        <label className="field-label card-section-title">{t('board.finishTitle')}</label>
        <div className="settings-card pad kanban-choices">
          {choices.map((c) => (
            <Fragment key={c.key}>
              <button type="button" className={`kanban-choice${mode === c.key ? ' on' : ''}`} onClick={() => pickMode(c.key)}>
                <span className="kanban-choice-dot" aria-hidden />
                <span className="kanban-choice-text">
                  <span className="kanban-choice-name">{c.name}</span>
                  <span className="kanban-choice-desc">{c.desc}</span>
                </span>
              </button>
              {/* 提示词文本域内联在选项正下方(走查拍板),不再是下方独立卡 */}
              {c.key === 'prompt' && mode === 'prompt' && (
                <div className="kanban-prompt-inline">
                  <textarea value={text} onChange={(e) => onTextChange(e.target.value)} rows={4} />
                  <div className="kanban-prompt-tools">
                    <button type="button" className="btn sm ghost" onClick={() => onTextChange(defaults)}>
                      {t('board.settingsReset')}
                    </button>
                    {savedFlash && <span className="kanban-saved">{t('board.saved')}</span>}
                  </div>
                  <p className="kanban-locked-note">
                    {t('board.finishPromptEmpty')} ·{' '}
                    {t('board.settingsFinishState', {
                      state: customized ? t('board.settingsStateCustom') : t('board.settingsStateDefault')
                    })}
                  </p>
                </div>
              )}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}
