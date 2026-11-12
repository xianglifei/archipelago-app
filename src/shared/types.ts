// 共享类型:主进程、预加载、渲染端三方共用

export interface ModelInfo {
  id: string
  label: string
  contextWindow: number
}

export interface ProviderInfo {
  id: string
  label: string
  baseUrl: string
  keyUrl: string // 获取 API Key 的控制台地址
  models: ModelInfo[]
}

/** 岛(Space):整个群岛实例的身份(M2.8,轻量身份层) */
export interface SpaceInfo {
  id: string
  name: string
  ownerName: string
  createdAt: string
}

/** 权限两档(2026-10-27 重构):semi=半自动(危险动作先问岛主,默认) / auto=全自动(自动审批,直接执行但留痕);
 *  存量一次性迁移 full→auto、readonly/workspace→semi(bots.ts 读时映射);只有岛主能改(红线 6.5) */
export type BotPermission = 'semi' | 'auto'

/** 居民外观(0.7 头像系统):shape=造型 1-28 / variant=配色 0-3(A-D) / eye=眼睛编号;见 shared/avatar.ts */
export interface BotAppearance {
  shape: number
  variant: number
  eye: string
}

export interface Bot {
  id: string
  name: string
  role: string
  persona: string
  /** 性格原型(0.8):id 见 @shared/archetypes;空串按兜底规则处理 */
  archetype: string
  providerId: string
  modelId: string
  isMain: boolean
  color: string
  /** 外观(0.7):null 时渲染端回退为 color+首字 */
  appearance: BotAppearance | null
  /** 本机权限档位(M4.1) */
  permission: BotPermission
  /** 工作区目录(M4.1):文件工具相对路径的基准,默认只允许在这里写 */
  workspacePath: string
  createdAt: string
  updatedAt: string
}

export type ChatRole = 'user' | 'assistant'

export interface RelationMeta {
  /** out=我发给对方 / in=对方发给我 / reply=我回复对方 / reply-in=收到对方的回复 */
  dir: 'out' | 'in' | 'reply' | 'reply-in'
  /** 对方居民的名字 */
  peer: string
  /** reply 行的「处理过但没有回复」标记:静默回合跑过思考/工具但没产出正文(界面显示未获回应,过程挂进私信浮窗) */
  noReply?: true
  /** out/reply-in 行的任务会话出处(2026-11-06「新建任务」):在任务里托人办事时记线程 id——
   *  回信投影与唤醒转述按它回那个任务(上下文与岛主都在那里),崩溃恢复也据此重建;普通私信无此字段 */
  threadId?: string
}

/** 思考过程行(回合折叠 2026-10-27 方案 C):agent 循环每步的思考单独落库,与工具行穿插成时间线 */
export interface ReasoningMeta {
  /** 该段思考持续的毫秒数(该步首个到最后一个 reasoning delta;静默回合无流式事件时按整步调用时长估) */
  durationMs?: number
}

/** 回合收尾标记:stopped=本回合被停止/出错,只落了部分正文(折叠签显示「已停止」且默认展开) */
export interface TurnMeta {
  stopped?: true
}

/** 定时任务触发标记(2026-10-29 定时任务):挂在该居民到点主动开口的 chat 消息上,
 *  界面据此给气泡加「定时任务」小签;meta.taskId 可回查任务 */
export interface TaskRunMeta {
  taskId: string
}

/** 唤醒转述标记(回复唤醒,2026-11-05):对方回信落地后唤醒本居民转述,挂在这条主动开口的
 *  chat 消息上,界面据此给气泡加「收到回信」小签;relay.peer=回信的对方 */
export interface RelayMeta {
  relay: { peer: string; exchangeId?: string }
  /** 本条是停止/出错留下的部分转述(与 TurnMeta 同口径) */
  stopped?: true
}

/** 审批卡(§6.2):敏感操作确认。审批即输入——pending 卡在输入区以决策面板出现,消息流里只留小签 */
export interface ApprovalMeta {
  approvalId: string
  /** 工具原始名,如 run_command / write_file */
  toolName: string
  /** 卡片标题,如「请求执行命令」 */
  title: string
  /** 卡片正文:命令原文 / 目标路径等 */
  detail: string
  /** 为什么需要审批 */
  reason: string
  /** pending=等决策;approved/turn-allowed/denied/aborted=岛主已决;auto-approved=全自动档自动放行(留痕不拦,2026-10-27) */
  status: 'pending' | 'approved' | 'turn-allowed' | 'denied' | 'aborted' | 'auto-approved'
  /** 决策落定时间(ISO);pending 为空;auto-approved 为放行时间 */
  decidedAt?: string
  /** 点「以后全自动」转档后盖的章:本卡按已允许放行,且该居民此后全自动 */
  escalatedTo?: 'auto'
  /** 不提供「以后全自动」档(2026-11-10 工作目录绑定卡):目录授权是任务级语义,
   *  居民级升全自动的误触代价过大;true 时卡面与快捷键都不出 always */
  noAlways?: boolean
}

/** 工具动作事件行(§1 永远可见):居民在回合中写文件/执行命令/联网时,在其单聊里以居中小行内联展示 */
export interface ToolEventMeta {
  /** 工具名,如 write_file / run_command / web_search */
  toolName: string
  /** running=执行中;done=已返回(含工具以文案报的拒绝/未执行);failed=执行抛异常 */
  status: 'running' | 'done' | 'failed'
  /** 收尾摘要,如「1.2k 字符」「3 处」「exit 0 · 2.3s」「被拒」 */
  outcome?: string
  /** 双语结构化标签(2026-10-30):k=渲染端词典 key(chat.tool.*);渲染端优先用它,缺省回落中文正文(存量行) */
  labelK?: { k: string; p?: Record<string, string | number> }
  /** 双语结构化收尾摘要;渲染端优先用它,缺省回落中文 outcome */
  outcomeK?: { k: string; p?: Record<string, string | number> }
  /** 写入/编辑的目标绝对路径(按居民工作区解析);界面文件名可点,用系统默认程序打开 */
  path?: string
}

/** 附件 intake 项:粘贴/拖拽进来的东西要么是「有真实路径的文件」(Finder 复制/拖入),要么是「无路径的图片字节」(截图、网页复制图片) */
export type AttachmentIntakeItem = { path: string } | { dataUrl: string; name: string }

/** 选区引用的来源类型(2026-11-02 聊天选区引用):=user 气泡/assistant 正文气泡/reasoning 思考正文/
 *  note 中间步旁白/relation 私信行展开文本;工具行动作行经拍板不参与(文本短、引用价值低) */
export type QuoteKind = 'user' | 'assistant' | 'reasoning' | 'note' | 'relation'

/** 一条选区引用(2026-11-02):kind+botName 两端分别渲染——界面过 i18n,注入 prompt 的引用块中文写死(居民世界文本不翻) */
export interface ChatQuote {
  /** 前端生成(crypto.randomUUID 带兜底);仅用于界面逐条移除,不参与语义 */
  id: string
  /** 选中的原文(trim 后) */
  text: string
  kind: QuoteKind
  /** 群聊里谁说的(挂 data-quote-bot 的容器才有;单聊空=当前居民,标「居民回复」) */
  botName?: string
}

