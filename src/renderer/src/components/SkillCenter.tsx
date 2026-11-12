import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bird,
  Briefcase,
  Car,
  Check,
  ChevronDown,
  ChevronRight,
  Coffee,
  MapPin,
  MessageCircle,
  Music2,
  Plane,
  Sparkles,
  Utensils,
  Video,
  X
} from 'lucide-react'
import type {
  ConnectorDetail,
  IslandConnectorSummary,
  IslandSkillDetail,
  IslandSkillSummary,
  OfficialCatalogData,
  OfficialSkillCard
} from '@shared/types'
import { api } from '../api'
import { onConnectorsChanged, onSkillsChanged } from '../api'
import { useTranslation } from '../i18n'

// 技能中心(2026-11-05 二期,原型=doc/原型 - 技能中心双Tab布局 - 2026-11-05.html 第七版):
// 顶部横排双 Tab——精选推荐(分类分组卡片货架)/岛上的技能(清单+展开详情+安装到…/冻结/删除)。
// 2026-11-06 MCP 连接器接入(Felix 拍板:零新 Tab、零新概念):连接器目录卡与技能卡在精选推荐
// 同货架混排(按 transport 字段分流安装路径,安装时自然地问一次 Key),岛上清单同样混排;
// 手动添加入口(「添加自定义服务」)同日 Felix 走查拍板移除——普通用户装服务走目录卡即可,
// 真有自定义需求会找居民;主进程 mcpAddManual 与 IPC 保留(集成测试构造入口,后续可复用)。
// 用户侧全程不出现「连接器/MCP/协议」字样。

type Tab = 'official' | 'island'

/** 岛上清单统一行(技能卡 + 连接器混排) */
type IslandRow = { kind: 'skill'; s: IslandSkillSummary } | { kind: 'conn'; c: IslandConnectorSummary }

/** 目录图标白名单(云端 catalog.icon 渲染端兜底 Sparkles;与 console SKILL_ICON_SVGS 同源) */
const CARD_ICONS: Record<string, typeof Sparkles> = {
  bird: Bird,
  'message-circle': MessageCircle,
  briefcase: Briefcase,
  video: Video,
  coffee: Coffee,
  plane: Plane,
  'music-2': Music2,
  'map-pin': MapPin,
  car: Car,
  utensils: Utensils
}

function cardIcon(name: string): typeof Sparkles {
  return CARD_ICONS[name] ?? Sparkles
}

/** 一句话描述:默认最多三行收起,超出显示「展开全文」文字链接,展开后约八行高带滚动 */
function ModalDesc({ text }: { text: string }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLParagraphElement>(null)
  const [expandable, setExpandable] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    setExpandable(false)
    setOpen(false)
  }, [text])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      if (el.classList.contains('skc-desc-open')) return
      setExpandable(el.scrollHeight > el.clientHeight + 2)
    }
    const raf = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(raf)
  }, [text])
  return (
    <div className="skc-mblock">
      <p ref={ref} className={`skc-desc ${open ? 'skc-desc-open' : ''}`}>{text}</p>
      {expandable && (
        <button
          className="skc-dtoggle"
          onClick={() => {
            setOpen((v) => !v)
            if (ref.current) ref.current.scrollTop = 0
          }}
        >
          {open ? t('skills.collapse') : t('skills.expand')}
        </button>
      )}
    </div>
  )
}

/** 官方卡详情浮窗(第五~七轮定稿样式)。
 *  连接器卡(transport 非空)点「安装」先取模板占位符:有则进入填 Key 步(占位符名即输入框标签),
 *  无则直接装;填写信息只在岛主本机。技能卡安装路径原样不动 */
