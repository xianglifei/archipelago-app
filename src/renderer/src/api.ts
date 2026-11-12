import { EV } from '@shared/ipc-channels'
import type {
  AuthChangedEvent,
  ChatActivityEvent,
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatStoppedEvent,
  ChatStepEvent,
  ChatSyncEvent,
  ChatUserAddedEvent,
  FocusBotEvent,
  GroupDeltaEvent,
  GroupDoneEvent,
  GroupErrorEvent,
  GroupStepEvent,
  GroupTurnStartEvent,
  GroupUserAddedEvent,
  UpdateStateEvent,
  MdReaderLoadEvent,
  ImgViewerLoadEvent
} from '@shared/ipc-channels'

export const api = window.archipelago

export function onChatUserAdded(cb: (e: ChatUserAddedEvent) => void): () => void {
  return api.on(EV.ChatUserAdded, (d) => cb(d as ChatUserAddedEvent))
}

export function onChatDelta(cb: (e: ChatDeltaEvent) => void): () => void {
  return api.on(EV.ChatDelta, (d) => cb(d as ChatDeltaEvent))
}

export function onChatReasoning(cb: (e: ChatDeltaEvent) => void): () => void {
  return api.on(EV.ChatReasoning, (d) => cb(d as ChatDeltaEvent))
}

export function onChatActivity(cb: (e: ChatActivityEvent) => void): () => void {
  return api.on(EV.ChatActivity, (d) => cb(d as ChatActivityEvent))
}

export function onChatDone(cb: (e: ChatDoneEvent) => void): () => void {
  return api.on(EV.ChatDone, (d) => cb(d as ChatDoneEvent))
}

export function onChatError(cb: (e: ChatErrorEvent) => void): () => void {
  return api.on(EV.ChatError, (d) => cb(d as ChatErrorEvent))
}

export function onChatStopped(cb: (e: ChatStoppedEvent) => void): () => void {
  return api.on(EV.ChatStopped, (d) => cb(d as ChatStoppedEvent))
}

export function onChatStep(cb: (e: ChatStepEvent) => void): () => void {
  return api.on(EV.ChatStep, (d) => cb(d as ChatStepEvent))
}

export function onBotsChanged(cb: () => void): () => void {
  return api.on(EV.BotsChanged, () => cb())
}

export function onOwnerChanged(cb: () => void): () => void {
  return api.on(EV.OwnerChanged, () => cb())
}

export function onSkillsChanged(cb: () => void): () => void {
  return api.on(EV.SkillsChanged, () => cb())
}

export function onConnectorsChanged(cb: () => void): () => void {
  return api.on(EV.ConnectorsChanged, () => cb())
}

export function onTasksChanged(cb: () => void): () => void {
  return api.on(EV.TasksChanged, () => cb())
}

export function onPostChanged(cb: () => void): () => void {
  return api.on(EV.PostChanged, () => cb())
}

export function onGroupsChanged(cb: () => void): () => void {
  return api.on(EV.GroupsChanged, () => cb())
}

export function onGroupUserAdded(cb: (e: GroupUserAddedEvent) => void): () => void {
  return api.on(EV.GroupUserAdded, (d) => cb(d as GroupUserAddedEvent))
}

export function onGroupDelta(cb: (e: GroupDeltaEvent) => void): () => void {
  return api.on(EV.GroupDelta, (d) => cb(d as GroupDeltaEvent))
}

export function onGroupTurnStart(cb: (e: GroupTurnStartEvent) => void): () => void {
  return api.on(EV.GroupTurnStart, (d) => cb(d as GroupTurnStartEvent))
}

export function onGroupDone(cb: (e: GroupDoneEvent) => void): () => void {
  return api.on(EV.GroupDone, (d) => cb(d as GroupDoneEvent))
}

export function onGroupError(cb: (e: GroupErrorEvent) => void): () => void {
  return api.on(EV.GroupError, (d) => cb(d as GroupErrorEvent))
}

export function onGroupStep(cb: (e: GroupStepEvent) => void): () => void {
  return api.on(EV.GroupStep, (d) => cb(d as GroupStepEvent))
}

export function onChatSync(cb: (e: ChatSyncEvent) => void): () => void {
  return api.on(EV.ChatSync, (d) => cb(d as ChatSyncEvent))
}

/** 回合生命周期变化(2026-10-30 列表实时状态):无载荷,收到即重查 busy 真态 */
export function onTurnChanged(cb: () => void): () => void {
  return api.on(EV.TurnChanged, () => cb())
}

/** 任务会话列表有变动(2026-11-06「新建任务」:新建/改名/结束/标题生成):无载荷,重拉清单与预览 */
export function onThreadsChanged(cb: () => void): () => void {
  return api.on(EV.ThreadsChanged, () => cb())
}

export function onFocusBot(cb: (e: FocusBotEvent) => void): () => void {
  return api.on(EV.FocusBot, (d) => cb(d as FocusBotEvent))
}

export function onUpdateState(cb: (e: UpdateStateEvent) => void): () => void {
  return api.on(EV.UpdateState, (d) => cb(d as UpdateStateEvent))
}

export function onOpenSettings(cb: () => void): () => void {
  return api.on(EV.OpenSettings, () => cb())
}

/** 窗口最大化状态(方案 C 自绘三键):payload=boolean */
export function onWindowMaximized(cb: (maximized: boolean) => void): () => void {
  return api.on(EV.WindowMaximized, (d) => cb(d as boolean))
}

/** 阅读器窗口加载/切换文件(2026-11-06 只读阅读器):payload=MdReaderLoadEvent */
export function onMdReaderLoad(cb: (e: MdReaderLoadEvent) => void): () => void {
  return api.on(EV.MdReaderLoad, (d) => cb(d as MdReaderLoadEvent))
}

/** 查看器窗口加载/切换图片(2026-11-06 图片查看器):payload=ImgViewerLoadEvent */
export function onImgViewerLoad(cb: (e: ImgViewerLoadEvent) => void): () => void {
  return api.on(EV.ImgViewerLoad, (d) => cb(d as ImgViewerLoadEvent))
}

export function onAuthChanged(cb: (e: AuthChangedEvent) => void): () => void {
  return api.on(EV.AuthChanged, (d) => cb(d as AuthChangedEvent))
}