/** 用户消息携带的选区引用(2026-11-02):随消息落 meta,历史回看渲染引用卡,投影上下文时注入引用块 */
export interface QuoteMeta {
  quotes: ChatQuote[]
}

export interface ChatMessage {
  id: number
  sessionId: string
  role: ChatRole
  content: string
  reasoning: string | null
  createdAt: string
  /** 早期版本的 Bot 间私信不进用户界面 */
  hidden?: boolean
  /** chat=普通对话;relation=居民私信事件行(DS Bot 式内联展示);approval=审批卡;tool=工具动作事件行;reasoning=思考过程行(与工具行穿插成回合时间线);note=中间步正文旁白行(带工具调用的步骤产出的过渡性文字,折进时间线,待遇同思考行) */
  kind?: 'chat' | 'relation' | 'approval' | 'tool' | 'reasoning' | 'note'
  meta?: RelationMeta | ApprovalMeta | ToolEventMeta | ReasoningMeta | TurnMeta | TaskRunMeta | RelayMeta | QuoteMeta
  /** 私信交流 ID:一次 send_message 的各 relation 行共用;界面按它折叠为单气泡,点开看详情 */
  exchangeId?: string
  /** 回合 id(回合折叠方案 C):一次「用户消息 → 过程行 → 最终回复」的全部行共享;旧消息无此字段,界面按位置推导兜底 */
  turnId?: string
  /** 岛主随消息附的文件/文件夹/图片(2026-10-29 输入框升级);仅用户消息使用,旧消息无此字段 */
  attachments?: MessageAttachment[]
}

/** 消息附件(2026-10-29 输入框升级):岛主随消息发给居民的文件/文件夹/图片引用。
 *  文件/文件夹=原始路径引用(居民用 read_file/list_dir 按需读);
 *  图片=先缩后落岛数据目录的副本(path 即副本路径,thumb 为小图 dataURL 供界面直出,不占上下文) */
export interface MessageAttachment {
  kind: 'file' | 'dir' | 'image'
  /** 绝对路径;图片为岛数据目录 attachments/ 下的落盘副本 */
  path: string
  /** 展示名(不含路径) */
  name: string
  /** 字节数(展示用;拿不到为空) */
  size?: number
  /** 缩略图 dataURL(仅图片,≈320px JPEG;输入框附件签与气泡卡直接渲染,避免 file:// 直读在 dev http 下被拦) */
  thumb?: string
}

/** 居民正文内嵌图(2026-11-05 方案 A):IPC 读本机图片的结果;失败只回 reason 码,文案由渲染层走词典 */
export type ImageReadResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: 'bad-path' | 'not-found' | 'no-access' | 'not-image' | 'too-large' }

/** 内置图片查看器(2026-11-06 拍板):读原样字节原图的结果(不缩放,≤32MB);
 *  失败只回 reason 码,文案由查看器窗口走词典 */
export type ImageFullReadResult =
  | { ok: true; dataUrl: string; size: number }
  | { ok: false; reason: 'bad-path' | 'not-found' | 'no-access' | 'not-image' | 'too-large' }

/** 内置 md 阅读器(2026-11-06 只读拍板):读取 .md 文本的结果;失败只回 reason 码,文案由阅读器窗口走词典 */
export type MdTextReadResult =
  | { ok: true; content: string; size: number; mtimeMs: number }
  | {
      ok: false
      reason: 'bad-path' | 'not-found' | 'no-access' | 'not-md' | 'too-large' | 'binary' | 'read-error'
      /** 原始 errno 等(仅日志/排查用,不直接展示) */
      detail?: string
    }

export interface BootState {
  /** login=整屏登录门(0.8 账号即门);app=已解锁,进向导或主界面 */
  gate: 'login' | 'app'
  wizardDone: boolean
  space: SpaceInfo | null
  hasApiKey: boolean
}

/** 0.9 起向导不再配置模型(群岛通道开箱即用),只收岛名与岛主称呼 */
export interface WizardInput {
  islandName: string
  ownerName: string
}

export interface TestConnectionInput {
  providerId: string
  modelId: string
  apiKey: string
}

export interface TestResult {
  ok: boolean
  error?: string
  latencyMs?: number
}

export interface CreateBotInput {
  name: string
  role: string
  persona: string
  /** 性格原型 id(0.8);缺省 = 温柔(手动邀请默认档) */
  archetype?: string
  providerId: string // 传空字符串则继承全局默认
  modelId: string
  /** 外观(0.7);缺省时主进程随机一个 */
  appearance?: BotAppearance
}

export interface HistoryResult {
  sessionId: string
  messages: ChatMessage[]
  /** 该居民是否有用户可见回合正在进行(主进程真态):界面挂载时据此恢复 busy/停止键,防切走再切回后状态丢失 */
  turnActive: boolean
  /** 进行中回合的类型(空闲缺省;#34):'relation'/'digest'=正在静默回私信,驱动「回信中」折叠签的运行态 */
  turnKind?: 'chat' | 'relation' | 'digest' | 'scheduled'
}

/** 群聊(M5):值守模式,@点名,成员 [PASS] */
export interface GroupInfo {
  id: string
  name: string
  announcement: string
  adminBotId: string
  createdAt: string
  members: Bot[]
}

export interface GroupMessage {
  id: number
  groupId: string
  senderType: 'user' | 'bot'
  botId: string | null
  botName: string | null
  botColor: string | null
  content: string
  createdAt: string
  /** 岛主随消息附的文件/文件夹/图片(2026-10-29 输入框升级);旧消息无此字段 */
  attachments?: MessageAttachment[]
  /** 用户消息携带的选区引用(2026-11-02);旧消息无此字段 */
  meta?: QuoteMeta
}

/** 群聊左下角思考指示(2026-10-30):当前正在发言的居民;queue=本轮目标里排在后面的居民数 */
export interface GroupThinkingState {
  botId: string
  botName: string
  queue: number
}

/** 群历史拉取:消息 + 当前思考真态(主进程 groupActive 推导)——界面挂载时据此恢复指示条/停止键,
 *  对齐单聊 HistoryResult.turnActive 的修法(切走再切回不丢态) */
export interface GroupHistoryResult {
  messages: GroupMessage[]
  thinking: GroupThinkingState | null
}

export interface CreateGroupInput {
  name: string
  announcement: string
  memberIds: string[]
  /** 群管理员(2026-10-27 解绑 Momo):显式指定须在成员内;缺省回落主 Bot,主 Bot 不在成员里则取名册首位。
   *  居民建群传发起者;岛主手动建群传第一个勾选的成员。 */
  adminBotId?: string
}

/** 群管理(2026-10-23 三轮评审):改群名 + 全量同步成员;管理员被移出时自动移交给名册首位(2026-10-27) */
export interface UpdateGroupInput {
  name: string
  memberIds: string[]
}

