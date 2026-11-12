import { useEffect, useState } from 'react'
import {
  BellRing,
  ClipboardList,
  BookMarked,
  BookOpen,
  CalendarClock,
  CalendarX2,
  CircleMinus,
  ChevronDown,
  ExternalLink,
  ChevronRight,
  Eraser,
  FilePenLine,
  FilePlus2,
  FileSearch,
  FileText,
  FolderGit2,
  FolderOpen,
  Globe,
  GraduationCap,
  IdCard,
  ListChecks,
  Megaphone,
  NotebookPen,
  Package,
  PackageOpen,
  PenLine,
  Save,
  Search,
  Send,
  SquareTerminal,
  TextSearch,
  Trash2,
  Contact,
  Inbox,
  Mail,
  UserPlus,
  UserRoundPen,
  UsersRound,
  Wrench,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Bot, BotCapability, BotFileEntry, BotPermission, BotSkillEntry, BotTask, ToolId } from '@shared/types'
import { ARCHETYPES, getArchetype } from '@shared/archetypes'
import { api, onSkillsChanged, onTasksChanged } from '../api'
import ResidentAvatar from './ResidentAvatar'
import AvatarEditModal from './AvatarEditModal'
import { formatStamp } from '../utils/time'
import { openFileSmart } from '../utils/open-file'
import MemoryPanel from './MemoryPanel'
import { useTranslation } from '../i18n'
import { displayName, isEn } from '../i18n/localized'

// 居民档案卡(M2.4):档案(信息/模型/人设/权限)+ 技能(实际拥有的工具)+ 文件(经手写过的文件)+ 任务(定时任务)+ 记忆 五个页签
// 送别入口在侧栏会话行「更多(⋯)」菜单,此处只做档案编辑
// 权限两档(2026-10-27 重构):半自动=危险动作先问;全自动=自动审批,直接执行但留痕可回看
type TFn = (key: string, opts?: Record<string, unknown>) => string

