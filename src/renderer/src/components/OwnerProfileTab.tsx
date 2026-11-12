import { useEffect, useState } from 'react'
import { History, Loader2, Pencil, Sparkles, X } from 'lucide-react'
import type { Bot, OwnerProfileState, OwnerObservation, OwnerSection, OwnerStatement } from '@shared/types'
import { api, onOwnerChanged } from '../api'
import { useTranslation } from '../i18n'

// 岛主档案(M6.11–6.13 机制不变;2026-11-09 走查重排:不再外露分节,与其他居民记忆同款一条条,
// 分类收为行首小签;观察原话并入同一列表,「整理」按钮只在有待整理时出现)
// 机制保留:画像注入所有居民上下文/观察→档案管家自动整理/取代链历史/改派逃生舱

type TFn = (key: string, opts?: Record<string, unknown>) => string

function sections(t: TFn): { id: OwnerSection; label: string }[] {
  return [
    { id: 'identity', label: t('owner.secIdentity') },
    { id: 'preference', label: t('owner.secPreference') },
    { id: 'communication', label: t('owner.secCommunication') },
    { id: 'relation', label: t('owner.secRelation') },
    { id: 'attention', label: t('owner.secAttention') },
    { id: 'taboo', label: t('owner.secTaboo') }
  ]
}