/** 记忆(M6):Markdown 文件,双作用域(私有 + 集体记忆) */
export interface MemoryEntry {
  line: number
  date: string
  text: string
}

/** 私信交流的一轮逻辑消息(详情浮窗用):由发起方会话的 relation 行重建,两侧投影已去重 */
export interface ExchangeRound {
  from: string
  to: string
  /** 发送者头像色,居民已送别时为 null(渲染退灰) */
  color: string | null
  content: string
  createdAt: string
}

/** 私信交流详情:一次 send_message 的完整往返日志 */
export interface ExchangeDetail {
  exchangeId: string
  initiator: string
  peer: string
  rounds: ExchangeRound[]
  /** 发起方是否收到过回复 */
  replied: boolean
  createdAt: string
  /** 回信方处理这封私信的过程行(B 侧静默回合的思考/工具行,按回复行 turnId 挂入;旧私信无) */
  peerProcess?: ChatMessage[]
  /** 回信方跑过过程但没有产出回复(标记行存在):浮窗在来信下方展示过程折叠区 + 「没有回复」 */
  peerNoReply?: boolean
}

export interface BotMemory {
  botId: string
  botName: string
  entries: MemoryEntry[]
}

export interface MemoryState {
  shared: MemoryEntry[]
  bots: BotMemory[]
}

// ---- 岛主档案(M6.11):第三记忆作用域,「关于岛主这个人」的事实天然跨居民,全员共知 ----

/** 画像分节:固定六节,顺序即注入优先级(taboo 最先) */
export type OwnerSection = 'identity' | 'preference' | 'communication' | 'relation' | 'attention' | 'taboo'

/** 画像条目:档案管家从观察合并而成(或岛主手动添加/编辑);被取代/删除的进 history 留痕 */
export interface OwnerStatement {
  id: string
  section: OwnerSection
  text: string
  /** 支撑本条的观察 id;观察被清理后 id 仍保留,界面显示「已清理」 */
  sources: string[]
  firstSeen: string
  lastConfirmed: string
  /** 本条取代的旧条目 id(冲突合并留痕) */
  supersedes?: string
  /** 被哪条新条目取代(仅在 history 中的条目上有值) */
  supersededBy?: string
  /** 「近期关注」类条目的有效期(YYYY-MM-DD);过期不再注入,界面置灰 */
  expiresAt?: string
}

/** 居民对岛主的一条原始观察:记忆管家从对话里记下,append-only,等档案管家整理 */
export interface OwnerObservation {
  id: string
  date: string
  /** 听到这句话的居民名(写入时定格,改名不影响历史) */
  botName: string
  text: string
  status: 'pending' | 'merged' | 'rejected'
}

export interface OwnerProfileState {
  statements: OwnerStatement[]
  history: OwnerStatement[]
  observations: OwnerObservation[]
}

export type BotPatch = {
  name?: string
  role?: string
  persona?: string
  /** 性格原型 id(0.8);岛务长专属原型仅主 Bot 可设 */
  archetype?: string
  providerId?: string
  modelId?: string
  permission?: BotPermission
  workspacePath?: string
  /** 外观(0.7);传 null 重置为无外观(回退 color+首字) */
  appearance?: BotAppearance | null
}

export interface ModelSettings {
  providerId: string
  modelId: string
}

export interface SettingsState {
  space: SpaceInfo
  model: ModelSettings
  hasApiKey: boolean
}

export interface SettingsSaveInput {
  islandName?: string
  ownerName?: string
  providerId?: string
  modelId?: string
  apiKey?: string // 留空表示不修改
}

export interface WizardResult {
  boot: BootState
  bot: Bot
  welcome: ChatMessage
}

/** 向导预取(0.9.2 自走查 A4):首岛判定 + 注册赠送额——都前置到向导早期异步完成,完成页现场零查询 */
export interface WizardGrantInfo {
  /** 账号名下尚无任何岛 = 新用户的第一个岛,完成页才展示赠送卡片 */
  firstIsland: boolean
  /** 运营配置的注册赠送额(milli;0=已关闭赠送,同样不展示卡片) */
  signupGrantMilli: number
}

/** 升级机制:静态清单(update.json)驱动的半自动更新 */
export interface UpdateAsset {
  url: string
  size: number
  /** hex 编码,下载完成后本地校验 */
  sha512: string
}

export interface UpdateManifest {
  channel: string
  version: string
  releaseDate: string
  /** 低于此版本强制升级(安全修复/协议不兼容),提醒不可忽略、跳过失效 */
  minVersion?: string | null
  /** 灰度放量百分比 0-100,按本机稳定 ID 哈希决定是否命中 */
  rollout?: number
  /** 更新日志(Markdown),来自 CHANGELOG 的版本小节 */
  notes?: string
  downloads: { 'mac-arm64'?: UpdateAsset }
}

export interface UpdatePrefs {
  autoCheck: boolean
  autoDownload: boolean
  skippedVersions: string[]
}

export type UpdatePrefsPatch = {
  autoCheck?: boolean
  autoDownload?: boolean
}

/** idle=空闲 checking=检查中 downloading=下载中 downloaded=已就绪 error=失败 unsupported=本平台不支持(Windows 首版) */
export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error' | 'unsupported'

/** 主进程持有的升级状态快照,变化时整包广播给渲染端 */
export interface UpdateState {
  currentVersion: string
  status: UpdateStatus
  devMode: boolean
  /** 清单里的最新版本;为 null 表示没有可比对的新版本 */
  version: string | null
  releaseDate: string | null
  notes: string | null
  /** 本地版本低于清单 minVersion */
  mandatory: boolean
  /** 用户已跳过该版本(强制版本时自动失效) */
  skipped: boolean
  /** 灰度未命中,该版本对这台机器暂不可见 */
  rolloutExcluded: boolean
  /** 侧栏设置入口红点(有可见新版本且未查看过) */
  showBadge: boolean
  /** 本次运行首次发现的新版本,岛务广播用;强制版本每次启动都会再广播 */
  freshVersion: string | null
  lastCheckedAt: string | null
  lastError: string | null
  downloadProgress: { received: number; total: number } | null
  /** 就绪后的操作形态:inplace=重启即自动换壳(electron-updater);dmg=打开安装包手动拖装 */
  installMode: 'inplace' | 'dmg' | null
  downloadedPath: string | null
  /** 清单里的直链,作为打开安装包失败时的兜底 */
  downloadUrl: string | null
  prefs: UpdatePrefs
}

/** 居民内置工具 id 全集(「居民基础工具包」)。
 *  新增内置工具时必须在此登记:主进程技能目录(tools.ts CAPABILITY_CATALOG)与
 *  渲染层技能图标(BotProfileDrawer.tsx SKILL_ICONS)都以 Record<ToolId,…> 强制全集对齐——
 *  漏登记目录或漏配图标,typecheck 直接红,不靠事后肉眼发现 */
