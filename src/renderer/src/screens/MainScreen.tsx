import { useEffect, useState } from 'react'
import { Waves } from 'lucide-react'
import type { Bot, BootState, GroupInfo, SpaceInfo, TaskThreadInfo, UpdateState } from '@shared/types'
import {
  api,
  onBotsChanged,
  onFocusBot,
  onGroupsChanged,
  onOpenSettings,
  onThreadsChanged,
  onUpdateState
} from '../api'
import Sidebar from '../components/Sidebar'
import NavRail, { type RailView } from '../components/NavRail'
import ChatView from '../components/ChatView'
import GroupView from '../components/GroupView'
import PostView from '../components/PostView'
import SkillCenter from '../components/SkillCenter'
import InviteBotModal from '../components/InviteBotModal'
import CreateGroupModal from '../components/CreateGroupModal'
import TaskModal from '../components/TaskModal'
import SettingsModal from '../components/SettingsModal'
import BotProfileDrawer from '../components/BotProfileDrawer'
import GroupProfileDrawer from '../components/GroupProfileDrawer'
import { onPostChanged } from '../api'
import { useTranslation } from '../i18n'

// 任务会话(2026-11-06「新建任务」):消息列表里的独立会话行,ChatView 以 task 模式复用
type ActiveView = { kind: 'dm'; botId: string } | { kind: 'group'; groupId: string } | { kind: 'task'; threadId: string }
// 与 SettingsModal 的页签全集对齐(此前漏 'credits':积分预警条的「去充值」没处可去)
type SettingsTab = 'island' | 'account' | 'credits' | 'memory' | 'about'

