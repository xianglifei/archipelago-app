// IPC 通道名与推送事件载荷类型

import type { GroupThinkingState } from './types'

export const IPC = {
  Boot: 'arch:boot',
  WizardComplete: 'arch:wizard:complete',
  WizardGrantInfo: 'arch:wizard:grant-info',
  ProviderTest: 'arch:provider:test',
  BotsList: 'arch:bots:list',
  BotsCreate: 'arch:bots:create',
  BotsUpdate: 'arch:bots:update',
  BotsDelete: 'arch:bots:delete',
  BotsCapabilities: 'arch:bots:capabilities',
  BotTasksList: 'arch:bots:tasks',
  TasksCancel: 'arch:tasks:cancel',
  BotSkillsList: 'arch:bots:skills',
  SkillsUninstall: 'arch:skills:uninstall',
  SkillsCenterList: 'arch:skills:center-list',
  SkillsCenterDetail: 'arch:skills:center-detail',
  SkillsCenterFreeze: 'arch:skills:center-freeze',
  SkillsCenterDelete: 'arch:skills:center-delete',
  SkillsCenterInstallTo: 'arch:skills:center-install-to',
  SkillsOfficialInstall: 'arch:skills:official-install',
  SkillsCatalog: 'arch:skills:catalog',
  // MCP 连接器(2026-11-06):岛上侧管理与分配;用户侧呈现与技能卡零差异
  McpList: 'arch:mcp:list',
  McpDetail: 'arch:mcp:detail',
  McpAdd: 'arch:mcp:add',
  McpInstallTo: 'arch:mcp:install-to',
  McpUninstall: 'arch:mcp:uninstall',
  McpSetDisabled: 'arch:mcp:set-disabled',
  McpDelete: 'arch:mcp:delete',
  McpOfficialInstall: 'arch:mcp:official-install',
  McpTemplatePlaceholders: 'arch:mcp:template-placeholders',
  BotFilesList: 'arch:bots:files',
  FilesReveal: 'arch:files:reveal',
  FilesOpen: 'arch:files:open',
  /** 内置 md 阅读器(2026-11-06 只读拍板):读 .md 文本(≤256KB);仅阅读器窗口可调,详见 md-reader.ts */
  FilesReadText: 'arch:files:read-text',
  /** 在独立阅读器窗口打开 .md(单例,新文件替换内容) */
  MdReaderOpen: 'arch:md-reader:open',
  /** 居民正文内嵌图(2026-11-05):本机路径 → 校验+缩放 → dataURL,详见 markdown-image-core.ts */
  ImageRead: 'arch:image:read',
  /** 内置图片查看器(2026-11-06 拍板):读原样字节原图(≤32MB 不缩放);仅查看器窗口可调,详见 img-viewer.ts */
  ImageReadFull: 'arch:image:read-full',
  /** 在独立查看器窗口打开图片(单例,新图替换内容) */
  ImgViewerOpen: 'arch:img-viewer:open',
  WorkspaceOpen: 'arch:workspace:open',
  HiddenDmsGet: 'arch:hidden-dms:get',
  HiddenDmsSet: 'arch:hidden-dms:set',
  /** 回合过程默认折叠/展开(2026-11-08 设置项):纯 UI 偏好,存 meta KV */
  TurnProcessGet: 'arch:turn-process:get',
  TurnProcessSet: 'arch:turn-process:set',
  ConversationsOverview: 'arch:conversations:overview',
  ChatHistory: 'arch:chat:history',
  ChatSend: 'arch:chat:send',
  ChatStop: 'arch:chat:stop',
  ChatExport: 'arch:chat:export',
  // 任务会话(2026-11-06「新建任务」):基于居民的上下文隔离专属会话,CRUD+收发走独立通道
  TaskThreadsList: 'arch:task-threads:list',
  TaskThreadCreate: 'arch:task-thread:create',
  TaskThreadHistory: 'arch:task-thread:history',
  TaskThreadSend: 'arch:task-thread:send',
  TaskThreadStop: 'arch:task-thread:stop',
  TaskThreadRename: 'arch:task-thread:rename',
  TaskThreadClose: 'arch:task-thread:close',
  /** 更换/设定任务的工作目录绑定(2026-11-10 第一批):走绑定授权卡 */
  TaskThreadSetWorkdir: 'arch:task-thread:set-workdir',
  ExchangeDetail: 'arch:exchange:detail',
  SettingsGet: 'arch:settings:get',
  SettingsSave: 'arch:settings:save',
  UiLanguageGet: 'arch:ui-language:get',
  UiLanguageSet: 'arch:ui-language:set',
  GroupsList: 'arch:groups:list',
  GroupsCreate: 'arch:groups:create',
  GroupsUpdate: 'arch:groups:update',
  GroupsDelete: 'arch:groups:delete',
  GroupHistory: 'arch:group:history',
  GroupSend: 'arch:group:send',
  GroupStop: 'arch:group:stop',
  MemoryList: 'arch:memory:list',
  MemoryAdd: 'arch:memory:add',
  MemoryDelete: 'arch:memory:delete',
  OwnerProfile: 'arch:owner:profile',
  OwnerStatementAdd: 'arch:owner:statement:add',
  OwnerStatementUpdate: 'arch:owner:statement:update',
  OwnerStatementDelete: 'arch:owner:statement:delete',
  OwnerStatementAssign: 'arch:owner:statement:assign',
  OwnerObservationDelete: 'arch:owner:observation:delete',
  OwnerCurate: 'arch:owner:curate',
  OwnerExtract: 'arch:owner:extract',
  UpdateState: 'arch:update:state',
  UpdateCheck: 'arch:update:check',
  UpdateDownload: 'arch:update:download',
  UpdateCancel: 'arch:update:cancel',
  UpdateOpen: 'arch:update:open',
  UpdateInstall: 'arch:update:install',
  UpdateSkip: 'arch:update:skip',
  UpdatePrefs: 'arch:update:prefs',
  UpdateSeen: 'arch:update:seen',
  WindowMinimize: 'arch:window:minimize',
  WindowToggleMaximize: 'arch:window:toggle-maximize',
  WindowClose: 'arch:window:close',
  WindowIsMaximized: 'arch:window:is-maximized',
  ApprovalResolve: 'arch:approval:resolve',
  PickDirectory: 'arch:dialog:pick-directory',
  AttachmentsPick: 'arch:attachments:pick',
  AttachmentsIntake: 'arch:attachments:intake',
  SafetyGet: 'arch:safety:get',
  SafetySet: 'arch:safety:set',
  AuthState: 'arch:auth:state',
  AuthRefresh: 'arch:auth:refresh',
  CreditsGet: 'arch:credits:get',
  CreditsRedeem: 'arch:credits:redeem',
  AuthRequestCode: 'arch:auth:request-code',
  AuthVerify: 'arch:auth:verify',
  AuthClaimConfirm: 'arch:auth:claim-confirm',
  AuthClaimDecline: 'arch:auth:claim-decline',
  AuthLogout: 'arch:auth:logout',
  PostOverview: 'arch:post:overview',
  PostSend: 'arch:post:send',
  PostFriendRespond: 'arch:post:friend-respond',
  PostFriendRequest: 'arch:post:friend-request',
  PostSaveInviteQr: 'arch:post:invite-save-qr',
  PostCopyInviteImage: 'arch:post:invite-copy-image',
  PostBlock: 'arch:post:block',
  PostDeleteContact: 'arch:post:delete-contact',
  PostDeleteLetter: 'arch:post:delete-letter',
  PostInviteCreate: 'arch:post:invite-create',
  PostInviteParse: 'arch:post:invite-parse',
  PostMarkRead: 'arch:post:mark-read',
  PostMarkReadMany: 'arch:post:mark-read-many',
  PostPull: 'arch:post:pull',
  PostAttachmentsPick: 'arch:post:attachments-pick',
  PostAttachmentsIntake: 'arch:post:attachments-intake'
} as const

