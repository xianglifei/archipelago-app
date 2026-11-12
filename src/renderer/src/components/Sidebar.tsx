import { useEffect, useState, type ReactElement } from 'react'
import {
  Archive,
  ChevronRight,
  ClipboardList,
  DoorOpen,
  Eye,
  EyeOff,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  ShieldAlert,
  Sparkles,
  UserPlus,
  Waves,
  X
} from 'lucide-react'
import type { Bot, ConversationPreview, GroupInfo, SpaceInfo, TaskThreadInfo } from '@shared/types'
import {
  api,
  onBotsChanged,
  onChatDone,
  onChatSync,
  onChatUserAdded,
  onGroupsChanged,
  onGroupDone,
  onGroupUserAdded,
  onThreadsChanged,
  onTurnChanged
} from '../api'
import ResidentAvatar, { GroupAvatarStack } from './ResidentAvatar'
import { useTranslation } from '../i18n'

interface Props {
  space: SpaceInfo | null
  bots: Bot[]
  groups: GroupInfo[]
  /** 进行中的任务会话(2026-11-06「新建任务」):独立成行混排进列表 */
  taskThreads: TaskThreadInfo[]
  view: { kind: 'dm'; botId: string } | { kind: 'group'; groupId: string } | { kind: 'task'; threadId: string } | null
  /** 新版本提示横条(0.9.2 自走查 F1):渲染在列表底部,整条可点直达 设置 → 关于 */
  updateStrip: { version: string; mandatory: boolean; onOpen: () => void; onDismiss: () => void } | null
  onSelectBot: (id: string) => void
  onSelectGroup: (id: string) => void
  /** 点开任务会话行 */
  onSelectTask: (threadId: string) => void
  onInvite: () => void
  onCreateGroup: () => void
  /** 加号菜单「新建任务」:开选居民弹窗 */
  onCreateTask: () => void
  /** 行菜单「新建任务」:直接给该居民开任务(建完由 MainScreen 切过去) */
  onNewTask: (botId: string) => void
  onFarewell: (botId: string) => void
}

type ListItem =
  | { kind: 'dm'; bot: Bot; last: ConversationPreview | undefined }
  | { kind: 'group'; group: GroupInfo; last: ConversationPreview | undefined }
  | { kind: 'task'; thread: TaskThreadInfo; bot: Bot; last: ConversationPreview | undefined }

function itemTime(item: ListItem): number {
  const fallback = item.kind === 'dm' ? item.bot.createdAt : item.kind === 'group' ? item.group.createdAt : item.thread.createdAt
  const at = item.last?.lastAt ?? fallback
  return Date.parse(at) || 0
}

function byRecent(a: ListItem, b: ListItem): number {
  return itemTime(b) - itemTime(a)
}