export type ToolId =
  | 'invite_resident'
  | 'update_resident'
  | 'send_message'
  | 'create_group'
  | 'dissolve_group'
  | 'post_to_group'
  | 'create_skill'
  | 'update_skill'
  | 'install_skill'
  | 'uninstall_skill'
  | 'load_skill'
  | 'import_skill'
  | 'set_task'
  | 'update_task'
  | 'cancel_task'
  | 'list_tasks'
  | 'open_task'
  | 'rename_task'
  | 'set_task_workdir'
  | 'read_own_chat'
  | 'read_my_profile'
  | 'web_search'
  | 'web_fetch'
  | 'read_file'
  | 'list_dir'
  | 'find_files'
  | 'search_files'
  | 'write_file'
  | 'edit_file'
  | 'run_command'
  | 'send_letter'
  | 'read_mailbox'
  | 'list_contacts'

/** 居民技能条目(档案「技能」页签) */
export interface BotCapability {
  id: ToolId
  name: string
  desc: string
}

// ---- 定时任务(2026-10-29 定时任务):岛主口头交代、居民工具登记、调度器到点唤醒 ----

/** 任务形态:remind=到点提醒(纯说话,任何档位) / act=到点做事(要用工具办事,仅全自动档) */
/** 定时任务形态(2026-11-06 自 TaskKind 更名:Task 前缀让位任务会话族,防 future agent 混淆) */
export type ScheduleKind = 'remind' | 'act'
/** 时间模板(内部五型收敛成存储四型):once=一次性(绝对时刻) / daily=每天 / weekly=每周 / hourly=每小时 */
export type TaskSchedule = 'once' | 'daily' | 'weekly' | 'hourly'
/** 任务状态:一次性 pending→done|missed|failed|canceled;周期 active→canceled */
export type TaskStatus = 'pending' | 'active' | 'done' | 'missed' | 'failed' | 'canceled'

/** 周期参数(daily/weekly 用;hourly/once 不带) */
export interface TaskScheduleDetail {
  /** 触发时刻 HH:MM(24 小时制,本地时区) */
  time?: string
  /** weekly:周几(0=周日 … 6=周六) */
  weekday?: number
  /** daily:仅工作日(周一至周五) */
  weekdaysOnly?: boolean
}

/** 一次触发的历史(task_runs 表) */
export interface BotTaskRun {
  id: number
  /** 原定触发时刻(ms) */
  scheduledAt: number
  /** 实际触发时刻(ms);missed/顺延未跑为空 */
  ranAt: number | null
  status: 'ok' | 'failed' | 'missed'
  /** 失败/错过原因(人话) */
  note: string | null
}

/** 任务条目(档案「任务」页签):scheduleText/statusText 由主进程组装好直接展示 */
export interface BotTask {
  id: string
  botId: string
  kind: ScheduleKind
  schedule: TaskSchedule
  /** once:绝对时刻(ms);周期型为空 */
  fireAt: number | null
  scheduleDetail: TaskScheduleDetail | null
  /** 任务一句话(居民登记的人话复述版) */
  title: string
  /** 岛主交代时的原话(快照;锚点跳转二批再做) */
  sourceQuote: string
  /** 交代场景:'dm' 单聊 | 'group:<id>' 群聊 */
  sourceChat: string
  status: TaskStatus
  failReason: string | null
  /** 下次触发时刻(ms);终态为空 */
  nextFireAt: number | null
  createdAt: string
  /** 展示用:人话时间,如「今晚 20:00」「每天 08:00(周一至周五)」 */
  scheduleText: string
  /** 展示用:状态中文,如「待办」「进行中」「已错过」 */
  statusText: string
  /** 最近触发历史(新→旧,最多 10 条) */
  runs: BotTaskRun[]
}

/** 已安装的技能卡(档案「技能」页签,2026-10-29 技能系统第一期):居民学会的「手艺」,
 *  与「居民基础工具包」并列展示;技能是岛上居民记下的做法文本,不是新工具 */
export interface BotSkillEntry {
  id: number
  name: string
  description: string
  version: number
  /** 技能级停用(岛主冻结,技能中心第二期给入口):不注入提示,装卸关系保留 */
  frozen: boolean
  /** 创建者即本人(显示「自创」徽章,update_skill 只有 TA 能用) */
  isCreator: boolean
  /** 创建者展示名;已离岛为 null(显示「已离岛居民」) */
  creatorName: string | null
  /** official=精选推荐装来的复制卡(「来自精选推荐」) / imported=岛主导入的外部技能包
   *  (2026-11-08 import_skill:「岛主导入」徽章)——两者都是哨兵创建者,居民不可 update */
  origin: 'island' | 'official' | 'imported'
  updatedAt: string
}

/** 技能中心「岛上的技能」清单行(2026-11-05 二期):全岛所有活卡,含来源/创建者/学会数 */
export interface IslandSkillSummary {
  id: number
  name: string
  description: string
  version: number
  origin: 'island' | 'official' | 'imported'
  /** 自建卡的创建者展示名;官方卡与导入卡为 null(渲染「来自精选推荐」/「岛主导入」);已离岛也为 null */
  creatorName: string | null
  frozen: boolean
  /** 学会这门手艺的居民数 */
  learnerCount: number
  updatedAt: string
}

/** 技能中心「岛上的技能」详情(展开行):正文 + 不可变版本历史 + 安装名单 */
export interface IslandSkillDetail {
  id: number
  name: string
  description: string
  content: string
  version: number
  origin: 'island' | 'official' | 'imported'
  creatorName: string | null
  frozen: boolean
  /** 版本历史,当前版在前 */
  versions: { version: number; description: string; content: string; createdAt: string }[]
  /** 已学会的居民(展示名) */
  installers: { botId: string; name: string }[]
  updatedAt: string
}

/** 精选推荐目录条目(云端 catalog 下发;seed 兜底同构)。
 *  detail=技能详情(用户向大白话,一栏两用:装进岛后居民读到的也是它);
 *  icon 为客户端图标白名单内的 lucide 名(渲染端兜底 Sparkles);color 为品牌图标前景色。
 *  2026-11-06 MCP 连接器:transport 非空=连接器模板卡(与技能卡在精选推荐同货架混排,
 *  用户侧零新概念);configTemplate 为 http/stdio 配置 JSON,密钥用 {{中文占位}},
 *  安装时岛主填值替换(占位符名即输入框标签)。技能卡无这两个字段 */
export interface OfficialSkillCard {
  name: string
  /** 分类(Tab 前瞻:字段名按 section,将来可升格为客户端独立 Tab,数据不动) */
  section: string
  description: string
  detail: string
  url: string
  icon: string
  color: string
  weight: number
  transport?: 'http' | 'stdio'
  configTemplate?: string
}

/** 官方目录整体(ETag/revision 供 24h 缓存与 304) */
export interface OfficialCatalogData {
  revision: number
  skills: OfficialSkillCard[]
}

// ── MCP 连接器(2026-11-06):岛上侧数据形态。用户侧呈现与技能卡零差异(精选推荐/
//    岛上技能两 Tab 混排,不出现「连接器/MCP」字样),内部命名直白用 mcp/connector ──