function permissions(t: TFn): { id: BotPermission; label: string; desc: string }[] {
  return [
    { id: 'semi', label: t('profile.semiLabel'), desc: t('profile.semiDesc') },
    { id: 'auto', label: t('profile.autoLabel'), desc: t('profile.autoDesc') }
  ]
}
export default function BotProfileDrawer({
  bot,
  onClose,
  onChanged
}: {
  bot: Bot
  onClose: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'profile' | 'skills' | 'files' | 'tasks' | 'memory'>('profile')
  const [name, setName] = useState(bot.name)
  const [role, setRole] = useState(bot.role)
  const [archetype, setArchetype] = useState(bot.archetype)
  const [permission, setPermission] = useState<BotPermission>(bot.permission)
  const [workspacePath, setWorkspacePath] = useState(bot.workspacePath)
  const [saving, setSaving] = useState(false)
  const [editingAvatar, setEditingAvatar] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 空名报错单独走行内(名字标题行右侧);与保存区全局 error 分开
  const [nameError, setNameError] = useState<string | null>(null)

  // 0.9.2 自走查(D3):切换居民时面板与页签保持稳定,仅刷新内容——
  // 编辑态随所选居民重置(页签 tab 故意不动,不然点谁都会跳回「档案」)
  useEffect(() => {
    setName(bot.name)
    setRole(bot.role)
    setArchetype(bot.archetype)
    setPermission(bot.permission)
    setWorkspacePath(bot.workspacePath)
    setEditingAvatar(false)
    setError(null)
    setNameError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id])

  async function save(): Promise<void> {
    // 0.9.2 自走查(D2):名字必填——删空不允许假「已保存」,要明确报错
    if (!name.trim()) {
      setNameError(t('profile.nameRequired'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      // 只提交真正改过的字段(2026-11-06 codex 审查修复:此前全量提交,面板开着期间被后台
      // 更新过的属性——如居民在对话里 update_resident 改了岗位——会被表单里的旧值盖回去)。
      // 二轮评审:人设字段从档案页彻底去掉(不再展示/编辑);patch 不带 persona,
      // 主进程保留库中既有值,居民人设的演化走对话(update_resident)
      const patch: {
        name?: string
        role?: string
        archetype?: string
        permission?: BotPermission
        workspacePath?: string
      } = {}
      if (name !== bot.name) patch.name = name
      if (role !== bot.role) patch.role = role
      if (archetype !== bot.archetype) patch.archetype = archetype
      if (permission !== bot.permission) patch.permission = permission
      if (workspacePath !== bot.workspacePath) patch.workspacePath = workspacePath
      if (Object.keys(patch).length === 0) {
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 1200)
        return
      }
      await api.botsUpdate(bot.id, patch)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1200)
      onChanged()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 数据层空名拒绝也归到行内,别落到性格下方的全局区
      // locale:protocol —— 匹配主进程中文错误前缀(居民世界文本保持中文,见双语方案 C 域)
      if (msg.includes('名字是必填')) setNameError(t('profile.nameRequired'))
      else setError(msg)
    } finally {
      setSaving(false)
    }
  }

  async function pickWorkspace(): Promise<void> {
    const dir = await api.pickDirectory()
    if (dir) setWorkspacePath(dir)
  }

  return (
    <aside className="drawer">
        {/* 2026-10-23 评审:顶部行与大头像二合一,大头像即编辑入口。
          0.9.2 自走查(D1,修订上述决策):头像右侧信息列加回名字——名字 → 标签 → 入住时间;
          标签样式与岛务长统一(C3),不再用弱化版 */}
      <div className="drawer-head">
        <button
          type="button"
          className="drawer-avatar-btn"
          onClick={() => setEditingAvatar(true)}
        >
          <ResidentAvatar
            appearance={bot.appearance}
            fallbackName={bot.name}
            fallbackColor={bot.color}
            size="xl"
          />
          <span className="avatar-edit-hint" aria-hidden>
            <PenLine size={18} />
          </span>
        </button>
        <div className="drawer-head-info">
          {/* 截图评审(v6 修订):两行——第一行名字+标签同行,第二行入住时间(原三行太松散) */}
          <div className="drawer-name-row">
            <span className="drawer-name">{bot.name}</span>
            {bot.isMain ? (
              <span className="badge">{t('common.steward')}</span>
            ) : bot.role ? (
              <span className="badge">{bot.role}</span>
            ) : null}
          </div>
          <div className="chat-sub">{t('profile.movedIn', { date: bot.createdAt.slice(0, 10) })}</div>
        </div>
        <button className="icon-btn ghost-btn sm" onClick={onClose} title={t('common.close')}>
          <X size={14} />
        </button>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'profile' ? 'active' : ''}`} onClick={() => setTab('profile')}>
          {t('profile.tabProfile')}
        </button>
        <button className={`tab ${tab === 'skills' ? 'active' : ''}`} onClick={() => setTab('skills')}>
          {t('profile.tabSkills')}
        </button>
        <button className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>
          {t('profile.tabFiles')}
        </button>
        <button className={`tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>
          {t('profile.tabTasks')}
        </button>
        <button className={`tab ${tab === 'memory' ? 'active' : ''}`} onClick={() => setTab('memory')}>
          {t('profile.tabMemory')}
        </button>
      </div>

      {tab === 'memory' ? (
        /* 居民档案里只看 TA 自己的记忆(2026-11-09 走查):不再混入集体记忆/岛主档案,那两处归设置-记忆页 */
        <MemoryPanel fixedScopes={[{ id: bot.id, label: t('profile.botMemory', { name: bot.name }) }]} />
      ) : tab === 'skills' ? (
        <SkillsTab bot={bot} />
      ) : tab === 'files' ? (
        <FilesTab bot={bot} />
      ) : tab === 'tasks' ? (
        <TasksTab bot={bot} />
      ) : (
        <>
          <div className="field-label-row">
            <label className="field-label">{t('profile.name')}</label>
            {/* 截图评审(v6 修订):空名报错就近放标题行右侧小字,不再落到性格下方 */}
            {nameError && <span className="field-error-inline">{nameError}</span>}
          </div>
          <input
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (nameError) setNameError(null)
            }}
          />

          <label className="field-label">{t('profile.role')}</label>
          <input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder={t('profile.rolePlaceholder')} />

          <label className="field-label">{t('profile.archetype')}</label>
          <select className="input select" value={archetype} onChange={(e) => setArchetype(e.target.value)}>
            {/* 8 型全员可选(2026-10-26 审阅会:取消岛务长专属,主 Bot 切走可切回) */}
            {ARCHETYPES.map((a) => (
              <option key={a.id} value={a.id}>
                {displayName(a)}
              </option>
            ))}
          </select>
          <div className="perm-desc">
            {(() => {
              const a = getArchetype(archetype)
              const blurb = a ? (isEn() ? a.blurbEn : a.blurb) : ''
              return archetype !== bot.archetype ? `${blurb}${t('profile.archetypeSwitchNote')}` : blurb
            })()}
          </div>

          {error && <div className="wizard-error">{error}</div>}

          <div className="divider" />

          <label className="field-label">{t('profile.permission')}</label>
          <div className="perm-options">
            {permissions(t).map((p) => (
              <button
                key={p.id}
                className={`perm-option ${permission === p.id ? 'active' : ''}`}
                onClick={() => setPermission(p.id)}
                title={p.desc}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="perm-desc">{permissions(t).find((p) => p.id === permission)?.desc}</div>

          <label className="field-label">{t('profile.workspace')}</label>
          <div className="workspace-row">
            <input className="input" value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)} />
            <button className="btn ghost" onClick={() => void pickWorkspace()}>
              <FolderOpen size={14} /> {t('profile.change')}
            </button>
            <button
              className="btn ghost"
              onClick={() => void api.workspaceOpen(bot.id)}
              title={t('profile.openWorkspaceTip')}
            >
              <ExternalLink size={14} /> {t('profile.open')}
            </button>
          </div>
          <div className="perm-desc">
            {t('profile.workspaceHint')}
          </div>

          <div className="drawer-actions">
            <button className="btn primary" disabled={saving} onClick={() => void save()}>
              <Save size={14} /> {savedFlash ? t('common.saved') : saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </>
      )}

      {editingAvatar && (
        <AvatarEditModal
          bot={bot}
          onClose={() => setEditingAvatar(false)}
          onSaved={() => {
            setEditingAvatar(false)
            onChanged()
          }}
        />
      )}
    </aside>
  )
}