export const EV = {
  ChatUserAdded: 'ev:chat:user-added',
  ChatDelta: 'ev:chat:delta',
  ChatReasoning: 'ev:chat:reasoning',
  /** 流已建立但还没出字(DeepSeek 排队期下发 : keep-alive 注释行):界面据此显示「排队等待大模型」 */
  ChatActivity: 'ev:chat:activity',
  ChatDone: 'ev:chat:done',
  ChatError: 'ev:chat:error',
  ChatStopped: 'ev:chat:stopped',
  /** 步界(中间正文折进时间线):本步之后还有工具轮,已流出的正文是过程旁白不是结论——界面清空实时气泡让位给下一段 */
  ChatStep: 'ev:chat:step',
  BotsChanged: 'ev:bots:changed',
  /** 岛主档案有变化(观察新增/档案管家整理/手动增删),打开中的档案抽屉静默重载 */
  OwnerChanged: 'ev:owner:changed',
  GroupsChanged: 'ev:groups:changed',
  GroupUserAdded: 'ev:group:user-added',
  GroupDelta: 'ev:group:delta',
  /** 成员回合开始(2026-10-30 群聊思考指示):群聊用户消息→首段正文之间原本零事件(排队/思考/
   *  工具执行全静默),回合一开跑即发——渲染端据此在输入框上方亮「X 正在想」三点指示 */
  GroupTurnStart: 'ev:group:turn-start',
  GroupDone: 'ev:group:done',
  GroupError: 'ev:group:error',
  /** 群聊步界(语义同 ChatStep):清空该居民已流出的过程文字,过程反馈交还左下角思考指示 */
  GroupStep: 'ev:group:step',
  /** 某个居民的消息列表有新增(如居民私信事件行),对应窗口静默重载 */
  ChatSync: 'ev:chat:sync',
  /** 回合生命周期变化(2026-10-30 列表实时状态):单聊 active / 群聊 groupActive 增删时广播。
   *  刻意无载荷——渲染端收到即重查 conversationsOverview 拿 busy 真态快照,与 turnActive 同构,
   *  天然防事件乱序/丢失(第四十五轮教训);多回合并发只是多几次重拉,本地查询极便宜 */
  TurnChanged: 'ev:turn:changed',
  /** 任务会话列表有变动(2026-11-06 新建任务):新建/改名/结束/标题自动生成;
   *  刻意无载荷(同 TurnChanged 口径):渲染端收到即重拉 taskThreadsList 与消息列表预览 */
  ThreadsChanged: 'ev:threads:changed',
  /** 技能卡有变动(记卡/更新/装卸),打开中的档案技能页签静默重载 */
  SkillsChanged: 'ev:skills:changed',
  /** MCP 连接器增删/停用/分配变化(技能中心与档案页签刷新) */
  ConnectorsChanged: 'ev:mcp:changed',
  /** 定时任务有变动(登记/修改/取消/触发),打开中的档案任务页签静默重载 */
  TasksChanged: 'ev:tasks:changed',
  /** 邮局有变动(新信/回执/好友/发送状态),渲染端重拉 overview */
  PostChanged: 'ev:post:changed',
  /** 请求把视图切到某位居民的单聊(如点击审批系统通知);带 pending 审批时输入区会自动变成决策面板 */
  FocusBot: 'ev:chat:focus-bot',
  /** 升级状态快照变化(整包下发,渲染端直接替换) */
  UpdateState: 'ev:update:state',
  /** 菜单栏「偏好设置…」请求打开设置 */
  OpenSettings: 'ev:app:open-settings',
  /** 窗口最大化状态变化(2026-11-04 方案 C:Windows 自绘三键的 □/❐ 图标切换依据),payload=boolean */
  WindowMaximized: 'ev:window:maximized',
  /** 登录态变化(登录/绑定/登出/刷新),payload 为最新 SeaSessionState(登出为 null) */
  AuthChanged: 'ev:auth:changed',
  /** 界面语言切换:主进程落盘后广播,渲染端 changeLanguage 即时生效 */
  LanguageChanged: 'ev:ui:language-changed',
  /** 阅读器窗口加载/切换文件(单例窗口被再次触发打开时下发,含首开的排队路径);payload=MdReaderLoadEvent */
  MdReaderLoad: 'ev:md-reader:load',
  /** 查看器窗口加载/切换图片(语义同 MdReaderLoad);payload=ImgViewerLoadEvent */
  ImgViewerLoad: 'ev:img-viewer:load'
} as const