/** 岛上已装连接器清单行(岛上技能 Tab 与技能卡混排) */
export interface IslandConnectorSummary {
  id: string
  name: string
  description: string
  origin: 'manual' | 'official'
  /** 精选推荐装来的目录名(货架「已装」标记对账用);手动添加为 null */
  catalogName: string | null
  disabled: boolean
  /** 当前可用能力数(未连接时为 0,详情浮窗里有状态) */
  toolCount: number
  /** 已分配居民数 */
  assignedCount: number
  updatedAt: string
}

/** 连接器详情(浮窗):打码配置+运行状态+分配名单 */
export interface ConnectorDetail {
  id: string
  name: string
  description: string
  transport: 'http' | 'stdio'
  /** 展示用打码后的 config JSON(密钥只留头尾) */
  maskedConfig: string
  origin: 'manual' | 'official'
  catalogName: string | null
  disabled: boolean
  assigned: { botId: string; name: string }[]
  runtime: {
    status: 'stopped' | 'starting' | 'ready' | 'error'
    transportKind: 'streamable-http' | 'sse' | 'stdio' | null
    toolCount: number
    lastError: string | null
  }
  updatedAt: string
}

/** 居民经手文件条目(档案「文件」页签):audit 的 write_file/edit_file 记录推导,非实时状态 */
export interface BotFileEntry {
  /** 写入时的绝对路径(audit 原文,不改写) */
  path: string
  /** 展示用:在当前工作区内为相对路径,工作区外为绝对路径 */
  displayPath: string
  /** 是否在该居民当前工作区内 */
  inWorkspace: boolean
  /** 曾以 write_file 新建过(早期审计记录无此标记则为 false,视为修改既有文件) */
  created: boolean
  /** 写入 + 修改总次数 */
  ops: number
  /** 最近一次写入时间(ISO) */
  lastAt: string
  /** 文件当前是否存在于磁盘 */
  exists: boolean
  /** 当前磁盘大小(字节);不存在为 null */
  size: number | null
  /** stat 的 errno code(如 EACCES/EPERM):路径在但主进程无权看(macOS 隐私墙等);真删除(ENOENT)为 null */
  statError: string | null
}

/** 安全设置(§6.7):危险命令模式清单(正则字符串,每条一行),空/未设置时用默认清单 */
export interface SafetyState {
  customPatterns: string[] | null
  defaultPatterns: string[]
}

/** 侧栏统一消息列表的条目预览:最后一条普通消息(chat),供排序与次行展示 */
export interface ConversationPreview {
  kind: 'dm' | 'group' | 'task'
  id: string
  lastAt: string
  /** 群聊带发送者前缀(如「Momo: …」),单聊为原文;主进程已截断;
   *  任务会话(2026-11-06「新建任务」)没消息时为空串,渲染端落「还没交代内容」引导语 */
  preview: string
  /** 该单聊当前挂起的审批数(群聊恒为 0);侧栏据此显角标与待审横条;
   *  任务会话里挂起的审批记在任务行上,不计入居民单聊行 */
  pendingApprovals?: number
  /** 该居民单聊回合进行中的类型(2026-10-30 列表实时状态):主进程 active 注册表真态快照,
   *  侧栏次行替换为「正在想/回信中/做任务中」+ 三点动画;空闲缺省不亮 */
  busy?: 'chat' | 'relation' | 'digest' | 'scheduled'
  /** 该群任一成员回合进行中(群聊行显「讨论中」,群级布尔;「谁在想」归群聊界面左下角指示条) */
  groupBusy?: boolean
}

/**
 * 任务会话(2026-11-06「新建任务」):基于某居民开的上下文隔离专属会话——
 * 继承居民的人设/性格/技能/持久记忆与全部能力,但上下文从零开始;消息列表里独立成行。
 * 与定时任务(tasks 表)是两个概念:这里是岛主主动开的、人在场的工作会话。
 */
export interface TaskThreadInfo {
  id: string
  botId: string
  /** 任务标题;空串=界面显示「新任务」,首轮对话后系统自动起一个短标题,岛主手改过就永不覆盖 */
  title: string
  status: 'open' | 'archived'
  createdAt: string
  updatedAt: string
  // ---- 工作目录绑定(2026-11-10 任务会话并行开发第一批)----
  /** 钉定的工作目录(realpath 规范化);NULL=legacy(从未显式绑定,行为与旧版完全一致) */
  workdirPath: string | null
  /** 绑定来源:explicit=三触点显式(第一批仅此一种);detected/inherited 留给第三批 */
  bindingSource: 'explicit' | 'detected' | 'inherited' | null
  /** 换绑代次:换绑 +1,防旧执行资源(工作树/分支)串进新绑定 */
  bindingGeneration: number
  /** 执行资源状态机:none|preparing|ready|finalizing|closing|closed|error;workdir 模式见 task-workdir */
  wtState: string
  /** 工作树绝对路径(worktree 模式;直连/legacy 为 null) */
  wtPath: string | null
  /** 任务分支全名 task/<居民名安全化>/<id6>(worktree 模式;直连/legacy 为 null) */
  wtBranch: string | null
  /** 基点分支名(worktree 模式) */
  wtBase: string | null
  /** 基点 commit(verify 锚;worktree 模式) */
  wtBaseCommit: string | null
  /** 恢复快照序号(单调递增防覆盖) */
  leftoverSeq: number
  /** error 态的人话原因(界面如实展示) */
  wtError: string | null
}

/** 任务会话工作目录绑定摘要(渲染端 chip 用):主进程推导,避免渲染端重复判定逻辑 */
export interface TaskWorkdirChip {
  /** 目录短名( basename ) */
  dir: string
  /** 引用短名:分支名或「无 git」标记 */
  ref: string
  mode: 'worktree' | 'direct'
}

// ---------- 群岛账号(海域服务,账号系统第一期) ----------
// 产品口径:一台电脑一座岛——登录只为让积分等权益跨设备可用,岛屿数据永不上云、永不同步。

export interface SeaAccountInfo {
  id: string
  email: string
}

/** 账号登记的岛(后台签发的岛唯一 ID 对用户不可见,这里只是数据形状) */
export interface SeaIslandInfo {
  artworkId?: string | null
  id: string
  name: string
  ownerName: string
}

export interface SeaDeviceInfo {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  islands: SeaIslandInfo[]
}

/** 本机登录态:账号 + 名下全部设备(各带岛)+ 本机设备 ID */
/** 积分批次(获取记录表数据源;到期时间即该批积分的失效日) */
export interface CreditBatch {
  amountMilli: number
  remainingMilli: number
  source: string // code | grant | signup
  expiresAt: number
  createdAt: number
}

export interface CreditEvent {
  kind: string // redeem | consume | expire | grant
  amountMilli: number
  balanceAfter: number
  note: string | null
  createdAt: number
}

/** GET /account/credits:套餐与积分页签与余额预警条的数据源 */
export interface CreditsSnapshot {
  balanceMilli: number
  batches: CreditBatch[]
  events: CreditEvent[]
  daily: { date: string; costMilli: number }[] // 近 7 天(旧 → 新)
}

export interface RedeemResult {
  creditedCredits: number
  grantDays: number
  balanceMilli: number
  batchNote: string | null
}