export default function MainScreen({ initialBoot }: { initialBoot: BootState }) {
  const { t } = useTranslation()
  const [space, setSpace] = useState<SpaceInfo | null>(initialBoot.space)
  const [bots, setBots] = useState<Bot[]>([])
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [taskThreads, setTaskThreads] = useState<TaskThreadInfo[]>([])
  const [view, setView] = useState<ActiveView | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [createTaskOpen, setCreateTaskOpen] = useState(false)
  // 左侧导航栏视图(2026-10-28):消息 = 既有界面;设置 = 导航栏右侧整区换成内嵌设置面板
  const [railView, setRailView] = useState<RailView>('messages')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('island')
  const [memoryScope, setMemoryScope] = useState<string | undefined>(undefined)
  const [profileBotId, setProfileBotId] = useState<string | null>(null)
  const [profileGroupId, setProfileGroupId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [dismissedBanner, setDismissedBanner] = useState<string | null>(null)
  // 邮局未读数(2026-10-29):NavRail 邮局按钮红点;主进程 PostChanged 广播时刷新
  const [postUnread, setPostUnread] = useState(0)

  useEffect(() => {
    api.postOverview().then((o) => setPostUnread(o.unread)).catch(() => {})
    return onPostChanged(() => {
      api.postOverview().then((o) => setPostUnread(o.unread)).catch(() => {})
    })
  }, [])

  // 升级状态:主进程整包广播,这里只管订阅
  useEffect(() => {
    api.updateState().then(setUpdate).catch(console.error)
    return onUpdateState(({ state }) => setUpdate(state))
  }, [])

  // 菜单栏「偏好设置…」(Cmd+,):导航栏「设置」同款行为,切到内嵌设置面板
  useEffect(() => onOpenSettings(() => setRailView('settings')), [])

  // 点击审批系统通知等场景:把视图切到卡所在的会话(与 switchView 同款粘滞逻辑);
  // 任务会话的审批卡带 threadId——切到任务视图而非居民单聊(2026-11-06「新建任务」);
  // 若正停在导航栏设置视图,一并切回消息视图,否则通知点了也看不见会话
  useEffect(
    () =>
      onFocusBot(({ botId, threadId }) => {
        setView(threadId ? { kind: 'task', threadId } : { kind: 'dm', botId })
        setRailView('messages')
        setProfileBotId((current) => (current !== null ? botId : null))
      }),
    []
  )

  useEffect(() => {
    Promise.all([api.botsList(), api.groupsList(), api.taskThreadsList()])
      .then(([botList, groupList, threadList]) => {
        setBots(botList)
        setGroups(groupList)
        setTaskThreads(threadList)
        setView((current) => current ?? (botList[0] ? { kind: 'dm', botId: botList[0].id } : null))
        setLoaded(true)
      })
      .catch((err) => console.error(err))

    const refreshBots = (): void => {
      api.botsList().then(setBots).catch(console.error)
    }
    const refreshGroups = (): void => {
      api.groupsList().then(setGroups).catch(console.error)
    }
    // 任务会话清单:主进程 ThreadsChanged 广播(新建/改名/结束/标题自动生成)时刷新
    const refreshThreads = (): void => {
      api.taskThreadsList().then(setTaskThreads).catch(console.error)
    }
    // 居民/群的增删由主进程广播,这里统一刷新
    // (busyBots 本地拼 delta 事件的旧做法已删,2026-10-30 列表实时状态:
    //  列表 busy 改由 Sidebar 从 conversationsOverview 真态快照渲染,首字静默期/重载/后台回合三缺口一并修复)
    const offs = [
      onBotsChanged(() => {
        refreshBots()
        refreshGroups()
      }),
      onGroupsChanged(refreshGroups),
      onThreadsChanged(refreshThreads)
    ]
    return () => offs.forEach((off) => off())
  }, [])

  function switchView(next: ActiveView): void {
    setView(next)
    // 右侧栏粘滞:档案开着时切居民,自动跟随展示新居民;切到群聊/任务会话则收起
    setProfileBotId((current) => (next.kind === 'dm' && current !== null ? next.botId : null))
  }

  /** 给居民开任务(行菜单入口直开;加号入口经 TaskModal 选人后同途) */
  async function startTaskFor(botId: string): Promise<void> {
    try {
      const thread = await api.taskThreadCreate(botId)
      setTaskThreads((prev) => [thread, ...prev])
      switchView({ kind: 'task', threadId: thread.id })
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }

  const activeBot = view?.kind === 'dm' ? (bots.find((b) => b.id === view.botId) ?? null) : null
  const activeGroup = view?.kind === 'group' ? (groups.find((g) => g.id === view.groupId) ?? null) : null
  const activeThread = view?.kind === 'task' ? (taskThreads.find((t) => t.id === view.threadId) ?? null) : null
  // 任务视图归属的居民(线程还在但居民已送别时收行回落到空屏)
  const activeTaskBot = activeThread ? (bots.find((b) => b.id === activeThread.botId) ?? null) : null
  const profileBot = profileBotId ? (bots.find((b) => b.id === profileBotId) ?? null) : null
  const profileGroup = profileGroupId ? (groups.find((g) => g.id === profileGroupId) ?? null) : null
  const bannerVersion =
    update?.freshVersion && update.freshVersion !== dismissedBanner ? update.freshVersion : null

  function openSettings(tab: SettingsTab, memoryScope?: string): void {
    setSettingsTab(tab)
    setMemoryScope(memoryScope)
    setRailView('settings')
  }

  return (
    <div className="app">
      <NavRail view={railView} onSelect={setRailView} updateBadge={!!update?.showBadge} postBadge={postUnread} />
      {railView === 'settings' ? (
        <SettingsModal
          embedded
          initialTab={settingsTab}
          initialMemoryScope={memoryScope}
          updateBadge={!!update?.showBadge}
          onClose={() => setRailView('messages')}
          onSaved={(state) => setSpace(state.space)}
        />
      ) : railView === 'post' ? (
        <PostView />
      ) : railView === 'skills' ? (
        <SkillCenter />
      ) : (
        <>
          <Sidebar
            space={space}
            bots={bots}
            groups={groups}
            taskThreads={taskThreads}
            view={view}
            updateStrip={
              bannerVersion
                ? {
                    version: bannerVersion,
                    mandatory: !!update?.mandatory,
                    onOpen: () => openSettings('about'),
                    onDismiss: () => setDismissedBanner(bannerVersion)
                  }
                : null
            }
            onSelectBot={(botId) => switchView({ kind: 'dm', botId })}
            onSelectGroup={(groupId) => switchView({ kind: 'group', groupId })}
            onSelectTask={(threadId) => switchView({ kind: 'task', threadId })}
            onInvite={() => setInviteOpen(true)}
            onCreateGroup={() => setCreateGroupOpen(true)}
            onCreateTask={() => setCreateTaskOpen(true)}
            onNewTask={(botId) => {
              void startTaskFor(botId)
            }}
            onFarewell={(botId) => {
              api.botsList().then((list) => {
                setBots(list)
                setView((current) =>
                  current?.kind === 'dm' && current.botId === botId
                    ? list[0]
                      ? { kind: 'dm', botId: list[0].id }
                      : null
                    : current
                )
              }).catch(console.error)
            }}
          />
          <main className="content">
            {activeBot ? (
              <ChatView
                key={activeBot.id}
                bot={activeBot}
                residents={bots}
                onOpenProfile={() => {
                  setProfileGroupId(null)
                  setProfileBotId((current) => current === activeBot.id ? null : activeBot.id)
                }}
                onRecharge={() => openSettings('credits')}
              />
            ) : activeThread && activeTaskBot ? (
              <ChatView
                key={activeThread.id}
                bot={activeTaskBot}
                task={activeThread}
                residents={bots}
                onOpenProfile={() => {
                  setProfileGroupId(null)
                  setProfileBotId((current) => current === activeTaskBot.id ? null : activeTaskBot.id)
                }}
                onRecharge={() => openSettings('credits')}
              />
            ) : activeGroup ? (
              <GroupView
                key={activeGroup.id}
                group={activeGroup}
                onOpenProfile={() => {
                  setProfileBotId(null)
                  setProfileGroupId((current) => (current === activeGroup.id ? null : activeGroup.id))
                }}
              />
            ) : loaded ? (
              <div className="chat-empty-screen">
                <Waves size={32} />
                <p>{t('main.inviteFirst')}</p>
              </div>
            ) : null}
          </main>

          {profileBot && (
            <BotProfileDrawer
              /* 0.9.2 自走查(D3):去掉 key——切居民时面板保持挂载,页签与滚动位置不重置,仅内容随 bot 刷新 */
              bot={profileBot}
              onClose={() => setProfileBotId(null)}
              onChanged={() => {
                api.botsList().then(setBots).catch(console.error)
              }}
            />
          )}

          {profileGroup && (
            <GroupProfileDrawer
              key={profileGroup.id}
              group={profileGroup}
              onClose={() => setProfileGroupId(null)}
              onChanged={() => {
                api.groupsList().then(setGroups).catch(console.error)
              }}
            />
          )}
        </>
      )}

      {inviteOpen && (
        <InviteBotModal
          onClose={() => setInviteOpen(false)}
          onCreated={(bot) => {
            setInviteOpen(false)
            setBots((prev) => [...prev, bot])
            setView({ kind: 'dm', botId: bot.id })
          }}
        />
      )}
      {createGroupOpen && (
        <CreateGroupModal
          bots={bots}
          onClose={() => setCreateGroupOpen(false)}
          onCreated={(group) => {
            setCreateGroupOpen(false)
            setGroups((prev) => [...prev, group])
            setView({ kind: 'group', groupId: group.id })
          }}
        />
      )}
      {createTaskOpen && (
        <TaskModal
          bots={bots}
          onClose={() => setCreateTaskOpen(false)}
          onCreated={(thread) => {
            setCreateTaskOpen(false)
            setTaskThreads((prev) => [thread, ...prev])
            switchView({ kind: 'task', threadId: thread.id })
          }}
        />
      )}
    </div>
  )
}