// 技能图标映射:Record<ToolId> 全集强制——新增内置工具(先在 shared/types.ts 的 ToolId 登记)
// 之后此处漏配图标,typecheck:web 直接红;Wrench 为运行期兜底,任何情况下不出空图标
const SKILL_ICONS: Record<ToolId, LucideIcon> = {
  invite_resident: UserPlus,
  update_resident: UserRoundPen,
  send_message: Send,
  create_group: UsersRound,
  dissolve_group: Trash2,
  post_to_group: Megaphone,
  create_skill: NotebookPen,
  update_skill: FilePenLine,
  install_skill: GraduationCap,
  uninstall_skill: Eraser,
  load_skill: BookMarked,
  import_skill: PackageOpen,
  set_task: BellRing,
  open_task: ClipboardList,
  rename_task: PenLine,
  set_task_workdir: FolderGit2,
  update_task: CalendarClock,
  cancel_task: CalendarX2,
  list_tasks: ListChecks,
  read_own_chat: Search,
  read_my_profile: IdCard,
  web_search: Globe,
  web_fetch: BookOpen,
  read_file: FileText,
  list_dir: FolderOpen,
  find_files: FileSearch,
  search_files: TextSearch,
  write_file: FilePlus2,
  edit_file: FilePenLine,
  run_command: SquareTerminal,
  send_letter: Mail,
  read_mailbox: Inbox,
  list_contacts: Contact
}

