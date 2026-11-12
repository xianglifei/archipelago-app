import { useEffect, useRef, useState } from 'react'
import { CircleHelp, Plus, X } from 'lucide-react'
import type { MemoryState } from '@shared/types'
import { api } from '../api'
import OwnerProfileTab from './OwnerProfileTab'
import { useTranslation } from '../i18n'

// 记忆面板(M6.5 雏形 + M6.11):按作用域列出全部条目,支持增删
// 作用域顺序 = 岛主档案 → 集体记忆 → 每位居民(关于岛主的事实归档案,岛上约定归集体,分工笔记归居民)
// 默认展示全部作用域(设置里);传 fixedScopes 时只展示指定作用域(居民档案里)
export default function MemoryPanel({
  fixedScopes,
  initialScope
}: {
  fixedScopes?: { id: string; label: string }[]
  /** 打开时预选的作用域(侧栏「岛主」入口跳转用);不传则各场景默认 */
  initialScope?: string
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<MemoryState | null>(null)
  const [scope, setScope] = useState<string>(() => initialScope ?? fixedScopes?.[0]?.id ?? 'shared')
  const [draft, setDraft] = useState('')
  // 添加行(2026-11-09 走查:入口收进卡头「＋添加」,输入行内联出现在列表顶部,不再常驻卡底)
  const [adding, setAdding] = useState(false)
  const addInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  // 删除进行中:行号会在删除后重排,快照行号的并发第二删会误删另一条——串行化,刷新回来才放行
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    api.memoryList().then(setState).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  // 居民档案里的面板刻意保持挂载、只换 fixedScopes(切居民):scope 还停在上一位的 id 就会
  // 展示并增删上一位的记忆(跨居民误写)。作用域不在新名单里立即切换到新居民
  useEffect(() => {
    if (fixedScopes && !fixedScopes.some((s) => s.id === scope)) {
      setScope(fixedScopes[0]?.id ?? 'shared')
    }
  }, [fixedScopes, scope])

  const scopes =
    fixedScopes ?? [
      { id: 'owner', label: t('memory.ownerScope') },
      { id: 'shared', label: t('memory.sharedScope') },
      ...(state?.bots.map((b) => ({ id: b.botId, label: b.botName })) ?? [])
    ]
  const currentBot = state?.bots.find((b) => b.botId === scope)
  const entries = scope === 'shared' ? state?.shared ?? [] : currentBot?.entries ?? []

  async function add(): Promise<void> {
    const text = draft.trim()
    if (!text) return
    try {
      setState(await api.memoryAdd(scope, text))
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function remove(line: number): Promise<void> {
    if (removing) return
    setRemoving(true)
    try {
      setState(await api.memoryDelete(scope, line))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving(false)
    }
  }

  // 页题+说明浮窗(2026-11-09 走查):导语整句收进标题旁问号浮窗,不再占一整卡;
  // 标题在内容最顶行,浮窗朝下开(qmark-down),朝上会被滚动容器上缘裁掉
  const head = (
    <label className="field-label card-section-title qmark-host">
      {t('memory.manageTitle')}
      <span className="qmark qmark-down" data-tip={t('memory.lead')} tabIndex={0} aria-label={t('memory.lead')}>
        <CircleHelp size={13} />
      </span>
    </label>
  )
  const tabs = (
    <div className="mem-tabs-head">
      {/* 单一作用域(居民档案里只看 TA 自己的记忆)不渲染页签行,卡头只剩「＋添加」 */}
      {scopes.length > 1 && (
        <div className="tabs">
          {scopes.map((s) => (
            <button key={s.id} className={`tab ${s.id === scope ? 'active' : ''}`} onClick={() => setScope(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      {/* 添加入口在卡头右端(2026-11-09 走查):与页签同排,点开在列表顶部内联输入 */}
      <button
        className={`btn ghost sm mem-add-btn ${adding ? 'active' : ''}`}
        onClick={() => {
          setAdding((v) => !v)
          // 展开即聚焦;收起时清草稿,不留半截输入
          if (!adding) window.setTimeout(() => addInputRef.current?.focus(), 0)
          else setDraft('')
        }}
      >
        <Plus size={13} /> {t('memory.add')}
      </button>
    </div>
  )

  // 内联添加行:回车=提交并连记,Esc=收起;空草稿失焦也收起
  const inlineAdd = adding && (
    <div className="mem-inline-add">
      <input
        ref={addInputRef}
        className="input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('memory.addPlaceholder')}
        onBlur={() => {
          if (!draft.trim()) setAdding(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void add()
          }
          if (e.key === 'Escape') {
            setDraft('')
            setAdding(false)
          }
        }}
      />
    </div>
  )

  // 岛主档案是结构化数据,但 2026-11-09 走查后与其他作用域同款扁平条目呈现;openAdd 联动卡头「＋添加」
  if (scope === 'owner') {
    return (
      <div className="memory-panel">
        {head}
        <div className="mem-tabs-card">
          {tabs}
          <div className="mem-inner mem-card">
            <OwnerProfileTab
              openAdd={adding}
              onAddClose={() => {
                setAdding(false)
                setDraft('')
              }}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="memory-panel">
      {head}
      <div className="mem-tabs-card">
        {tabs}
        <div className="mem-inner mem-card">
          {inlineAdd}
          <div className="mem-list">
            {state && entries.length === 0 && !adding && <p className="modal-lead">{t('memory.empty')}</p>}
            {entries.map((entry) => (
              <div className="mem-entry" key={entry.line}>
                <span className="mem-date">{entry.date}</span>
                <span className="mem-text">{entry.text}</span>
                <button
                  className="bot-remove visible"
                  title={t('common.delete')}
                  disabled={removing}
                  onClick={() => void remove(entry.line)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>

          {error && <div className="wizard-error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