function OfficialModal({
  card,
  installed,
  busy,
  onInstallSkill,
  onInstallConnector,
  onClose
}: {
  card: OfficialSkillCard
  installed: boolean
  busy: boolean
  onInstallSkill: () => void
  onInstallConnector: (values: Record<string, string>) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const isConnector = card.transport === 'http' || card.transport === 'stdio'
  const [placeholders, setPlaceholders] = useState<string[] | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  useEffect(() => {
    setPlaceholders(null)
    setValues({})
  }, [card.name])
  const isRepo = card.url.includes('github.com')
  // 显示层不改写内容:去协议头与结尾斜杠,单行截断(前缀完整、尾部省略)交给 CSS
  const displayUrl = card.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const install = (): void => {
    if (!isConnector) {
      onInstallSkill()
      return
    }
    if (placeholders === null) {
      api
        .mcpTemplatePlaceholders(card.name)
        .then((ph) => {
          if (ph.length === 0) onInstallConnector({})
          else setPlaceholders(ph)
        })
        .catch(() => onInstallConnector({}))
      return
    }
    onInstallConnector(values)
  }
  return (
    <div className="skc-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="skc-modal" role="dialog" aria-modal="true" aria-label={card.name}>
        <button className="skc-mclose" aria-label={t('skills.close')} onClick={onClose}>
          <X size={15} />
        </button>
        <div className="skc-mhead">
          <h3>{card.name}</h3>
          <button className="skc-mbtn" disabled={installed || busy} onClick={install}>
            {installed ? (
              <>
                <Check size={12} /> {t('skills.installedShort')}
              </>
            ) : busy ? (
              t('skills.installing')
            ) : placeholders !== null ? (
              t('skills.mcpConfirmInstall')
            ) : (
              t('skills.install')
            )}
          </button>
        </div>
        <ModalDesc text={card.description} />
        {placeholders !== null && (
          <div className="skc-mblock">
            <div className="skc-mlabel">{t('skills.mcpKeyStepTitle')}</div>
            <p className="skc-keyhint">{t('skills.mcpKeyHint')}</p>
            {placeholders.map((name) => (
              <label key={name} className="skc-keyrow">
                <span className="skc-keyname">{name}</span>
                <input
                  type="password"
                  value={values[name] ?? ''}
                  placeholder={t('skills.mcpKeyPlaceholder')}
                  onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        )}
        <div className="skc-mblock">
          <div className="skc-mlabel">{isConnector ? t('skills.mcpDetailLabel') : t('skills.detailLabel')}</div>
          <div className="skc-detail">{card.detail}</div>
        </div>
        <div className="skc-src">
          <span className="skc-src-label">{isRepo ? t('skills.repoLabel') : t('skills.siteLabel')}</span>
          <a href={card.url} target="_blank" rel="noreferrer" title={card.url}>
            {displayUrl}
          </a>
        </div>
      </div>
    </div>
  )
}

export default function SkillCenter() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('official')
  const [catalog, setCatalog] = useState<OfficialCatalogData | null>(null)
  const [islands, setIslands] = useState<IslandSkillSummary[]>([])
  const [connectors, setConnectors] = useState<IslandConnectorSummary[]>([])
  const [residents, setResidents] = useState<{ id: string; name: string }[]>([])
  const [modalCard, setModalCard] = useState<OfficialSkillCard | null>(null)
  const [installBusy, setInstallBusy] = useState(false)
  // 详情按 id 各存一份:展开允许多行同时开,单槽会被后展开的顶掉、先展开的永卡「加载中」
  const [skillDetails, setSkillDetails] = useState<Map<number, IslandSkillDetail>>(new Map())
  const [connDetails, setConnDetails] = useState<Map<string, ConnectorDetail>>(new Map())
  const [detailOpen, setDetailOpen] = useState<Set<string>>(new Set())
  const [installToOpen, setInstallToOpen] = useState<string | null>(null)
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const say = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }, [])

  const refresh = useCallback(() => {
    api.skillsCenterList().then(setIslands).catch((e) => say(e.message ?? String(e)))
    api.mcpList().then(setConnectors).catch(() => {})
    void api.skillsCatalog().then(setCatalog).catch(() => setCatalog(null))
  }, [say])

  useEffect(() => {
    refresh()
    api.botsList().then((bots) => setResidents(bots.map((b) => ({ id: b.id, name: b.name })))).catch(() => {})
    const offSkills = onSkillsChanged(() => refresh())
    const offConn = onConnectorsChanged(() => refresh())
    return () => {
      offSkills()
      offConn()
    }
  }, [refresh])

  /** 官方货架「已装」标记:技能复制卡按名对账,连接器按目录名对账 */
  const installedOfficial = useMemo(
    () => new Set(islands.filter((s) => s.origin === 'official').map((s) => s.name)),
    [islands]
  )
  const installedConnectorNames = useMemo(
    () => new Set(connectors.map((c) => c.catalogName).filter((n): n is string => n !== null)),
    [connectors]
  )

  /** 官方货架按 section 分组(首见顺序),组内按 weight 升序;连接器卡混在其中 */
  const sections = useMemo(() => {
    if (!catalog) return []
    const order: string[] = []
    const bySection = new Map<string, OfficialSkillCard[]>()
    for (const c of catalog.skills) {
      const list = bySection.get(c.section)
      if (list) list.push(c)
      else {
        bySection.set(c.section, [c])
        order.push(c.section)
      }
    }
    return order.map((section) => ({
      section,
      cards: (bySection.get(section) ?? []).slice().sort((a, b) => a.weight - b.weight || a.name.localeCompare(b.name))
    }))
  }, [catalog])

  /** 岛上清单:技能卡与连接器混排,最近更新在前 */
  const islandRows = useMemo<IslandRow[]>(() => {
    const rows: IslandRow[] = [
      ...islands.map((s): IslandRow => ({ kind: 'skill', s })),
      ...connectors.map((c): IslandRow => ({ kind: 'conn', c }))
    ]
    return rows.sort((a, b) => {
      const at = a.kind === 'skill' ? a.s.updatedAt : a.c.updatedAt
      const bt = b.kind === 'skill' ? b.s.updatedAt : b.c.updatedAt
      return bt.localeCompare(at)
    })
  }, [islands, connectors])

  const rowKey = (r: IslandRow): string => (r.kind === 'skill' ? `s${r.s.id}` : `c${r.c.id}`)
  const rowDisabled = (r: IslandRow): boolean => (r.kind === 'skill' ? r.s.frozen : r.c.disabled)

  const openSkillDetail = useCallback((id: number) => {
    setSkillDetails((prev) => {
      const next = new Map(prev)
      next.delete(id) // 先清=回到加载态;展开与装回居民后的刷新都走全量重拉
      return next
    })
    api.skillsCenterDetail(id)
      .then((d) => {
        if (d) setSkillDetails((prev) => new Map(prev).set(id, d))
      })
      .catch(() => {
        /* 失败留在加载态(原行为),再点一次即重试 */
      })
  }, [])

  const openConnDetail = useCallback((id: string) => {
    setConnDetails((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
    api.mcpDetail(id)
      .then((d) => {
        if (d) setConnDetails((prev) => new Map(prev).set(id, d))
      })
      .catch(() => {
        /* 失败留在加载态(原行为),再点一次即重试 */
      })
  }, [])

  const toggleRow = (r: IslandRow) => {
    const key = rowKey(r)
    setDeleteArmed(null)
    setInstallToOpen(null)
    setDetailOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (!detailOpen.has(key)) {
      if (r.kind === 'skill') openSkillDetail(r.s.id)
      else openConnDetail(r.c.id)
    }
  }

  const officialInstallSkill = (card: OfficialSkillCard) => {
    setInstallBusy(true)
    api
      .skillsOfficialInstall(card.name)
      .then(() => {
        say(t('skills.officialInstalled', { name: card.name }))
        setModalCard(null)
        refresh()
      })
      .catch((e) => say(e instanceof Error ? e.message : String(e)))
      .finally(() => setInstallBusy(false))
  }

  const officialInstallConnector = (card: OfficialSkillCard, values: Record<string, string>) => {
    setInstallBusy(true)
    api
      .mcpOfficialInstall(card.name, values)
      .then(() => {
        say(t('skills.mcpOfficialInstalled', { name: card.name }))
        setModalCard(null)
        refresh()
      })
      .catch((e) => say(e instanceof Error ? e.message : String(e)))
      .finally(() => setInstallBusy(false))
  }

  const installSkillTo = (skill: IslandSkillSummary, botId: string, botName: string) => {
    api
      .skillsCenterInstallTo(skill.id, [botId])
      .then((n) => {
        say(n > 0 ? t('skills.installToDone', { name: botName }) : t('skills.alreadyLearned', { name: botName }))
        refresh()
        if (detailOpen.has(`s${skill.id}`)) openSkillDetail(skill.id)
      })
      .catch((e) => say(e instanceof Error ? e.message : String(e)))
  }

  const installConnTo = (conn: IslandConnectorSummary, botId: string, botName: string) => {
    api
      .mcpInstallTo(conn.id, [botId])
      .then((n) => {
        say(n > 0 ? t('skills.installToDone', { name: botName }) : t('skills.mcpAlreadyAssigned', { name: botName }))
        refresh()
        if (detailOpen.has(`c${conn.id}`)) openConnDetail(conn.id)
      })
      .catch((e) => say(e instanceof Error ? e.message : String(e)))
  }

  const freezeSkill = (skill: IslandSkillSummary) => {
    api
      .skillsCenterFreeze(skill.id, !skill.frozen)
      .then(() => {
        say(skill.frozen ? t('skills.unfroze') : t('skills.froze'))
        refresh()
      })
      .catch((e) => say(e instanceof Error ? e.message : String(e)))
  }

  const toggleConnDisabled = (conn: IslandConnectorSummary) => {
    api
      .mcpSetDisabled(conn.id, !conn.disabled)
      .then(() => {
        say(conn.disabled ? t('skills.mcpEnabled') : t('skills.mcpDisabled'))
        refresh()
      })
      .catch((e) => say(e instanceof Error ? e.message : String(e)))
  }

  const removeRow = (r: IslandRow) => {
    const key = rowKey(r)
    const task =
      r.kind === 'skill'
        ? api.skillsCenterDelete(r.s.id).then(() => say(t('skills.deleted')))
        : api.mcpDelete(r.c.id).then(() => say(t('skills.mcpDeleted')))
    task
      .then(() => {
        setDeleteArmed(null)
        setDetailOpen((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
        refresh()
      })
      .catch((e) => say(e instanceof Error ? e.message : String(e)))
  }

  const armedDelete = (r: IslandRow) => {
    const key = rowKey(r)
    if (deleteArmed === key) {
      removeRow(r)
      return
    }
    setDeleteArmed(key)
    setTimeout(() => setDeleteArmed((cur) => (cur === key ? null : cur)), 3000)
  }

  const statusLabel = (st: ConnectorDetail['runtime']['status']): string =>
    st === 'ready'
      ? t('skills.mcpStatusReady')
      : st === 'starting'
        ? t('skills.mcpStatusStarting')
        : st === 'error'
          ? t('skills.mcpStatusError')
          : t('skills.mcpStatusStopped')

  return (
    <section className="skill-center" aria-label={t('skills.title')}>
      <header className="skc-head">
        <h1>{t('skills.title')}</h1>
      </header>
      <div className="skc-tabbar" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'official'}
          className={`skc-tab ${tab === 'official' ? 'active' : ''}`}
          onClick={() => setTab('official')}
        >
          {t('skills.tabOfficial')}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'island'}
          className={`skc-tab ${tab === 'island' ? 'active' : ''}`}
          onClick={() => setTab('island')}
        >
          {t('skills.tabIsland')} <span className="skc-tab-n">{islandRows.length}</span>
        </button>
      </div>

      {tab === 'official' ? (
        <div className="skc-pane">
          {catalog === null ? (
            <div className="skc-empty">
              <div className="skc-empty-title">{t('skills.officialEmpty')}</div>
              <div className="skc-empty-sub">{t('skills.officialEmptySub')}</div>
            </div>
          ) : (
            sections.map(({ section, cards }) => (
              <div className="skc-cat" key={section}>
                <div className="skc-cat-head">
                  <h3>{section}</h3>
                  <span className="skc-cat-n">{cards.length}</span>
                </div>
                <div className="skc-grid">
                  {cards.map((c) => {
                    const Icon = cardIcon(c.icon)
                    const isConnector = c.transport === 'http' || c.transport === 'stdio'
                    const installed = isConnector ? installedConnectorNames.has(c.name) : installedOfficial.has(c.name)
                    return (
                      <button className="skc-card" key={c.name} onClick={() => setModalCard(c)}>
                        <span className="skc-card-row">
                          <span className="skc-appicon" style={{ color: c.color }}>
                            <Icon size={18} />
                          </span>
                          <span className="skc-card-name">{c.name}</span>
                          {installed && (
                            <span className="skc-pill">
                              <Check size={11} /> {t('skills.installed')}
                            </span>
                          )}
                        </span>
                        <span className="skc-card-desc">{c.description}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="skc-pane">
          {islandRows.length === 0 ? (
            <div className="skc-empty">
              <div className="skc-empty-title">{t('skills.islandEmpty')}</div>
              <div className="skc-empty-sub">{t('skills.islandEmptySub')}</div>
              <button className="skc-empty-go" onClick={() => setTab('official')}>
                {t('skills.islandEmptyGo')}
              </button>
            </div>
          ) : (
            <div className="skc-list">
              {islandRows.map((r) => {
                const key = rowKey(r)
                const open = detailOpen.has(key)
                const detail = r.kind === 'skill' ? skillDetails.get(r.s.id) : undefined
                const connDetail = r.kind === 'conn' ? connDetails.get(r.c.id) : undefined
                return (
                  <div key={key} className={`skc-row ${rowDisabled(r) ? 'frozen' : ''}`}>
                    <button className="skc-row-head" aria-expanded={open} onClick={() => toggleRow(r)}>
                      <span className="skc-spark">
                        <Sparkles size={15} />
                      </span>
                      <span className="skc-row-main">
                        <span className="skc-row-title">
                          {r.kind === 'skill' ? r.s.name : r.c.name}
                          {r.kind === 'skill' && r.s.origin === 'island' && <span className="skc-ver">v{r.s.version}</span>}
                          {r.kind === 'skill' && r.s.frozen && (
                            <span className="skc-frozenbadge">{t('skills.frozenBadge')}</span>
                          )}
                          {r.kind === 'conn' && r.c.disabled && (
                            <span className="skc-frozenbadge">{t('skills.mcpDisabledBadge')}</span>
                          )}
                        </span>
                        <span className="skc-row-meta">
                          {r.kind === 'skill' && r.s.origin === 'island' && r.s.creatorName !== null && (
                            <span>{t('skills.creatorBy', { name: r.s.creatorName })} · </span>
                          )}
                          {r.kind === 'skill' && r.s.origin === 'island' && r.s.creatorName === null && (
                            <span>{t('skills.goneCreator')} · </span>
                          )}
                          {r.kind === 'skill' && r.s.origin === 'official' && <span>{t('skills.fromOfficial')} · </span>}
                          {r.kind === 'skill' && r.s.origin === 'imported' && <span>{t('skills.importedByYou')} · </span>}
                          {r.kind === 'skill' && t('skills.learners', { count: r.s.learnerCount })}
                          {r.kind === 'conn' && t('skills.mcpAssigned', { count: r.c.assignedCount })}
                          {rowDisabled(r) && (
                            <span> · {r.kind === 'skill' ? t('skills.frozenNote') : t('skills.mcpDisabledNote')}</span>
                          )}
                        </span>
                      </span>
                      <span className="skc-chev">
                        <ChevronRight size={16} />
                      </span>
                    </button>
                    {open && r.kind === 'skill' && (
                      <div className="skc-row-body">
                        {!detail ? (
                          <div className="skc-loading">{t('skills.loading')}</div>
                        ) : (
                          <>
                            <div className="skc-mgrid">
                              <div>
                                <div className="skc-subhead">{t('skills.cardBody')}</div>
                                <div className="skc-cardtext">{detail.content}</div>
                              </div>
                              <div>
                                <div className="skc-subhead">{t('skills.versionHistory')}</div>
                                {detail.versions.length === 0 ? (
                                  <div className="skc-vrow skc-vnone">—</div>
                                ) : (
                                  detail.versions.map((v) => (
                                    <div key={v.version} className="skc-vrow">
                                      {v.version === detail.version ? (
                                        <>
                                          <span className="skc-vcur">v{v.version}</span>
                                          <span className="skc-vtag">{t('skills.current')}</span>
                                        </>
                                      ) : (
                                        <span>v{v.version}</span>
                                      )}
                                      <span> · {v.createdAt.slice(0, 10)}</span>
                                    </div>
                                  ))
                                )}
                                {detail.installers.length > 0 && (
                                  <>
                                    <div className="skc-subhead skc-subhead-gap">{t('skills.installList')}</div>
                                    <div className="skc-installed">
                                      {detail.installers.map((i) => (
                                        <span key={i.botId} className="skc-who">
                                          {i.name}
                                        </span>
                                      ))}
                                    </div>
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="skc-ops">
                              <div className="skc-dd">
                                <button
                                  className="skc-btn skc-btn-act"
                                  disabled={r.s.frozen}
                                  onClick={() => setInstallToOpen((cur) => (cur === key ? null : key))}
                                >
                                  {t('skills.installTo')} <ChevronDown size={13} />
                                </button>
                                {installToOpen === key && (
                                  <div className="skc-ddmenu">
                                    {residents.map((res) => (
                                      <button
                                        key={res.id}
                                        className="skc-dditem"
                                        onClick={() => {
                                          setInstallToOpen(null)
                                          installSkillTo(r.s, res.id, res.name)
                                        }}
                                      >
                                        {res.name}
                                        {detail.installers.some((i) => i.botId === res.id) && (
                                          <span className="skc-ddhad">
                                            <Check size={13} />
                                          </span>
                                        )}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <span className="skc-ops-gap" />
                              <button className="skc-btn" onClick={() => freezeSkill(r.s)}>
                                {r.s.frozen ? t('skills.unfreeze') : t('skills.freeze')}
                              </button>
                              <button
                                className={`skc-btn skc-btn-danger ${deleteArmed === key ? 'skc-danger-armed' : ''}`}
                                onClick={() => armedDelete(r)}
                              >
                                {deleteArmed === key ? t('skills.confirmDelete') : t('skills.delete')}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                    {open && r.kind === 'conn' && (
                      <div className="skc-row-body">
                        {!connDetail ? (
                          <div className="skc-loading">{t('skills.loading')}</div>
                        ) : (
                          <>
                            <div className="skc-mgrid">
                              <div>
                                <div className="skc-statline">
                                  <span className={`skc-dot ${connDetail.runtime.status}`} />
                                  <span>{statusLabel(connDetail.runtime.status)}</span>
                                  {connDetail.runtime.toolCount > 0 && (
                                    <span className="skc-stmeta">
                                      · {t('skills.mcpToolCount', { count: connDetail.runtime.toolCount })}
                                    </span>
                                  )}
                                </div>
                                {connDetail.runtime.status === 'error' && connDetail.runtime.lastError && (
                                  <div className="skc-sterr">{connDetail.runtime.lastError}</div>
                                )}
                                <div className="skc-subhead skc-subhead-gap">{t('skills.mcpConfigLabel')}</div>
                                <pre className="skc-conf">{connDetail.maskedConfig}</pre>
                              </div>
                              <div>
                                {connDetail.assigned.length > 0 && (
                                  <>
                                    <div className="skc-subhead">{t('skills.installList')}</div>
                                    <div className="skc-installed">
                                      {connDetail.assigned.map((i) => (
                                        <span key={i.botId} className="skc-who">
                                          {i.name}
                                        </span>
                                      ))}
                                    </div>
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="skc-ops">
                              <div className="skc-dd">
                                <button
                                  className="skc-btn skc-btn-act"
                                  disabled={r.c.disabled}
                                  onClick={() => setInstallToOpen((cur) => (cur === key ? null : key))}
                                >
                                  {t('skills.installTo')} <ChevronDown size={13} />
                                </button>
                                {installToOpen === key && (
                                  <div className="skc-ddmenu">
                                    {residents.map((res) => (
                                      <button
                                        key={res.id}
                                        className="skc-dditem"
                                        onClick={() => {
                                          setInstallToOpen(null)
                                          installConnTo(r.c, res.id, res.name)
                                        }}
                                      >
                                        {res.name}
                                        {connDetail.assigned.some((i) => i.botId === res.id) && (
                                          <span className="skc-ddhad">
                                            <Check size={13} />
                                          </span>
                                        )}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <span className="skc-ops-gap" />
                              <button className="skc-btn" onClick={() => toggleConnDisabled(r.c)}>
                                {r.c.disabled ? t('skills.mcpEnable') : t('skills.mcpDisable')}
                              </button>
                              <button
                                className={`skc-btn skc-btn-danger ${deleteArmed === key ? 'skc-danger-armed' : ''}`}
                                onClick={() => armedDelete(r)}
                              >
                                {deleteArmed === key ? t('skills.confirmDelete') : t('skills.delete')}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {modalCard && (
        <OfficialModal
          card={modalCard}
          installed={
            modalCard.transport === 'http' || modalCard.transport === 'stdio'
              ? installedConnectorNames.has(modalCard.name)
              : installedOfficial.has(modalCard.name)
          }
          busy={installBusy}
          onInstallSkill={() => officialInstallSkill(modalCard)}
          onInstallConnector={(values) => officialInstallConnector(modalCard, values)}
          onClose={() => setModalCard(null)}
        />
      )}

      {toast && <div className="skc-toast">{toast}</div>}
    </section>
  )
}