/** 行首小签:分类的短名(编辑器里新增时用完整名下拉) */
function tagOf(t: TFn, section: OwnerSection): string {
  const map: Record<OwnerSection, string> = {
    identity: t('owner.tagIdentity'),
    preference: t('owner.tagPreference'),
    communication: t('owner.tagCommunication'),
    relation: t('owner.tagRelation'),
    attention: t('owner.tagAttention'),
    taboo: t('owner.tagTaboo')
  }
  return map[section]
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

interface EditorState {
  /** null = 新增 */
  id: string | null
  section: OwnerSection
}

export default function OwnerProfileTab({
  openAdd = false,
  onAddClose
}: {
  /** 卡头「＋添加」联动:置 true 时在列表顶部展开新增编辑器 */
  openAdd?: boolean
  onAddClose?: () => void
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<OwnerProfileState | null>(null)
  const [bots, setBots] = useState<Bot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'curate' | 'extract' | null>(null)
  const [editing, setEditing] = useState<EditorState | null>(null)
  const [sourcesOf, setSourcesOf] = useState<OwnerStatement | null>(null)
  const [historyOf, setHistoryOf] = useState<OwnerStatement | null>(null)

  useEffect(() => {
    const load = (): void => {
      api.ownerProfile().then(setState).catch(console.error)
    }
    load()
    api.botsList().then(setBots).catch(console.error)
    // 后台整理(自动触发)完成时静默刷新
    return onOwnerChanged(load)
  }, [])

  const pendingCount = state?.observations.filter((o) => o.status === 'pending').length ?? 0

  async function curate(): Promise<void> {
    setBusy('curate')
    setError(null)
    try {
      setState(await api.ownerCurate())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function extract(): Promise<void> {
    setBusy('extract')
    setError(null)
    try {
      setState(await api.ownerExtract())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function addStatement(section: OwnerSection, text: string): Promise<void> {
    try {
      setState(await api.ownerAddStatement({ section, text }))
      onAddClose?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function updateStatement(id: string, text: string): Promise<void> {
    try {
      setState(await api.ownerUpdateStatement(id, { text }))
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function removeStatement(id: string): Promise<void> {
    try {
      setState(await api.ownerDeleteStatement(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 逃生舱:这条画像改派为某位居民的私人记忆(全岛共知 → 只有 TA 知道) */
  async function assignStatement(id: string, botId: string): Promise<void> {
    try {
      setState(await api.ownerAssignStatement(id, botId))
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function removeObservation(id: string): Promise<void> {
    try {
      setState(await api.ownerDeleteObservation(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const obsById = new Map((state?.observations ?? []).map((o) => [o.id, o]))
  const statements = state?.statements ?? []
  const observations = state?.observations ?? []
  const nothingHere = statements.length === 0 && observations.length === 0 && !openAdd && !editing

  return (
    <div className="owner-panel">
      {/* 动作行(收窄):整理只在有待整理时出现;从旧整理常驻但只占一粒图标位,右对齐不抢视线 */}
      <div className="owner-actions">
        {(pendingCount > 0 || busy !== null) && (
          <button className="btn ghost sm" disabled={busy !== null} onClick={() => void curate()}>
            {busy === 'curate' ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
            {busy === 'curate' ? t('owner.curating') : t('owner.curateCount', { count: pendingCount })}
          </button>
        )}
        <span className="owner-actions-spacer" />
        <button
          className="icon-btn ghost-btn sm"
          disabled={busy !== null}
          onClick={() => void extract()}
          title={t('owner.extractTitle')}
        >
          {busy === 'extract' ? <Loader2 size={13} className="spin" /> : <History size={13} />}
        </button>
      </div>

      {error && <div className="wizard-error">{error}</div>}

      <div className="owner-flat">
        {/* 卡头「＋添加」展开的新增编辑器(带分类下拉) */}
        {openAdd && (
          <StatementEditor
            mode="add"
            initialText=""
            bots={[]}
            onCancel={() => onAddClose?.()}
            onSave={(text, section) => void addStatement(section, text)}
          />
        )}

        {nothingHere && <p className="modal-lead">{t('owner.emptyFlat')}</p>}

        {sections(t).flatMap((sec) =>
          statements
            .filter((s) => s.section === sec.id)
            .map((st) =>
              editing?.id === st.id ? (
                <StatementEditor
                  key={st.id}
                  mode="edit"
                  initialText={st.text}
                  stmt={st}
                  bots={bots ?? []}
                  onCancel={() => setEditing(null)}
                  onSave={(text) => void updateStatement(st.id, text)}
                  onAssign={(botId) => void assignStatement(st.id, botId)}
                  onSources={() => setSourcesOf(st)}
                  onHistory={() => setHistoryOf(st)}
                />
              ) : (
                <FlatRow
                  key={st.id}
                  tag={tagOf(t, st.section)}
                  text={st.text}
                  date={st.lastConfirmed}
                  title={t('common.edit')}
                  dimmed={!!st.expiresAt && st.expiresAt < todayStr()}
                  onEdit={() => setEditing({ id: st.id, section: st.section })}
                  onDelete={() => void removeStatement(st.id)}
                />
              )
            )
        )}

        {[...observations].reverse().map((o) => (
          <FlatRow
            key={o.id}
            tag={t('owner.tagObservation')}
            tagObs={o.status}
            text={o.text}
            date={o.date}
            title={obsTitle(t, o)}
            dimmed={o.status === 'rejected'}
            onDelete={() => void removeObservation(o.id)}
          />
        ))}
      </div>

      {sourcesOf && <SourcesModal stmt={sourcesOf} obsById={obsById} onClose={() => setSourcesOf(null)} />}
      {historyOf && state && (
        <HistoryModal stmt={historyOf} history={state.history} onClose={() => setHistoryOf(null)} />
      )}
    </div>
  )
}

function obsTitle(t: TFn, o: OwnerObservation): string {
  const map: Record<OwnerObservation['status'], string> = {
    pending: t('owner.obsPending'),
    merged: t('owner.obsMerged'),
    rejected: t('owner.obsRejected')
  }
  return `${t('owner.tagObservation')} · ${map[o.status]} · ${t('owner.obsFrom', { date: o.date, bot: o.botName })}`
}

/** 扁平条目:行首分类小签 + 一句正文 + 日期,悬停出编辑/删除 */
function FlatRow({
  tag,
  tagObs,
  text,
  date,
  title,
  dimmed,
  onEdit,
  onDelete
}: {
  tag: string
  /** 观察条目的状态:待整理琥珀签/其余灰签 */
  tagObs?: OwnerObservation['status']
  text: string
  date: string
  title: string
  dimmed?: boolean
  onEdit?: () => void
  onDelete: () => void
}) {
  return (
    <div className={`owner-row ${dimmed ? 'dim' : ''}`}>
      <span className={`owner-tag ${tagObs === 'pending' ? 'warn' : ''}`} title={title}>
        {tag}
      </span>
      <span className="owner-row-text">{text}</span>
      <span className="owner-row-date num">{date}</span>
      <span className="owner-row-actions">
        {onEdit && (
          <button className="owner-act" title={title} onClick={onEdit}>
            <Pencil size={13} />
          </button>
        )}
        <button className="owner-act" title={title} onClick={onDelete}>
          <X size={13} />
        </button>
      </span>
    </div>
  )
}

/** 条目编辑器:新增(带分类下拉)/编辑(保存+改派+出处/历史) */
function StatementEditor({
  mode,
  initialText,
  stmt,
  bots,
  onCancel,
  onSave,
  onAssign,
  onSources,
  onHistory
}: {
  mode: 'add' | 'edit'
  initialText: string
  /** 编辑态的画像(供出处/历史入口判空) */
  stmt?: OwnerStatement
  /** 编辑态非空时可「改派」 */
  bots: Bot[]
  onCancel: () => void
  onSave: (text: string, section: OwnerSection) => void
  onAssign?: (botId: string) => void
  onSources?: () => void
  onHistory?: () => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(initialText)
  const [section, setSection] = useState<OwnerSection>(stmt?.section ?? 'identity')
  const [assignTo, setAssignTo] = useState('')
  return (
    <div className="owner-editor">
      <textarea
        className="input"
        rows={2}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        placeholder={t('owner.stmtFlatPlaceholder')}
      />
      <div className="owner-editor-row">
        {mode === 'add' && (
          <select className="input select" value={section} onChange={(e) => setSection(e.target.value as OwnerSection)}>
            {sections(t).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        {mode === 'edit' && stmt && stmt.sources.length > 0 && (
          <button className="owner-chip" onClick={onSources}>
            {t('owner.nSources', { count: stmt.sources.length })}
          </button>
        )}
        {mode === 'edit' && stmt?.supersedes && (
          <button className="owner-chip" onClick={onHistory}>
            <History size={11} /> {t('owner.historyLink')}
          </button>
        )}
        <span className="owner-editor-spacer" />
        <button className="btn ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          className="btn primary"
          disabled={!text.trim()}
          onClick={() => onSave(text.trim(), mode === 'add' ? section : (stmt?.section ?? section))}
        >
          {mode === 'add' ? t('owner.record') : t('common.save')}
        </button>
      </div>
      {mode === 'edit' && bots.length > 0 && onAssign && (
        <div className="owner-editor-row assign">
          <span className="owner-section-hint">{t('owner.assignHint')}</span>
          <select className="input select" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
            <option value="">{t('owner.assignPick')}</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button className="btn ghost" disabled={!assignTo} onClick={() => onAssign(assignTo)}>
            {t('owner.assignMove')}
          </button>
        </div>
      )}
    </div>
  )
}

/** 出处浮窗:这条画像由哪些观察支撑(居民原话) */
function SourcesModal({
  stmt,
  obsById,
  onClose
}: {
  stmt: OwnerStatement
  obsById: Map<string, OwnerObservation>
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal owner-pop">
        <div className="exchange-title">
          {t('owner.sourcesTitle')}
          <button className="icon-btn ghost-btn sm" onClick={onClose} title={t('common.close')}>
            <X size={14} />
          </button>
        </div>
        <p className="modal-lead">{stmt.text}</p>
        <div className="obs-list">
          {stmt.sources.map((id) => {
            const obs = obsById.get(id)
            return (
              <div className="obs-item" key={id}>
                <div className="obs-text">{obs?.text ?? t('owner.obsGone')}</div>
                <div className="obs-meta">
                  <span className="obs-sub">{obs ? t('owner.obsFrom', { date: obs.date, bot: obs.botName }) : id}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** 历史浮窗:沿取代链回看这条画像的旧版本(合并留痕,不覆盖) */
function HistoryModal({
  stmt,
  history,
  onClose
}: {
  stmt: OwnerStatement
  history: OwnerStatement[]
  onClose: () => void
}) {
  const byId = new Map(history.map((s) => [s.id, s]))
  const chain: OwnerStatement[] = []
  const { t } = useTranslation()
  let cursor: string | undefined = stmt.supersedes
  while (cursor && byId.has(cursor)) {
    const older = byId.get(cursor)!
    chain.push(older)
    cursor = older.supersedes
  }
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal owner-pop">
        <div className="exchange-title">
          {t('owner.historyTitle')}
          <button className="icon-btn ghost-btn sm" onClick={onClose} title={t('common.close')}>
            <X size={14} />
          </button>
        </div>
        <p className="modal-lead">{t('owner.current', { text: stmt.text })}</p>
        <div className="obs-list">
          {chain.length === 0 && <p className="modal-lead">{t('owner.noHistory')}</p>}
          {chain.map((older) => (
            <div className="obs-item" key={older.id}>
              <div className="obs-text">{older.text}</div>
              <div className="obs-meta">
                <span className="obs-sub">
                  {older.firstSeen} ~ {older.lastConfirmed} · {t('owner.superseded')}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