// 技能页签(M7 第一块,2026-10-29;2026-10-30 评审改版):居民基础工具包永远第一组(人人标配,默认折叠),
// 学会的技能卡列在其下(工具是手,技能是手艺);不显示版本号/更新时间,卸下一键即卸不二次确认
// (卸下只是从 TA 面板移除,技能卡留在技能中心,随时可再装回)
function SkillsTab({ bot }: { bot: Bot }) {
  const { t } = useTranslation()
  const [caps, setCaps] = useState<BotCapability[] | null>(null)
  const [skills, setSkills] = useState<BotSkillEntry[] | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [disabledOpen, setDisabledOpen] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)

  useEffect(() => {
    // 切居民时丢弃在途旧结果(2026-11-06 codex 审查修复:迟到的 A 数据会覆盖 B 的页签)
    let alive = true
    api
      .botCapabilities(bot.id)
      .then((rows) => {
        if (alive) setCaps(rows)
      })
      .catch(() => {
        if (alive) setCaps([])
      })
    return () => {
      alive = false
    }
  }, [bot.id])

  useEffect(() => {
    let alive = true
    const load = (): void => {
      api
        .botSkills(bot.id)
        .then((rows) => {
          if (alive) setSkills(rows)
        })
        .catch(() => {
          if (alive) setSkills([])
        })
    }
    load()
    const off = onSkillsChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [bot.id])

  async function uninstall(skill: BotSkillEntry): Promise<void> {
    if (removing !== null) return
    setRemoving(skill.id)
    setSkillError(null)
    try {
      await api.skillsUninstall(skill.id, bot.id)
      setSkills((items) => items?.filter((item) => item.id !== skill.id) ?? null)
    } catch {
      setSkillError(t('profile.uninstallFailed', { name: skill.name }))
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="skills-panel">
      <p className="modal-lead">
        {t('profile.skillsLead')}
      </p>
      <div className="skill-pack">
        <button
          className="skill-pack-head"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? t('profile.packCollapse') : t('profile.packExpand')}
        >
          <span className="skill-icon pack">
            <Package size={16} />
          </span>
          <span className="skill-pack-text">
            <span className="skill-pack-name">{t('profile.packName')}</span>
            <span className="skill-pack-desc">
              {caps ? t('profile.packCount', { count: caps.length }) : t('common.loading')}
            </span>
          </span>
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        {expanded && (
          <div className="skill-list">
            {caps?.map((c) => {
              const Icon = SKILL_ICONS[c.id] ?? Wrench
              return (
                <div className="skill-item" key={c.id}>
                  <span className="skill-icon">
                    <Icon size={15} />
                  </span>
                  <div className="skill-body">
                    <span className="skill-name">{c.name}</span>
                    <span className="skill-desc">{c.desc}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {skills && skills.length > 0 && (
        <div className="skills-own">
          <div className="skill-list">
            {skills.filter((s) => !s.frozen).map((s) => (
              <div className={`skill-item own ${s.frozen ? 'frozen' : ''}`} key={s.id}>
                <div className="skill-body">
                  <span className="skill-name">
                    {s.name}
                    {!s.isCreator && <span className="file-badge">
                      {s.origin === 'imported'
                        ? t('skills.importedByYou')
                        : s.origin === 'official'
                          ? t('skills.fromOfficial')
                          : t('profile.fromCreator', { name: s.creatorName ?? t('profile.goneResident') })}
                    </span>}
                    {s.frozen ? <span className="file-badge warn">{t('profile.frozen')}</span> : null}
                  </span>
                  <span className="skill-desc">{s.description}</span>
                </div>
                <div className="skill-actions">
                  <button
                    type="button"
                    className="icon-btn sm ghost-btn skill-remove"
                    title={t('profile.uninstallTip')}
                    disabled={removing !== null}
                    aria-label={t('profile.uninstallNamed', { name: s.name })}
                    onClick={() => void uninstall(s)}
                  >
                    <CircleMinus size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {!!skills?.some((s) => s.frozen) && <div className="skills-disabled">
        <button type="button" className="task-archive-head" aria-expanded={disabledOpen} onClick={() => setDisabledOpen((v) => !v)}>
          {disabledOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {t('profile.disabledSkills', { count: skills.filter((s) => s.frozen).length })}
        </button>
        {disabledOpen && <div className="skill-list">{skills.filter((s) => s.frozen).map((skill) => <div className="skill-item own frozen" key={skill.id}>
          <div className="skill-body"><span className="skill-name">{skill.name}{!skill.isCreator && <span className="file-badge">{skill.origin === 'imported' ? t('skills.importedByYou') : skill.origin === 'official' ? t('skills.fromOfficial') : t('profile.fromCreator', { name: skill.creatorName ?? t('profile.goneResident') })}</span>}</span><span className="skill-desc">{skill.description}</span></div>
          <button className="icon-btn sm ghost-btn skill-remove" disabled={removing !== null} title={t('profile.uninstallTip')} aria-label={t('profile.uninstallNamed', { name: skill.name })} onClick={() => void uninstall(skill)}><CircleMinus size={15} /></button>
        </div>)}</div>}
      </div>}
      {skillError && <p className="profile-action-error" role="alert">{skillError}</p>}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// 文件页签:该居民经手写过的文件(write_file 新建 / edit_file 修改),数据来自审计记录而非实时扫盘
// 是 §1「永远可见」在文件维度的回看索引;点行=用系统默认程序直接打开,右上角按钮=在 Finder 里打开所在文件夹
// 已删除的置灰保留以示曾经写过,不可点
function FilesTab({ bot }: { bot: Bot }) {
  const { t } = useTranslation()
  const [files, setFiles] = useState<BotFileEntry[] | null>(null)

  useEffect(() => {
    // 切居民先进加载态并丢弃在途旧结果(2026-11-06 codex 审查修复:迟到的 A 文件列表
    // 会显示在 B 的档案里)
    let alive = true
    setFiles(null)
    api
      .botFiles(bot.id)
      .then((rows) => {
        if (alive) setFiles(rows)
      })
      .catch(() => {
        if (alive) setFiles([])
      })
    return () => {
      alive = false
    }
  }, [bot.id])

  if (!files) return <p className="modal-lead">{t('common.loading')}</p>
  if (files.length === 0) {
    return (
      <div className="files-panel">
        <p className="modal-lead">{t('profile.filesEmpty')}</p>
        <p className="perm-desc">{t('profile.filesEmptyHint')}</p>
      </div>
    )
  }

  return (
    <div className="files-panel">
      <p className="modal-lead">{t('profile.filesLead')}</p>
      <div className="file-list">
        {files.map((f) => (
          <div
            key={f.path}
            className={`file-item ${f.exists ? '' : 'missing'}`}
            title={
              f.exists
                ? f.path
                : f.statError
                  ? t('profile.fileNoAccess', { path: f.path, error: f.statError })
                  : t('profile.fileGoneTip', { path: f.path })
            }
            onClick={() => {
              // .md 进内置阅读器(2026-11-06),其余系统默认应用
              if (f.exists) void openFileSmart(f.path)
            }}
          >
            <span className="skill-icon">{f.created ? <FilePlus2 size={15} /> : <FilePenLine size={15} />}</span>
            <div className="file-body">
              <span className="file-name">
                {/* 文件名单独包一层:匿名 flex 子项的 min-width 会让无空格的长文件名永不换行(溢出卡片),
                    中文名却按字换行——同行里换行长短短不一;包成显式 span + min-width:0 统一为「用满行宽才换」 */}
                <span className="file-name-text">{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
                {f.created ? <span className="file-badge">{t('profile.fileNew')}</span> : null}
                {!f.inWorkspace ? <span className="file-badge warn">{t('profile.fileOutside')}</span> : null}
                {!f.exists
                  ? f.statError
                    ? <span className="file-badge warn" title={t('profile.fileNoAccessBadgeTip', { error: f.statError })}>{t('profile.fileNoAccessShort')}</span>
                    : <span className="file-badge gone">{t('profile.fileGone')}</span>
                  : null}
              </span>
              <span className="file-path">{f.displayPath}</span>
              <span className="file-meta">
                {t('profile.fileOps', { time: formatStamp(f.lastAt), count: f.ops })}
                {f.size !== null ? ` · ${formatBytes(f.size)}` : ''}
              </span>
            </div>
            {f.exists && (
              <div className="file-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn sm ghost-btn"
                  title={t('profile.revealFolder')}
                  onClick={() => void api.revealInFolder(f.path)}
                >
                  <FolderOpen size={14} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// 任务页签(2026-10-29 定时任务;2026-10-30 评审改版):TA 的任务清单——进行中在前、留档在后,是「岛主看
// 居民记住了哪些任务」的信任视图。创建入口是对话本身,这里只读 + 取消;取消一键即取消不二次确认
// (创建成本是一句话),不显示提醒/做事标签与岛主原话行;历史默认折叠,只留「任务历史」入口
function TasksTab({ bot }: { bot: Bot }) {
  const { t } = useTranslation()
  const [tasks, setTasks] = useState<BotTask[] | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [taskError, setTaskError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      api
        .botTasks(bot.id)
        .then((rows) => {
          if (alive) setTasks(rows)
        })
        .catch(() => {
          if (alive) setTasks([])
        })
    }
    load()
    const off = onTasksChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [bot.id])

  async function cancel(task: BotTask): Promise<void> {
    if (cancelling) return
    setCancelling(task.id)
    setTaskError(null)
    try {
      await api.tasksCancel(task.id, bot.id)
      setTasks(await api.botTasks(bot.id))
    } catch {
      setTaskError(t('profile.cancelFailed'))
    } finally {
      setCancelling(null)
    }
  }

  if (!tasks) return <p className="modal-lead">{t('common.loading')}</p>

  const active = tasks.filter((x) => x.status === 'pending' || x.status === 'active')
  const archive = tasks.filter((x) => x.status !== 'pending' && x.status !== 'active')

  return (
    <div className="tasks-panel">
      <p className="modal-lead">
        {t('profile.tasksLead', { count: active.length })}
      </p>
      {tasks.length === 0 && <p className="perm-desc">{t('profile.tasksEmpty')}</p>}
      {taskError && <p className="profile-action-error" role="alert">{taskError}</p>}
      {active.length > 0 && (
        <div className="task-list">
          {active.map((task) => (
            <div className="task-item" key={task.id}>
              <CalendarClock size={16} className="task-card-icon" />
              <div className="task-body">
                <span className="task-title">{task.title}</span>
                <span className="task-schedule">{task.scheduleText}</span>
              </div>
              <div className="task-actions">
                <button
                  type="button"
                  className="icon-btn sm ghost-btn skill-remove"
                  title={t('profile.cancelTaskTip')}
                  disabled={cancelling !== null}
                  onClick={() => void cancel(task)}
                >
                  <X size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {archive.length > 0 && (
        <div className="task-archive">
          <button
            type="button"
            className="task-archive-head"
            onClick={() => setArchiveOpen((v) => !v)}
          >
            {archiveOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {t('profile.tasksArchive', { count: archive.length })}
          </button>
          {archiveOpen && (
            <div className="task-list">
              {archive.map((task) => (
                <div className="task-item archived" key={task.id}>
                  <CalendarClock size={15} className="task-card-icon" />
                  <div className="task-body">
                    <span className="task-title">{task.title}</span>
                    <span className="task-schedule">{task.scheduleText}</span>
                    <span className={`task-outcome ${task.status === 'failed' ? 'failed' : ''}`}>
                      {task.status === 'missed' ? t('profile.taskMissed') : task.status === 'failed' ? t(task.failReason === 'credits' ? 'profile.taskNotRun' : 'profile.taskFailed') : task.statusText}
                      {task.status === 'failed' && <> · {task.failReason === 'credits' ? t('profile.taskReasonCredits') : task.failReason === 'context' ? t('profile.taskReasonContext') : task.failReason === 'aborted' ? t('profile.taskReasonAborted') : task.failReason === 'error' ? t('profile.taskReasonError') : t('profile.taskReasonUnknown')}</>}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