export interface SeaSessionState {
  account: SeaAccountInfo
  devices: SeaDeviceInfo[]
  localDeviceId: string | null
}

export interface SeaCodeResult {
  expiresIn: number
  /** 开发模式(海域服务 DEV_MODE)下直接回显,便于联调;正式环境无此字段 */
  devCode?: string
}

/** 认领卡上的本机存量岛信息 */
export interface SeaClaimIslandInfo {
  name: string
  ownerName: string
  botCount: number
  /** 最后一条消息时间(旧库只读推导;读不出为 null,认领卡隐藏该段) */
  lastUsedAt: string | null
}

/** 登录验证后的去向:enter=重载进主界面 / wizard=重载进建岛向导 / claim=待认领确认 */
export type SeaLoginNext =
  | { next: 'enter'; account: SeaAccountInfo }
  | { next: 'wizard'; account: SeaAccountInfo }
  | { next: 'claim'; account: SeaAccountInfo; island: SeaClaimIslandInfo }

/** 界面语言(2026-10-30 双语):zh=简体中文(默认)/en=English;机器级偏好,登录屏阶段即可用 */
export type UiLanguage = 'zh' | 'en'

/** 多选消息导出 Markdown(2026-11-02):单聊/群聊二选一;主进程查库归一化拼装,渲染层只传 id 列表 */
export interface ChatExportInput {
  botId?: string
  groupId?: string
  /** 任务会话(2026-11-06「新建任务」):三选一,threadId 优先 */
  threadId?: string
  messageIds: number[]
  /** save=弹保存对话框写文件 / copy=返回拼好的 markdown(渲染层写剪贴板) */
  mode: 'save' | 'copy'
}

export interface ChatExportResult {
  /** save 模式:是否已写入文件(取消对话框为 false;copy 恒 false) */
  saved: boolean
  /** save 成功时的文件路径(供「在 Finder 中显示」) */
  path?: string
  /** copy 模式:拼好的 markdown 全文 */
  markdown?: string
}