export default function Sidebar({
  space,
  bots,
  groups,
  taskThreads,
  view,
  updateStrip,
  onSelectBot,
  onSelectGroup,
  onSelectTask,
  onInvite,
  onCreateGroup,
  onCreateTask,
  onNewTask,
  onFarewell
}: Props) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  // 行菜单开合(单选):bot 行与任务行共用一个 id 空间(uuid 不撞)
  const [rowMenuId, setRowMenuId] = useState<string | null>(null)
  const [hiddenIds, setHiddenIds] = useState<string[]>([])
  const [hiddenOpen, setHiddenOpen] = useState(false)
  const [previews, setPreviews] = useState<ConversationPreview[]>([])
  // 任务行内联改名(2026-11-06):Enter 保存 / Esc 与失焦取消
  const [renaming, setRenaming] = useState<{ id: string; value: string; original: string } | null>(null)

  const refreshPreviews = (): void => {
    api.conversationsOverview().then(setPreviews).catch(console.error)
  }

  useEffect(() => {
    api.hiddenDmsGet().then(setHiddenIds).catch(console.error)
    refreshPreviews()
    // 单聊/群聊/任务会话任何新消息或增删,都可能改变排序与预览
    const offs = [
      onChatUserAdded(refreshPreviews),
      onChatDone(refreshPreviews),
      onChatSync(refreshPreviews),
      onGroupUserAdded(refreshPreviews),
      onGroupDone(refreshPreviews),
      onBotsChanged(refreshPreviews),
      onGroupsChanged(refreshPreviews),
      // 任务会话新建/改名/结束/标题生成:预览与行名都变
      onThreadsChanged(refreshPreviews),
      // 回合开始/结束(2026-10-30 列表实时状态):重拉 busy 真态快照——
      // 取代旧 busyBots(本地拼 delta 事件,首字静默期不显示、重载即丢、后台回合零感知)
      onTurnChanged(refreshPreviews)
    ]
    return () => offs.forEach((off) => off())
  }, [])

  useEffect(() => {
    if (!rowMenuId) return
    const close = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.row-menu-wrap')) setRowMenuId(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [rowMenuId])

  const previewMap = new Map(previews.map((p) => [`${p.kind}:${p.id}`, p]))

  // 已送别居民的残留 id 直接忽略,不参与渲染;任务行同样按「居民还在」过滤(送别即收行)
  const botById = new Map(bots.map((b) => [b.id, b]))
  const hiddenSet = new Set(hiddenIds.filter((id) => bots.some((b) => b.id === id)))
  const visibleItems: ListItem[] = [
    ...bots
      .filter((b) => !hiddenSet.has(b.id))
      .map((bot): ListItem => ({ kind: 'dm', bot, last: previewMap.get(`dm:${bot.id}`) })),
    ...groups.map((group): ListItem => ({ kind: 'group', group, last: previewMap.get(`group:${group.id}`) })),
    ...taskThreads
      .filter((th) => botById.has(th.botId))
      .map((thread): ListItem => ({
        kind: 'task',
        thread,
        bot: botById.get(thread.botId)!,
        last: previewMap.get(`task:${thread.id}`)
      }))
  ].sort(byRecent)
  const hiddenItems: ListItem[] = bots
    .filter((bot) => hiddenSet.has(bot.id))
    .map((bot): ListItem => ({ kind: 'dm', bot, last: previewMap.get(`dm:${bot.id}`) }))
    .sort(byRecent)

  function persistHidden(next: string[]): void {
    setHiddenIds(next)
    api.hiddenDmsSet(next).catch(console.error)
  }

  function hideDm(bot: Bot): void {
    setRowMenuId(null)
    persistHidden([...hiddenIds.filter((id) => id !== bot.id), bot.id])
  }

  function unhideDm(bot: Bot): void {
    setRowMenuId(null)
    persistHidden(hiddenIds.filter((id) => id !== bot.id))
  }

  async function farewell(bot: Bot): Promise<void> {
    setRowMenuId(null)
    const ok = window.confirm(t('sidebar.farewellConfirm', { name: bot.name }))
    if (!ok) return
    try {
      await api.botsDelete(bot.id)
      persistHidden(hiddenIds.filter((id) => id !== bot.id))
      onFarewell(bot.id)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function closeTask(thread: TaskThreadInfo): Promise<void> {
    setRowMenuId(null)
    const title = thread.title || t('sidebar.taskUntitled')
    // 绑定工作树的线程(2026-11-10):分支保留、工作树移除的口径明说,岛主知情再收
    const ok = window.confirm(
      thread.workdirPath && thread.wtBranch
        ? t('task.closeUnmergedConfirm', { title, branch: thread.wtBranch })
        : t('sidebar.closeTaskConfirm', { title })
    )
    if (!ok) return
    try {
      await api.taskThreadClose(thread.id)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }

  function commitRename(): void {
    const r = renaming
    if (!r) return
    setRenaming(null)
    const value = r.value.trim()
    // 值没动不落 IPC(避免空点击触发广播);改成空=回到「新任务」
    if (value === r.original) return
    api.taskThreadRename(r.id, value).catch((err) => window.alert(err instanceof Error ? err.message : String(err)))
  }

  function dmRow(bot: Bot, last: ConversationPreview | undefined, hidden: boolean): ReactElement {
    const active = view?.kind === 'dm' && view.botId === bot.id
    const asking = (last?.pendingApprovals ?? 0) > 0
    // 次行优先级(2026-10-30 列表实时状态,拍板 3/4):待审批 > 回合进行中 > 最后消息预览
    const busy = !asking ? last?.busy : undefined
    return (
      <div key={bot.id} className={`bot-item ${active ? 'active' : ''}`}>
        <button className="bot-main" onClick={() => onSelectBot(bot.id)}>
          <ResidentAvatar
            appearance={bot.appearance}
            fallbackName={bot.name}
            fallbackColor={bot.color}
            size="lg"
          >
            {asking && <span className="ask-dot">{last!.pendingApprovals}</span>}
          </ResidentAvatar>
          <span className="bot-meta">
            <span className="bot-name">
              {bot.name}
              {/* 0.9.2 自走查(C4):列表也透出角色标签——agent team 一眼认出谁是产品经理谁是运营 */}
              {bot.isMain ? (
                <span className="badge sm">{t('common.steward')}</span>
              ) : bot.role ? (
                <span className="badge sm">{bot.role}</span>
              ) : null}
            </span>
            {busy ? (
              <span className="bot-preview busy">
                {busy === 'scheduled'
                  ? t('sidebar.onTask')
                  : busy === 'relation' || busy === 'digest'
                    ? t('sidebar.replying')
                    : t('sidebar.thinking')}
                <span className="thinking-dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              </span>
            ) : (
              <span className={`bot-preview ${asking ? 'asking' : ''}`}>
                {asking ? t('sidebar.awaitApproval') : (last?.preview ?? bot.role ?? t('sidebar.resident'))}
              </span>
            )}
          </span>
        </button>
        {/* 2026-11-06「新建任务」(P5 拍板):主 Bot 行也开「⋯」,但仅含「新建任务」——
            隐藏/送别对主 Bot 仍不出现;隐藏区行的菜单维持恢复/送别两项,不开任务 */}
        <div className="row-menu-wrap">
          <button
            className={`bot-more ${rowMenuId === bot.id ? 'open' : ''}`}
            title={t('sidebar.more')}
            onClick={() => setRowMenuId((cur) => (cur === bot.id ? null : bot.id))}
          >
            <MoreHorizontal size={15} />
          </button>
          {rowMenuId === bot.id && (
            <div className="row-menu">
              {!hidden && (
                <button
                  className="menu-item"
                  onClick={() => {
                    setRowMenuId(null)
                    onNewTask(bot.id)
                  }}
                >
                  <ClipboardList size={14} /> {t('sidebar.newTask')}
                </button>
              )}
              {bot.isMain ? null : hidden ? (
                <button className="menu-item" onClick={() => unhideDm(bot)}>
                  <Eye size={14} /> {t('sidebar.unhide')}
                </button>
              ) : (
                <button className="menu-item" onClick={() => hideDm(bot)}>
                  <EyeOff size={14} /> {t('sidebar.hide')}
                </button>
              )}
              {bot.isMain ? null : (
                <button className="menu-item danger" onClick={() => void farewell(bot)}>
                  <DoorOpen size={14} /> {t('sidebar.farewell', { name: bot.name })}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  function taskRow(thread: TaskThreadInfo, bot: Bot, last: ConversationPreview | undefined): ReactElement {
    const active = view?.kind === 'task' && view.threadId === thread.id
    const asking = (last?.pendingApprovals ?? 0) > 0
    // 任务行 busy 文案不按 TurnKind 分层(任务回合恒 'chat'):亮着就是「做任务中」
    const busy = !asking ? last?.busy : undefined
    const title = thread.title || t('sidebar.taskUntitled')
    const editing = renaming?.id === thread.id
    return (
      <div key={thread.id} className={`bot-item task-row ${active ? 'active' : ''}`}>
        <button className="bot-main" onClick={() => onSelectTask(thread.id)}>
          <ResidentAvatar appearance={bot.appearance} fallbackName={bot.name} fallbackColor={bot.color} size="lg">
            {asking && <span className="ask-dot">{last!.pendingApprovals}</span>}
            {/* P2 拍板方案 A:头像右下角任务签(accent 圆签+白色剪贴板,与右上角审批黄点同口径可并挂) */}
            <span className="task-badge" aria-hidden>
              <ClipboardList size={9} />
            </span>
          </ResidentAvatar>
          <span className="bot-meta">
            {editing ? (
              <input
                className="task-rename"
                autoFocus
                value={renaming.value}
                onChange={(e) => setRenaming({ id: thread.id, value: e.target.value, original: renaming.original })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setRenaming(null)
                  e.stopPropagation()
                }}
                onBlur={commitRename}
                onFocus={(e) => e.target.select()}
              />
            ) : (
              <span className="bot-name">{title}</span>
            )}
            {busy ? (
              <span className="bot-preview busy">
                {t('sidebar.onTask')}
                <span className="thinking-dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              </span>
            ) : (
              <span className={`bot-preview ${asking ? 'asking' : ''}`}>
                {asking ? t('sidebar.awaitApproval') : (last?.preview || t('sidebar.taskEmptyHint'))}
              </span>
            )}
          </span>
        </button>
        <div className="row-menu-wrap">
          <button
            className={`bot-more ${rowMenuId === thread.id ? 'open' : ''}`}
            title={t('sidebar.more')}
            onClick={() => setRowMenuId((cur) => (cur === thread.id ? null : thread.id))}
          >
            <MoreHorizontal size={15} />
          </button>
          {rowMenuId === thread.id && (
            <div className="row-menu">
              <button
                className="menu-item"
                onClick={() => {
                  setRowMenuId(null)
                  setRenaming({ id: thread.id, value: thread.title, original: thread.title })
                }}
              >
                <Pencil size={14} /> {t('sidebar.renameTask')}
              </button>
              <button className="menu-item danger" onClick={() => void closeTask(thread)}>
                <Archive size={14} /> {t('sidebar.closeTask')}
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  function groupRow(group: GroupInfo, last: ConversationPreview | undefined): ReactElement {
    const active = view?.kind === 'group' && view.groupId === group.id
    // 群级布尔「讨论中」(2026-10-30 列表实时状态,拍板 5):谁在想归群聊界面左下角指示条,两层粒度互补
    const busy = last?.groupBusy === true
    return (
      <div key={group.id} className={`bot-item ${active ? 'active' : ''}`}>
        <button className="bot-main" onClick={() => onSelectGroup(group.id)}>
          <GroupAvatarStack members={group.members} size="lg" />
          <span className="bot-meta">
            <span className="bot-name">{group.name}</span>
            {busy ? (
              <span className="bot-preview busy">
                {t('sidebar.discussing')}
                <span className="thinking-dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              </span>
            ) : (
              <span className="bot-preview">{last?.preview ?? t('sidebar.members', { count: group.members.length })}</span>
            )}
          </span>
        </button>
      </div>
    )
  }

  function row(item: ListItem, hidden = false): ReactElement {
    if (item.kind === 'task') return taskRow(item.thread, item.bot, item.last)
    if (item.kind === 'group') return groupRow(item.group, item.last)
    return dmRow(item.bot, item.last, hidden)
  }

  // 待审横条:有挂起审批时出现在岛名下方,点击直达第一个待审会话(隐藏会话优先取可见的);
  // 任务会话的审批也计入(点开直达任务视图)
  const askEntries = visibleItems
    .map((it) =>
      it.kind === 'dm' && (it.last?.pendingApprovals ?? 0) > 0
        ? { label: it.bot.name, count: it.last!.pendingApprovals!, go: (): void => onSelectBot(it.bot.id) }
        : it.kind === 'task' && (it.last?.pendingApprovals ?? 0) > 0
          ? {
              label: it.thread.title || t('sidebar.taskUntitled'),
              count: it.last!.pendingApprovals!,
              go: (): void => onSelectTask(it.thread.id)
            }
          : null
    )
    .filter((x): x is { label: string; count: number; go: () => void } => x !== null)
  const askTotal = askEntries.reduce((sum, it) => sum + it.count, 0)
  const askFirst = askEntries[0]

  return (
    <aside className="sidebar">
      <div className="island-head">
        <Waves size={18} className="island-icon" />
        <div className="island-info">
          <div className="island-name">{space?.name ?? t('common.appName')}</div>
        </div>
        <div className="plus-wrap">
          <button
            className="icon-btn ghost-btn sm"
            title={t('sidebar.new')}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Plus size={16} />
          </button>
          {menuOpen && (
            <>
              {/* #3:透明面纱接住菜单外点击收起菜单。不能只靠 document 监听——侧栏空白是
                  -webkit-app-region: drag 拖拽区,Chromium 不向页面派发鼠标事件,点空白永远收不到 */}
              <div className="plus-menu-veil" onPointerDown={() => setMenuOpen(false)} />
              <div className="plus-menu">
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    onInvite()
                  }}
                >
                  <UserPlus size={14} /> {t('sidebar.invite')}
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    onCreateGroup()
                  }}
                >
                  <MessageSquarePlus size={14} /> {t('sidebar.newGroup')}
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    onCreateTask()
                  }}
                >
                  <ClipboardList size={14} /> {t('sidebar.newTask')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {askTotal > 0 && askFirst && (
        <button className="ask-banner" title={t('sidebar.goApprovals')} onClick={askFirst.go}>
          <ShieldAlert size={13} />
          {askFirst.label} · {askTotal > 1 ? t('sidebar.awaitApprovalMany', { count: askTotal }) : t('sidebar.awaitApproval')}
        </button>
      )}

      <nav className="bot-list">{visibleItems.map((item) => row(item))}</nav>

      {hiddenItems.length > 0 && (
        <div className="hidden-dms">
          <button className="hidden-dms-head" onClick={() => setHiddenOpen((open) => !open)}>
            <ChevronRight size={13} className={`hidden-chevron ${hiddenOpen ? 'open' : ''}`} />
            <span className="hidden-dms-title">{t('sidebar.hidden')}</span>
            <span className="hidden-count">{hiddenItems.length}</span>
          </button>
          {hiddenOpen && <div className="hidden-dms-list">{hiddenItems.map((item) => row(item, true))}</div>}
        </div>
      )}

      {/* 新版本横条(0.9.2 自走查 F1,方案 B):常驻在列表底部,整条可点;
          文案直说「新版本」;导航栏「设置」按钮红点承担横条关闭后的持久提醒(2026-10-28 入口迁移) */}
      {updateStrip && (
        <div className="update-strip">
          <button className="update-strip-main" onClick={updateStrip.onOpen}>
            <Sparkles size={13} />
            <span className="update-strip-text">{t('sidebar.updateStrip', { version: updateStrip.version })}</span>
          </button>
          {!updateStrip.mandatory && (
            <button className="update-strip-close" title={t('common.gotIt')} onClick={updateStrip.onDismiss}>
              <X size={12} />
            </button>
          )}
        </div>
      )}
      {/* 底部设置行已移除(2026-10-28 导航栏方案):设置入口收敛到最左导航栏「设置」按钮,
          岛主称呼/账号在 设置 → 岛务/设备连接 可见 */}
    </aside>
  )
}