/** 阅读器窗口加载事件:主进程 openMdReader 下发(窗口已就绪直发;首开未就绪先排队,did-finish-load 后补发) */
export interface MdReaderLoadEvent {
  path: string
}

/** 查看器窗口加载事件:语义同 MdReaderLoadEvent,原图由查看器窗口自行经 ImageReadFull 拉取 */
export interface ImgViewerLoadEvent {
  path: string
}

export interface ChatSyncEvent {
  botId: string
}

export interface FocusBotEvent {
  botId: string
  /** 任务会话的审批卡点击通知时带上(2026-11-06 新建任务):切到任务视图而非居民单聊 */
  threadId?: string
}

// 任务会话回合(2026-11-06「新建任务」):单聊事件带 threadId=发生在任务会话里,缺省=普通单聊;
// 渲染端 ChatView 据此把流路由到任务视图,居民单聊视图不受任务回合打扰(反向亦然)
export interface ChatUserAddedEvent {
  botId: string
  threadId?: string
  message: import('./types').ChatMessage
}

export interface ChatDeltaEvent {
  botId: string
  threadId?: string
  text: string
}

export interface ChatActivityEvent {
  botId: string
  threadId?: string
}

export interface ChatDoneEvent {
  botId: string
  threadId?: string
  message: import('./types').ChatMessage
}

export interface ChatErrorEvent {
  botId: string
  threadId?: string
  error: string
  /** 结构化错误码(群岛通道:insufficient_credits 等),渲染端据此区分积分不足 */
  code?: string
}

export interface ChatStoppedEvent {
  botId: string
  threadId?: string
  message: import('./types').ChatMessage | null
}

export interface ChatStepEvent {
  botId: string
  threadId?: string
}

export interface TasksChangedEvent {
  botId: string
}

export interface GroupUserAddedEvent {
  groupId: string
  message: import('./types').GroupMessage
}

export interface GroupDeltaEvent {
  groupId: string
  botId: string
  botName: string
  text: string
}

export interface GroupDoneEvent {
  groupId: string
  botId: string
  message: import('./types').GroupMessage | null
}

export interface GroupErrorEvent {
  groupId: string
  error: string
  /** 结构化错误码(群岛通道 RelayError.code),渲染端据此映射人话(2026-11-03 与单聊对齐) */
  code?: string
}

export interface GroupStepEvent {
  groupId: string
  botId: string
  botName: string
}

export interface GroupTurnStartEvent extends GroupThinkingState {
  groupId: string
}

export interface UpdateStateEvent {
  state: import('./types').UpdateState
}

export interface AuthChangedEvent {
  state: import('./types').SeaSessionState | null
}

export interface LanguageChangedEvent {
  lang: import('./types').UiLanguage
}