/** 渲染端可调用的 API 形状(preload 注入 window.archipelago) */
export interface RendererApi {
  /** 宿主平台(darwin/win32/…):渲染层平台分支(窗口三键避让/快捷键提示)统一走它 */
  platform: string
  boot(): Promise<BootState>
  wizardComplete(input: WizardInput): Promise<WizardResult>
  /** 向导预取(首岛判定+注册赠送额);失败返回 null,完成页不展示赠送卡片 */
  wizardGrantInfo(): Promise<WizardGrantInfo | null>
  providerTest(input: TestConnectionInput): Promise<TestResult>
  botsList(): Promise<Bot[]>
  botsCreate(input: CreateBotInput): Promise<Bot>
  botsUpdate(id: string, patch: BotPatch): Promise<Bot>
  botsDelete(id: string): Promise<void>
  botCapabilities(id: string): Promise<BotCapability[]>
  /** 居民的定时任务清单(档案「任务」页签):进行中在前,留档在后 */
  botTasks(id: string): Promise<BotTask[]>
  /** 岛主在任务页签取消一件任务 */
  tasksCancel(taskId: string, botId: string): Promise<void>
  /** 已安装的技能卡(档案「技能」页签,最近学会在前) */
  botSkills(id: string): Promise<BotSkillEntry[]>
  /** 岛主在档案页签卸下某居民的技能(只删安装关系,技能卡留在岛上) */
  skillsUninstall(skillId: number, botId: string): Promise<void>
  /** 技能中心「岛上的技能」清单(全岛活卡,含来源/创建者/学会数) */
  skillsCenterList(): Promise<IslandSkillSummary[]>
  /** 技能中心详情(展开行):正文/版本历史/安装名单;不存在返回 null */
  skillsCenterDetail(id: number): Promise<IslandSkillDetail | null>
  /** 冻结/解冻一张岛上技能(岛级停用:全岛不注入、灰显;解冻即恢复) */
  skillsCenterFreeze(skillId: number, frozen: boolean): Promise<void>
  /** 删除一张岛上技能(软删+全岛卸下);精选推荐装来的复制卡删除只影响本岛 */
  skillsCenterDelete(skillId: number): Promise<void>
  /** 把一张岛上技能装给若干居民(技能中心「安装到…」);返回新装上的个数 */
  skillsCenterInstallTo(skillId: number, botIds: string[]): Promise<number>
  /** 从精选推荐把一张卡复制进本岛(安装即复制;已复制过则报错);返回复制后的岛上技能 id */
  skillsOfficialInstall(name: string): Promise<number>
  /** 精选推荐目录(24h 缓存+ETag,离线 seed 兜底;force=立即刷新) */
  skillsCatalog(force?: boolean): Promise<OfficialCatalogData>
  /** 岛上已装连接器清单(岛上技能 Tab 混排;2026-11-06 MCP 接入) */
  mcpList(): Promise<IslandConnectorSummary[]>
  /** 连接器详情(浮窗):打码配置+运行状态+分配名单;不存在返回 null */
  mcpDetail(id: string): Promise<ConnectorDetail | null>
  /** 手动添加连接器(粘贴业界 mcpServers 同型 JSON);返回新加的名字列表 */
  mcpAdd(json: string): Promise<string[]>
  /** 连接器分配给若干居民(「安装到…」);返回新分配个数 */
  mcpInstallTo(id: string, botIds: string[]): Promise<number>
  /** 解除某居民对连接器的分配 */
  mcpUninstall(id: string, botId: string): Promise<void>
  /** 停用/恢复一个连接器(岛级:停用后工具即刻不再注入) */
  mcpSetDisabled(id: string, disabled: boolean): Promise<void>
  /** 删除连接器(软删+解除全部分配) */
  mcpDelete(id: string): Promise<void>
  /** 从精选推荐安装连接器卡(模板+岛主填的密钥值);返回连接器 id */
  mcpOfficialInstall(name: string, values: Record<string, string>): Promise<string>
  /** 连接器模板的占位符列表(安装浮窗生成 Key 输入框) */
  mcpTemplatePlaceholders(name: string): Promise<string[]>
  /** 居民经手文件清单(档案「文件」页签,审计推导,最近写入在前) */
  botFiles(id: string): Promise<BotFileEntry[]>
  /** 私信交流详情(点开单气泡后的浮窗);不存在或旧数据返回 null */
  exchangeDetail(exchangeId: string): Promise<ExchangeDetail | null>
  /** 在 Finder 中显示该文件 */
  revealInFolder(path: string): Promise<void>
  /** 用系统默认应用打开该文件;返回错误文案,空串 = 成功 */
  openPath(path: string): Promise<string>
  /** 内置 md 阅读器(2026-11-06 只读):读 .md 文本(≤256KB,非 md/超限/二进制诚实报错) */
  filesReadText(path: string): Promise<MdTextReadResult>
  /** 在独立阅读器窗口打开 .md(单例窗口,新文件替换内容) */
  mdReaderOpen(path: string): Promise<void>
  /** 居民正文内嵌图:本机路径 → 校验(存在/图片后缀/≤8MB)+ 缩放 → dataURL */
  imageRead(path: string): Promise<ImageReadResult>
  /** 内置图片查看器:本机路径 → 校验(存在/图片后缀/≤32MB)→ 原样字节 dataURL(不缩放) */
  imageReadFull(path: string): Promise<ImageFullReadResult>
  /** 在独立查看器窗口打开图片(单例窗口,新图替换内容) */
  imgViewerOpen(path: string): Promise<void>
  /** 在系统文件管理器中打开该居民的工作区目录(不存在先建);返回错误文案,空串 = 成功 */
  workspaceOpen(botId: string): Promise<string>
  /** 侧栏「已隐藏的对话」:被隐藏会话的居民 id 列表 */
  hiddenDmsGet(): Promise<string[]>
  hiddenDmsSet(ids: string[]): Promise<void>
  /** 回合过程默认折叠/展开(2026-11-08 设置项):true=居民工作时过程明细默认展开;默认 false=折叠 */
  turnProcessGet(): Promise<boolean>
  turnProcessSet(v: boolean): Promise<void>
  /** 侧栏统一消息列表:每个单聊/群聊的最后一条消息预览 */
  conversationsOverview(): Promise<ConversationPreview[]>
  groupsList(): Promise<GroupInfo[]>
  groupsCreate(input: CreateGroupInput): Promise<GroupInfo>
  groupsUpdate(id: string, input: UpdateGroupInput): Promise<GroupInfo>
  groupsDelete(id: string): Promise<void>
  groupHistory(groupId: string): Promise<GroupHistoryResult>
  groupSend(groupId: string, text: string, attachments?: MessageAttachment[], quotes?: ChatQuote[]): Promise<void>
  groupStop(groupId: string): Promise<void>
  memoryList(): Promise<MemoryState>
  memoryAdd(scope: string, text: string): Promise<MemoryState>
  memoryDelete(scope: string, line: number): Promise<MemoryState>
  /** 岛主档案(M6.11):画像 + 观察 + 历史,一包取回 */
  ownerProfile(): Promise<OwnerProfileState>
  /** 岛主手动添加一条画像(无观察出处) */
  ownerAddStatement(input: { section: OwnerSection; text: string }): Promise<OwnerProfileState>
  /** 编辑画像条目(文字/分节;改动即视为一次确认) */
  ownerUpdateStatement(id: string, patch: { text?: string; section?: OwnerSection }): Promise<OwnerProfileState>
  /** 删除画像条目(移入 history 留痕) */
  ownerDeleteStatement(id: string): Promise<OwnerProfileState>
  /** 把画像条目改派为某位居民的私人记忆(逃生舱:这事只让 TA 知道) */
  ownerAssignStatement(id: string, botId: string): Promise<OwnerProfileState>
  ownerDeleteObservation(id: string): Promise<OwnerProfileState>
  /** 让档案管家立即整理待处理的观察 */
  ownerCurate(): Promise<OwnerProfileState>
  /** 存量整理:从各居民旧记忆与集体记忆里抽取关于岛主的条目,落为观察后自动整理 */
  ownerExtract(): Promise<OwnerProfileState>
  chatHistory(botId: string): Promise<HistoryResult>
  chatSend(botId: string, text: string, attachments?: MessageAttachment[], quotes?: ChatQuote[]): Promise<void>
  chatStop(botId: string): Promise<void>
  /** 任务会话(2026-11-06「新建任务」):进行中的线程清单(含空线程,消息列表行数据源) */
  taskThreadsList(): Promise<TaskThreadInfo[]>
  /** 给居民开一个新任务会话;返回线程(标题空=界面显示「新任务」);workdir=创建时显式绑定的工作目录(可选) */
  taskThreadCreate(botId: string, workdir?: string): Promise<TaskThreadInfo>
  /** 任务会话历史(形状同单聊 chatHistory,含 turnActive/turnKind 真态) */
  taskThreadHistory(threadId: string): Promise<HistoryResult>
  /** 在任务会话里发消息(上下文/审批/事件都路由到该线程) */
  taskThreadSend(threadId: string, text: string, attachments?: MessageAttachment[], quotes?: ChatQuote[]): Promise<void>
  /** 停止任务会话里进行中的回合 */
  taskThreadStop(threadId: string): Promise<void>
  /** 手改任务标题(改过即视为已命名,自动起名永不覆盖);空串=回到「新任务」,下轮结束会再自动起名 */
  taskThreadRename(id: string, title: string): Promise<TaskThreadInfo>
  /** 更换/设定任务的工作目录绑定(头部 chip 入口):走绑定授权卡;ok=false 时 message 是人话原因 */
  taskThreadSetWorkdir(threadId: string, directory: string): Promise<{ ok: boolean; message: string; thread: TaskThreadInfo }>
  /** 结束任务:归档软删(记录保留),进行中回合先停;绑定工作树的线程等收尾握手完成后清理 */
  taskThreadClose(id: string): Promise<TaskThreadInfo>
  /** 多选消息导出 Markdown(2026-11-02):主进程查库拼装;save=保存对话框写文件,copy=返回 md 文本 */
  chatExport(input: ChatExportInput): Promise<ChatExportResult>
  settingsGet(): Promise<SettingsState>
  settingsSave(input: SettingsSaveInput): Promise<SettingsState>
  /** 界面语言(机器级文件存储,业务库挂载前也能读写);切换即时生效并广播 */
  uiLanguageGet(): Promise<UiLanguage>
  uiLanguageSet(lang: UiLanguage): Promise<UiLanguage>
  updateState(): Promise<UpdateState>
  updateCheck(): Promise<UpdateState>
  updateDownload(): Promise<UpdateState>
  updateCancel(): Promise<UpdateState>
  updateOpen(): Promise<boolean>
  /** 重启并安装(in-place 就绪态);非就绪态返回 false */
  updateInstall(): Promise<boolean>
  updateSkip(version: string): Promise<UpdateState>
  /** 窗口控制(2026-11-04 方案 C:Windows frameless 自绘三键;Mac 走系统红绿灯不用) */
  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<void>
  windowClose(): Promise<void>
  windowIsMaximized(): Promise<boolean>
  updateSetPrefs(patch: UpdatePrefsPatch): Promise<UpdateState>
  updateMarkSeen(): Promise<UpdateState>
  /** 审批卡:allow=允许这一次 / deny=拒绝 / turn=本回合内同类不再询问 / always=以后全自动(转档+本卡放行);返回是否生效(卡可能已被处理或中止) */
  approvalResolve(approvalId: string, decision: 'allow' | 'deny' | 'turn' | 'always'): Promise<boolean>
  /** 原生目录选择对话框(选工作区路径用);取消返回 null */
  pickDirectory(): Promise<string | null>
  /** 原生附件选择对话框(回形针;文件+文件夹混选多选),主进程 stat 分类+图片落岛目录,返回就绪的附件列表 */
  /** 回形针选择:mac 默认混选;Windows 不支持混选,渲染层按入口传 'file' | 'dir'(主进程枚举校验) */
  attachmentsPick(mode?: 'mixed' | 'file' | 'dir'): Promise<MessageAttachment[]>
  /** 粘贴/拖拽入口的统一分流(主进程 stat 分类:目录/文件/图片,图片缩放后落岛目录);项=带真实路径的文件或无路径图片的数据 URL */
  attachmentsIntake(items: AttachmentIntakeItem[]): Promise<MessageAttachment[]>
  /** 渲染层 File 对象取真实绝对路径(Electron webUtils;拿不到返回 null——截图等无路径 blob 需走 dataUrl) */
  filePathOf(file: File): string | null
  /** 危险命令模式清单(§6.7) */
  safetyGet(): Promise<SafetyState>
  safetySetCustom(patterns: string[]): Promise<SafetyState>
  /** 群岛账号:本机登录态(只读本地,不联网) */
  /** 积分快照(群岛通道;主进程 30s 缓存) */
  creditsGet(force?: boolean): Promise<CreditsSnapshot>
  creditsRedeem(code: string): Promise<RedeemResult>
  authState(): Promise<SeaSessionState | null>
  /** 联网刷新登录态(服务端会话失效时自动清除本机登录) */
  authRefresh(): Promise<SeaSessionState | null>
  authRequestCode(email: string): Promise<SeaCodeResult>
  /** 验证登录;去向由主进程决定(enter/wizard/claim),渲染端据此流转 */
  authVerify(email: string, code: string): Promise<SeaLoginNext>
  /** 确认认领本机存量岛(仅 claim 去向后可用) */
  authClaimConfirm(): Promise<SeaLoginNext>
  /** 拒绝认领:存量岛留给以后的账号,当前账号直接走建岛向导(仅 claim 去向后可用) */
  authClaimDecline(): Promise<SeaLoginNext>
  authLogout(): Promise<void>
  // ---- 邮局(岛际信件通信,2026-10-29) ----
  /** 邮局全量快照:信件流(收发混排正序)+ 通讯录 + 未读数;islandUid 为空 = 岛未绑定,邮局不可用 */
  postOverview(): Promise<PostOverview>
  /** 岛主寄信(附件走原始路径原样字节;居民代寄不走 IPC,工具层在主进程直调) */
  postSendLetter(input: PostSendInput): Promise<PostLetter>
  /** 处理好友申请卡:同意/婉拒(婉拒不通知对方) */
  postFriendRespond(fromIsland: string, accept: boolean): Promise<void>
  /** 凭邀请函(链接或 token)寄好友申请,note=一句自我介绍 */
  postFriendRequest(token: string, note: string): Promise<void>
  postBlock(islandUid: string, fromLetterId?: string): Promise<void>
  /** 删除通道:双方通信关系断开,历史信件与已有拉黑保留,可凭新邀请重建 */
  postDeleteContact(islandUid: string, fromLetterId?: string): Promise<void>
  /** 删除这一封信(只删本地行;更多菜单里的低频操作) */
  postDeleteLetter(letterId: string): Promise<void>
  /** 生成我的邀请函(无状态签名令牌,每次生成新函,7 天有效) */
  postInviteCreate(): Promise<PostInviteInfo>
  postSaveInviteQr(dataUrl: string): Promise<{ saved: boolean }>
  /** 复制邀请函分享图到剪贴板(微信里直接粘贴) */
  postCopyInviteImage(dataUrl: string): Promise<{ copied: boolean }>
  /** 解析邀请凭证(六位码/短链/旧链接/旧 token);失败抛人话错误 */
  postInviteParse(text: string): Promise<PostInviteParsed>
  /** 标记一封来信已读(触发已读回执) */
  postMarkRead(letterId: string): Promise<void>
  /** 批量标记已读(#27):一个事务一次广播,云端回执逐封异步发 */
  postMarkReadMany(letterIds: string[]): Promise<void>
  /** 进邮局页补拉(#28):≥30s 节流;等拉取落库后返回,渲染层用以区分「正在收取」与「确实没有」 */
  postPull(): Promise<void>
  /** 寄信附件选择器(仅文件多选;文件夹不能寄) */
  postAttachmentsPick(): Promise<MessageAttachment[]>
  /** 寄信附件 intake(原样字节复制进邮局暂存,图片不缩放——与聊天 intake 分道) */
  postAttachmentsIntake(items: AttachmentIntakeItem[]): Promise<MessageAttachment[]>
  on(channel: string, listener: (data: unknown) => void): () => void
}

// ---------- 邮局(岛际信件通信,2026-10-29;doc/需求 - 邮局 - 2026-10-29.md) ----------

export interface PostAttachmentMeta {
  /** Display-only thumbnail; postal original bytes remain unchanged. */
  thumb?: string
  id: string
  filename: string
  size: number
  mime: string | null
  /** 收件下载后/发件暂存后的本机路径;null=尚未落盘 */
  localPath: string | null
}

export type PostLetterKind = 'letter' | 'friend_request' | 'friend_accept' | 'deliver_receipt' | 'read_receipt'

/** in: received→read;out: sending→sent→delivered→read,失败 failed */
export type PostLetterStatus = 'received' | 'read' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

export interface PostLetter {
  peerArtworkId?: string | null
  id: string
  /** 云端行号:收件幂等去重键 + 回执指向;发件在云端确认后回填 */
  remoteId: number | null
  direction: 'in' | 'out'
  peerIsland: string
  /** 展示署名「岛主名 · 岛名」/「居民名 · 岛名」,取最近一次 */
  peerName: string
  kind: PostLetterKind
  refRemoteId: number | null
  subject: string | null
  body: string | null
  senderKind: 'owner' | 'resident' | 'system' | 'officer'
  attachments: PostAttachmentMeta[]
  status: PostLetterStatus
  error: string | null
  createdAt: number
  readAt: number | null
  /** 申请卡/通道操作的结果章(2026-10-30 评审:操作落卡不消失):accepted/declined/blocked/channel_deleted */
  outcome?: 'accepted' | 'declined' | 'blocked' | 'channel_deleted' | null
}

export interface PostContact {
  artworkId?: string | null
  islandUid: string
  islandName: string
  ownerName: string
  since: number
}

export interface PostInviteInfo {
  artworkId?: string | null
  ownerName?: string
  islandUid?: string
  /** 六位邀请码(2026-11-03 重做:码为权威凭证,link=qundao.app/i/<code>) */
  code: string
  link: string
  expiresAt: number
  islandName: string
}

export interface PostInviteParsed {
  artworkId?: string | null
  islandUid: string
  islandName: string
  ownerName: string
}

export interface PostOverview {
  artworkId?: string | null
  letters: PostLetter[]
  contacts: PostContact[]
  /** 未读来信数(申请卡与正文信计数;系统行不计) */
  unread: number
  /** 当前岛 uid;null=未登录/未绑定,界面显示引导 */
  islandUid: string | null
}

export interface PostSendInput {
  toIsland: string
  subject?: string
  body: string
  /** 附件原始路径(寄信语义=原样字节,主进程复制进暂存再上传,不做图片缩放) */
  attachments: { path: string }[]
}
