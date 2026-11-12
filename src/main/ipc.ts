import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { statSync } from 'node:fs'
import type {
  AttachmentIntakeItem, BootState, BotCapability, BotFileEntry, BotPatch, BotSkillEntry, BotTask, ChatExportInput, ChatQuote, ConnectorDetail, ConversationPreview, CreateBotInput, IslandConnectorSummary, IslandSkillDetail, IslandSkillSummary, ImageFullReadResult, ImageReadResult, MdTextReadResult, OfficialCatalogData, CreateGroupInput, CreditsSnapshot, ExchangeDetail, MessageAttachment, OwnerProfileState, OwnerSection, PostInviteInfo, TaskThreadInfo, PostInviteParsed, PostLetter, PostOverview, PostSendInput, RedeemResult, SeaLoginNext, SeaSessionState, SettingsSaveInput, SettingsState, TestConnectionInput, TestResult, UiLanguage, UpdateGroupInput, UpdatePrefsPatch, WizardGrantInfo, WizardInput, WizardResult
} from '@shared/types'
import { EV, IPC } from '@shared/ipc-channels'
import { getProvider } from '@shared/providers'
import { chatOnce, withTimeout } from './llm'
import { createBot, ensureMainBot, getBot, listBots, softDeleteBot, updateBot } from './bots'
import {
  beginTaskThreadClose,
  endTaskThreadClose,
  getHistory,
  getTaskThreadHistory,
  sendMessage,
  sendTaskThreadMessage,
  stopAndAwaitTaskThread,
  stopStream,
  stopTaskThread
} from './chat'
import { intakeAttachments, pickAttachments, readImageForDisplay, readImageFullForViewer } from './attachments'
import { getExchangeDetail } from './sessions'
import { createGroup, groupHistory, groupSend, listGroups, softDeleteGroup, stopGroup, updateGroup } from './groups'
import { addMemory, deleteMemory, listMemory, curateOwnerProfile, extractOwnerMemories, getOwnerProfile, ownerAddStatement, ownerAssignStatement, ownerDeleteObservation, ownerDeleteStatement, ownerUpdateStatement } from './memory'
import { getOrCreateSession, getOrCreateTaskSession, insertMessage } from './sessions'
import { cannedWelcome } from './prompts'
import { resolveApproval } from './approval'
import { safetyGet, safetySetCustom } from './shell'
import { chatExport } from './export'
import { listBotFiles } from './fs-tools'
import { ensureWorkspaceDir } from './workspace'
import { expandHomePath, isMdReaderSender, openMdReader, readTextForMdReader } from './md-reader'
import { isImgViewerSender, openImgViewer } from './img-viewer'
import { botCapabilities } from './tools'
import { botTaskEntries, cancelTaskByOwner } from './tasks'
import { closeTaskThread, createTaskThread, getTaskThread, listTaskThreads, renameTaskThread } from './task-threads'
import { bindTaskWorkdir, releaseTaskWorkdir } from './task-workdir'
import {
  botSkillEntries,
  deleteIslandSkill,
  getSkill,
  installOfficialCopy,
  installSkill,
  installSkillWithAssets,
  isInstalled,
  islandSkillDetail,
  islandSkillSummaries,
  removeMaterializedImportedAssets,
  setSkillFrozen,
  uninstallSkill
} from './skills'
import { fetchCatalog, officialResolve } from './official-catalog'
import {
  assignedBotIds,
  connectorDetail,
  deleteConnector,
  installConnectorFromCatalog,
  installConnectorTo,
  islandConnectorSummaries,
  mcpAddManual,
  officialTemplatePlaceholders,
  setConnectorDisabled,
  uninstallConnector,
  getConnector as getConnectorMcp
} from './mcp'
import {
  postBlock,
  postDeleteContact,
  postDeleteLetter,
  postFriendRequest,
  postCopyInviteImage,
  postSaveInviteQr,
  postFriendRespond,
  postIntakeAttachments,
  postInviteCreate,
  postInviteParse,
  postMarkRead,
  postMarkReadMany,
  postOnAuthChanged,
  postOverview,
  postPickAttachments,
  postPullNow,
  sendLetter
} from './post'
import { audit } from './audit'
import { getHiddenDms, getTurnProcessExpanded, setHiddenDms, listConversationPreviews, setTurnProcessExpanded } from './ui-state'
import { getApiKey, setApiKey } from './secrets'
import { getUiLanguage, setUiLanguage } from './ui-language'
import { confirmClaim, creditsSnapshot, currentSeaToken, declineClaim, getAuthState, invalidateCreditsCache, logout as seaLogout, rebindIsland, redeemCredits, refreshAuthState, requestCode, resolveBoot, verifyLogin, wizardGrantInfo } from './auth'
import {
  getModelConfig,
  getSpace,
  initSpace,
  isWizardDone,
  markWizardDone,
  setModelConfig,
  updateSpace
} from './space'
import {
  cancelUpdateDownload,
  checkForUpdates,
  getUpdateState,
  installUpdate,
  markUpdateSeen,
  openUpdateInstaller,
  setUpdatePrefs,
  skipUpdateVersion,
  startUpdateDownload
} from './updater'

function broadcast(channel: string, data?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, data)
}

function validScope(scope: string): boolean {
  return scope === 'shared' || listBots().some((b) => b.id === scope)
}

export function registerIpc(): void {
  // 窗口控制(2026-11-04 方案 C:Windows frameless 自绘三键)。Mac 不走这些通道(系统红绿灯);
  // 用 fromWebContents 取派发窗口而非全局引用,多窗口/重建窗口下天然正确
  ipcMain.handle(IPC.WindowMinimize, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  ipcMain.handle(IPC.WindowToggleMaximize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(IPC.WindowClose, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  ipcMain.handle(IPC.WindowIsMaximized, (e): boolean => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  })

  ipcMain.handle(IPC.Boot, (): BootState => {
    // 登录门(0.8):凭本地令牌解锁则挂载账号目录返回 app 态;否则 login 态,业务库不可用
    const gate = resolveBoot()
    if (gate === 'login') {
      return { gate: 'login', wizardDone: false, space: null, hasApiKey: false }
    }
    const config = getModelConfig()
    // 官方目录:启动(含登录后 reload)静默强刷一次——后台新上架的卡用户重启即见;
    // 没更新就是一次 304,几乎免费(打开技能中心视图另有 6h 阈值,见 official-catalog.ts)
    void fetchCatalog(true)
    return {
      gate: 'app',
      wizardDone: isWizardDone(),
      space: getSpace(),
      hasApiKey: config?.providerId === 'archipelago' ? !!currentSeaToken() : !!config && !!getApiKey(config.providerId)
    }
  })

  ipcMain.handle(IPC.ProviderTest, async (_e, input: TestConnectionInput): Promise<TestResult> => {
    return testConnection(input)
  })

  // M2.2 开场收尾(0.9:不再配置模型,群岛通道开箱即用)→ 建岛 → 主 Bot 入住并打招呼
  // 0.9.2 自走查(A2):开场白写死(cannedWelcome),不再现场调大模型——按钮关键路径零网络等待
  ipcMain.handle(IPC.WizardComplete, async (_e, input: WizardInput): Promise<WizardResult> => {
    if (!getSpace()) initSpace(input.islandName, input.ownerName)
    else updateSpace({ name: input.islandName, ownerName: input.ownerName })
    setModelConfig({ providerId: 'archipelago', modelId: 'deepseek-flash' })
    markWizardDone()

    const bot = ensureMainBot()
    const space = getSpace()
    const session = getOrCreateSession(bot.id)
    const welcome = cannedWelcome(space)
    const message = insertMessage(session.id, 'assistant', welcome)
    // 新账号首次建岛:向海域服务登记这座岛(幂等,失败下次登录补齐)
    void rebindIsland()
    return {
      boot: {
        gate: 'app',
        wizardDone: true,
        space,
        hasApiKey: !!currentSeaToken()
      },
      bot,
      welcome: message
    }
  })

  // 0.9.2 自走查(A4):向导预取——首岛判定+注册赠送额,用户写岛名时就把两件事异步办完
  ipcMain.handle(IPC.WizardGrantInfo, async (): Promise<WizardGrantInfo | null> => {
    try {
      return await wizardGrantInfo()
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.BotsList, () => listBots())

  ipcMain.handle(IPC.BotsCreate, (_e, input: CreateBotInput) => createBot(input))

  ipcMain.handle(IPC.BotsUpdate, (_e, { id, patch }: { id: string; patch: BotPatch }) => updateBot(id, patch))

  ipcMain.handle(IPC.BotsDelete, (_e, id: string) => {
    softDeleteBot(id)
  })

  ipcMain.handle(IPC.BotsCapabilities, (_e, id: string): BotCapability[] => {
    const bot = getBot(id)
    return bot ? botCapabilities(bot) : []
  })

  // 档案「技能」页签:TA 已学会的技能卡(第一期:只读 + 卸下;技能中心第二期再开管理台)
  ipcMain.handle(IPC.BotSkillsList, (_e, id: string): BotSkillEntry[] => botSkillEntries(id))

  // 档案「任务」页签(2026-10-29 定时任务):进行中在前、留档在后;取消是岛主侧唯一操作
  ipcMain.handle(IPC.BotTasksList, (_e, id: string): BotTask[] => {
    const bot = getBot(id)
    return bot ? botTaskEntries(id) : []
  })

  ipcMain.handle(IPC.TasksCancel, (_e, { taskId, botId }: { taskId: string; botId: string }) => {
    cancelTaskByOwner(taskId, botId)
  })

  ipcMain.handle(IPC.SkillsUninstall, (_e, { skillId, botId }: { skillId: number; botId: string }) => {
    const skill = getSkill(skillId)
    uninstallSkill(skillId, botId)
    // 导入卡把工作区随卡副本一并清掉(与居民 uninstall_skill 同口径)
    if (skill?.origin === 'imported') {
      const bot = getBot(botId)
      if (bot?.workspacePath) removeMaterializedImportedAssets(skillId, skill.name, bot.workspacePath)
    }
    audit(botId, 'uninstall_skill', { skill: skill?.name ?? skillId, by: 'owner' })
    broadcast(EV.SkillsChanged)
  })

  // ── 技能中心(2026-11-05 二期):岛上清单/详情/冻结/删除/安装到/官方目录 ──
  ipcMain.handle(IPC.SkillsCenterList, (): IslandSkillSummary[] => islandSkillSummaries())

  ipcMain.handle(IPC.SkillsCenterDetail, (_e, id: number): IslandSkillDetail | null => islandSkillDetail(id))

  ipcMain.handle(IPC.SkillsCenterFreeze, (_e, { skillId, frozen }: { skillId: number; frozen: boolean }) => {
    const skill = getSkill(skillId)
    setSkillFrozen(skillId, frozen)
    audit('', frozen ? 'skill_freeze' : 'skill_unfreeze', { skill: skill?.name ?? skillId })
    broadcast(EV.SkillsChanged)
  })

  ipcMain.handle(IPC.SkillsCenterDelete, (_e, skillId: number) => {
    const skill = getSkill(skillId)
    deleteIslandSkill(skillId)
    audit('', 'skill_delete', { skill: skill?.name ?? skillId, origin: skill?.origin })
    broadcast(EV.SkillsChanged)
  })

  ipcMain.handle(IPC.SkillsCenterInstallTo, (_e, { skillId, botIds }: { skillId: number; botIds: string[] }): number => {
    const skill = getSkill(skillId)
    if (!skill || skill.status === 'deleted') throw new Error('这张技能卡已经不在岛上了,刷新一下再看。')
    if (skill.status === 'frozen') throw new Error('这张卡已被冻结,先解冻再安装。')
    let n = 0
    for (const botId of botIds) {
      // 幂等:已学会的跳过,计数只算新装;导入卡走统一安装收口(先落随卡文件再写安装关系)
      const fresh = !isInstalled(skillId, botId)
      if (fresh) installSkillWithAssets(skillId, botId, 'user')
      else installSkill(skillId, botId, 'user')
      if (fresh) n++
      audit(botId, 'install_skill', { skill: skill.name, by: 'owner' })
    }
    broadcast(EV.SkillsChanged)
    return n
  })

  // 精选推荐「安装即复制」:按名解析目录(缓存/seed),复制进岛;不自动装给居民
  ipcMain.handle(IPC.SkillsOfficialInstall, (_e, name: string): number => {
    const card = officialResolve(name)
    if (!card) throw new Error(`精选推荐里没有叫「${name}」的技能。`)
    // 连接器卡(2026-11-06)不走技能复制:走 McpOfficialInstall(带 Key 填写)
    if (card.transport) throw new Error('这张卡是服务能力,请用卡片上的「安装」按钮安装(需要填一次 Key)。')
    const id = installOfficialCopy(card)
    audit('', 'skill_official_install', { skill: card.name, section: card.section })
    broadcast(EV.SkillsChanged)
    return id
  })

  // ── MCP 连接器(2026-11-06):岛上清单/详情/手动添加/分配/停用/删除/目录安装 ──
  // 用户侧呈现与技能卡零差异(精选推荐/岛上技能混排);内部命名直白用 mcp/connector
  ipcMain.handle(IPC.McpList, (): IslandConnectorSummary[] => islandConnectorSummaries())

  ipcMain.handle(IPC.McpDetail, (_e, id: string): ConnectorDetail | null => connectorDetail(id))

  ipcMain.handle(IPC.McpAdd, (_e, json: string): string[] => {
    const names = mcpAddManual(json)
    broadcast(EV.ConnectorsChanged)
    return names
  })

  ipcMain.handle(IPC.McpInstallTo, (_e, { id, botIds }: { id: string; botIds: string[] }): number => {
    const conn = getConnectorMcp(id)
    if (!conn || conn.status === 'deleted') throw new Error('这个服务已经不在岛上了,刷新一下再看。')
    if (conn.status === 'disabled') throw new Error('这个服务已被停用,先恢复再安装。')
    const assigned = new Set(assignedBotIds(id))
    let n = 0
    for (const botId of botIds) {
      if (!assigned.has(botId)) n++
      installConnectorTo(id, botId)
      audit(botId, 'mcp_install', { connector: conn.name, by: 'owner' })
    }
    broadcast(EV.ConnectorsChanged)
    return n
  })

  ipcMain.handle(IPC.McpUninstall, (_e, { id, botId }: { id: string; botId: string }) => {
    const conn = getConnectorMcp(id)
    uninstallConnector(id, botId)
    audit(botId, 'mcp_uninstall', { connector: conn?.name ?? id, by: 'owner' })
    broadcast(EV.ConnectorsChanged)
  })

  ipcMain.handle(IPC.McpSetDisabled, (_e, { id, disabled }: { id: string; disabled: boolean }) => {
    const conn = getConnectorMcp(id)
    setConnectorDisabled(id, disabled)
    audit('', disabled ? 'mcp_disable' : 'mcp_enable', { connector: conn?.name ?? id })
    broadcast(EV.ConnectorsChanged)
  })

  ipcMain.handle(IPC.McpDelete, (_e, id: string) => {
    const conn = getConnectorMcp(id)
    deleteConnector(id)
    audit('', 'mcp_delete', { connector: conn?.name ?? id, origin: conn?.origin })
    broadcast(EV.ConnectorsChanged)
  })

  ipcMain.handle(IPC.McpTemplatePlaceholders, (_e, name: string): string[] => officialTemplatePlaceholders(name))

  ipcMain.handle(IPC.McpOfficialInstall, (_e, { name, values }: { name: string; values: Record<string, string> }): string => {
    const card = officialResolve(name)
    if (!card) throw new Error(`精选推荐里没有叫「${name}」的服务能力。`)
    if (!card.transport || !card.configTemplate) throw new Error(`「${name}」不是服务能力卡,请用技能方式安装。`)
    const id = installConnectorFromCatalog(
      { name: card.name, description: card.description, transport: card.transport, configTemplate: card.configTemplate },
      values
    )
    broadcast(EV.ConnectorsChanged)
    return id
  })

  // 官方目录:24h 缓存 + ETag 协商,离线 seed 兜底;force=立即刷新
  ipcMain.handle(IPC.SkillsCatalog, (_e, force?: boolean): Promise<OfficialCatalogData> => fetchCatalog(!!force))

  // 档案「文件」页签:该居民经手写过的文件(audit 推导),以及定位/打开的系统能力
  ipcMain.handle(IPC.BotFilesList, (_e, id: string): BotFileEntry[] => {
    const bot = getBot(id)
    return bot ? listBotFiles(bot) : []
  })

  // 档案卡「打开工作区」:先兜底建目录(可能被岛主删过),再用系统文件管理器打开
  ipcMain.handle(IPC.WorkspaceOpen, (_e, id: string): Promise<string> => {
    const bot = getBot(id)
    if (!bot) return Promise.resolve('居民不存在')
    ensureWorkspaceDir(bot.workspacePath)
    return shell.openPath(bot.workspacePath)
  })

  ipcMain.handle(IPC.FilesReveal, (_e, p: string) => {
    // ~/ 展开:正文 autolink/选区打开会带来 ~ 形态,shell.showItemInFolder 不认(fs-tools resolveBotPath 同款口径)
    if (typeof p === 'string' && p) shell.showItemInFolder(expandHomePath(p))
  })

  ipcMain.handle(IPC.FilesOpen, (_e, rawP: string): Promise<string> => {
    if (typeof rawP !== 'string' || !rawP) return Promise.resolve('路径为空')
    const p = expandHomePath(rawP)
    // shell.openPath 对不存在的路径在 macOS 上常返回空串(表现为点击毫无反应),先自查存在性;
    // ENOENT=真没了,其余 errno(EACCES/EPERM 等)=macOS 隐私墙拦住了主进程,文件多半还在
    try {
      statSync(p)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return Promise.resolve('文件已不存在(可能已被移动或删除)')
      return Promise.resolve(`群岛无法访问这个文件(${code ?? '未知错误'}):文件可能还在原位,请在 系统设置 → 隐私与安全性 里允许群岛访问对应文件夹。`)
    }
    return shell.openPath(p)
  })

  // 居民正文内嵌图(2026-11-05):本机路径 → 校验+缩放 → dataURL;失败回 reason 码,文案渲染层走词典
  ipcMain.handle(IPC.ImageRead, (_e, p: string): ImageReadResult => readImageForDisplay(p))

  // ── 内置 md 阅读器(2026-11-06 只读拍板):入口分流在渲染层(.md → 阅读器),此处开窗与读文本 ──
  ipcMain.handle(IPC.MdReaderOpen, (_e, p: string) => {
    if (typeof p === 'string' && p) openMdReader(p)
  })

  // 读文本收口到阅读器窗口(渲染层读文件面不新增:主窗口渲染层拿不到这条通道的内容)
  ipcMain.handle(IPC.FilesReadText, (e, p: string): Promise<MdTextReadResult> => {
    if (!isMdReaderSender(e.sender)) {
      return Promise.resolve({ ok: false, reason: 'bad-path' })
    }
    return readTextForMdReader(p)
  })

  // ── 内置图片查看器(2026-11-06 拍板):入口分流在渲染层(图片 → 查看器),此处开窗与读原图 ──
  ipcMain.handle(IPC.ImgViewerOpen, (_e, p: string) => {
    if (typeof p === 'string' && p) openImgViewer(p)
  })

  // 读原图同样收口到查看器窗口(不缩放的全分辨率读取只给查看器,主窗口渲染层拿不到)
  ipcMain.handle(IPC.ImageReadFull, (e, p: string): ImageFullReadResult => {
    if (!isImgViewerSender(e.sender)) {
      return { ok: false, reason: 'bad-path' }
    }
    return readImageFullForViewer(p)
  })

  // 侧栏「已隐藏的对话」(UI 偏好,存 meta KV)
  ipcMain.handle(IPC.HiddenDmsGet, (): string[] => getHiddenDms())
  ipcMain.handle(IPC.HiddenDmsSet, (_e, ids: string[]) => setHiddenDms(ids))

  // 回合过程默认折叠/展开(UI 偏好,存 meta KV)
  ipcMain.handle(IPC.TurnProcessGet, (): boolean => getTurnProcessExpanded())
  ipcMain.handle(IPC.TurnProcessSet, (_e, v: boolean) => setTurnProcessExpanded(v))

  // 侧栏统一消息列表:单聊/群聊的最后一条消息预览
  ipcMain.handle(IPC.ConversationsOverview, (): ConversationPreview[] => listConversationPreviews())

  // ---- 群聊(M5) ----
  ipcMain.handle(IPC.GroupsList, () => listGroups())

  ipcMain.handle(IPC.GroupsCreate, (_e, input: CreateGroupInput) => {
    const group = createGroup(input)
    broadcast(EV.GroupsChanged)
    return group
  })

  ipcMain.handle(IPC.GroupsUpdate, (_e, { id, input }: { id: string; input: UpdateGroupInput }) => {
    const group = updateGroup(id, input)
    broadcast(EV.GroupsChanged)
    return group
  })

  ipcMain.handle(IPC.GroupsDelete, (_e, id: string) => {
    softDeleteGroup(id)
    broadcast(EV.GroupsChanged)
  })

  ipcMain.handle(IPC.GroupHistory, (_e, groupId: string) => groupHistory(groupId))

  ipcMain.handle(
    IPC.GroupSend,
    (
      e,
      { groupId, text, attachments, quotes }: { groupId: string; text: string; attachments?: MessageAttachment[]; quotes?: ChatQuote[] }
    ) => {
      groupSend(groupId, text, e.sender, attachments, quotes)
    }
  )

  ipcMain.handle(IPC.GroupStop, (_e, groupId: string) => {
    stopGroup(groupId)
  })

  // ---- 记忆(M6) ----
  ipcMain.handle(IPC.MemoryList, () => listMemory())

  ipcMain.handle(IPC.MemoryAdd, (_e, { scope, text }: { scope: string; text: string }) => {
    if (!validScope(scope)) throw new Error('无效的记忆作用域')
    return addMemory(scope, text)
  })

  ipcMain.handle(IPC.MemoryDelete, (_e, { scope, line }: { scope: string; line: number }) => {
    if (!validScope(scope)) throw new Error('无效的记忆作用域')
    return deleteMemory(scope, line)
  })

  // ---- 岛主档案(M6.11–6.13) ----
  ipcMain.handle(IPC.OwnerProfile, (): OwnerProfileState => getOwnerProfile())

  ipcMain.handle(
    IPC.OwnerStatementAdd,
    (_e, { section, text }: { section: OwnerSection; text: string }) => ownerAddStatement(section, text)
  )

  ipcMain.handle(
    IPC.OwnerStatementUpdate,
    (_e, { id, patch }: { id: string; patch: { text?: string; section?: OwnerSection } }) =>
      ownerUpdateStatement(id, patch)
  )

  ipcMain.handle(IPC.OwnerStatementDelete, (_e, id: string) => ownerDeleteStatement(id))

  ipcMain.handle(IPC.OwnerStatementAssign, (_e, { id, botId }: { id: string; botId: string }) =>
    ownerAssignStatement(id, botId)
  )

  ipcMain.handle(IPC.OwnerObservationDelete, (_e, id: string) => ownerDeleteObservation(id))

  ipcMain.handle(IPC.OwnerCurate, () => curateOwnerProfile())

  ipcMain.handle(IPC.OwnerExtract, () => extractOwnerMemories())

  ipcMain.handle(IPC.ChatHistory, (_e, botId: string) => getHistory(botId))

  ipcMain.handle(
    IPC.ChatSend,
    (
      e,
      { botId, text, attachments, quotes }: { botId: string; text: string; attachments?: MessageAttachment[]; quotes?: ChatQuote[] }
    ) => sendMessage(botId, text, e.sender, attachments, quotes)
  )

  ipcMain.handle(IPC.ChatStop, (_e, botId: string) => {
    stopStream(botId)
  })

  // ---- 任务会话(2026-11-06「新建任务」;2026-11-10 第一批起支持工作目录绑定) ----
  ipcMain.handle(IPC.TaskThreadsList, (): TaskThreadInfo[] => listTaskThreads())

  // workdir=创建时显式绑定(可选):线程即刻建好返回,绑定授权卡落新线程会话由岛主决策;
  // 卡等待期 ensureWorkdirReady 挡住新回合(M8),失败/被拒不静默——线程里落一条可见回执说明原因
  ipcMain.handle(IPC.TaskThreadCreate, (_e, botId: string, workdir?: string): TaskThreadInfo => {
    const thread = createTaskThread(botId)
    if (workdir && workdir.trim()) {
      const bot = getBot(botId)
      if (bot) {
        void bindTaskWorkdir(bot, thread.id, workdir, { forceDirect: false })
          .then((outcome) => {
            if (!outcome.ok) {
              const session = getOrCreateTaskSession(botId, thread.id)
              insertMessage(
                session.id,
                'assistant',
                '',
                `工作目录绑定没有通过:${outcome.message}需要的话,点任务头部的工作目录标签重新绑定。`,
                false,
                'note'
              )
            }
          })
          .catch((err) => console.error('[ipc] 创建时绑定工作目录失败:', err))
      }
    }
    return thread
  })

  ipcMain.handle(IPC.TaskThreadHistory, (_e, threadId: string) => getTaskThreadHistory(threadId))

  ipcMain.handle(
    IPC.TaskThreadSend,
    (
      e,
      { threadId, text, attachments, quotes }: { threadId: string; text: string; attachments?: MessageAttachment[]; quotes?: ChatQuote[] }
    ) => sendTaskThreadMessage(threadId, text, e.sender, attachments, quotes)
  )

  ipcMain.handle(IPC.TaskThreadStop, (_e, threadId: string) => {
    stopTaskThread(threadId)
  })

  ipcMain.handle(IPC.TaskThreadRename, (_e, { id, title }: { id: string; title: string }): TaskThreadInfo =>
    renameTaskThread(id, title)
  )

  // 更换/设定工作目录(头部 chip 入口):绑定授权卡落该线程会话;结果(含拒绝的人话)回渲染端
  ipcMain.handle(
    IPC.TaskThreadSetWorkdir,
    async (_e, { threadId, directory }: { threadId: string; directory: string }): Promise<{ ok: boolean; message: string; thread: TaskThreadInfo }> => {
      const thread = getTaskThread(threadId)
      if (!thread) throw new Error('任务不存在')
      const bot = getBot(thread.botId)
      if (!bot) throw new Error('居民不存在')
      const outcome = await bindTaskWorkdir(bot, threadId, directory, { forceDirect: false })
      const fresh = getTaskThread(threadId) ?? thread
      return { ok: outcome.ok, message: outcome.message, thread: fresh }
    }
  )

  // 结束任务(2026-11-10 起可等待握手;codex 评审 M4/M5 修订):closing 标记覆盖
  // 停止→清理→归档全程(期间的唤醒回合在 runTurn 入口被拒)→ abort → 等回合连同 finalize
  // 收完(超时不假装成功:如实报「仍在收尾」,线程保持 open 可重试)→ 工作树收尾(残留先
  // 快照校验;脏/error/跑偏现场默认保留)→ 归档 → 解除 closing
  ipcMain.handle(IPC.TaskThreadClose, async (_e, id: string): Promise<TaskThreadInfo> => {
    const thread = getTaskThread(id)
    if (!thread) throw new Error('任务不存在')
    beginTaskThreadClose(id)
    try {
      const stopped = await stopAndAwaitTaskThread(id)
      if (!stopped) {
        throw new Error('任务仍在收尾(长命令或工作树操作还没结束),请稍后再试')
      }
      if (thread.workdirPath) {
        await releaseTaskWorkdir(thread.botId, id).catch((err) => console.error('[ipc] 工作树收尾失败(现场保留):', err))
      }
      closeTaskThread(id)
      return getTaskThread(id) ?? thread
    } finally {
      endTaskThreadClose(id)
    }
  })

  // 多选消息导出 Markdown(2026-11-02):主进程查库拼装;save 弹保存对话框写文件,copy 返回 md 文本
  ipcMain.handle(IPC.ChatExport, (_e, input: ChatExportInput) => chatExport(input))

  // 私信交流详情(点开单气泡后的浮窗)
  ipcMain.handle(IPC.ExchangeDetail, (_e, exchangeId: string): ExchangeDetail | null => {
    return typeof exchangeId === 'string' && exchangeId ? getExchangeDetail(exchangeId) : null
  })

  // ---- 审批与本机能力安全设置(M4;2026-10-27 增第四档 always=以后全自动) ----
  ipcMain.handle(
    IPC.ApprovalResolve,
    (
      _e,
      { approvalId, decision }: { approvalId: string; decision: 'allow' | 'deny' | 'turn' | 'always' }
    ) => resolveApproval(approvalId, decision)
  )

  ipcMain.handle(IPC.PickDirectory, async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!
  })

  // ---- 附件(2026-10-29 输入框升级):回形针对话框 + 粘贴/拖拽统一分流,都在主进程 stat 分类、图片缩放落盘 ----
  // 2026-11-04 W4:Windows 混选失效,选择模式由渲染层传参,主进程枚举校验(非法回落 mixed,不透传 options)
  ipcMain.handle(IPC.AttachmentsPick, async (_e, mode: unknown): Promise<MessageAttachment[]> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const m = mode === 'file' || mode === 'dir' ? mode : 'mixed'
    return pickAttachments(win ?? null, m)
  })

  ipcMain.handle(IPC.AttachmentsIntake, (_e, items: AttachmentIntakeItem[]): MessageAttachment[] => {
    return Array.isArray(items) ? intakeAttachments(items) : []
  })

  ipcMain.handle(IPC.SafetyGet, () => safetyGet())

  ipcMain.handle(IPC.SafetySet, (_e, patterns: string[]) => safetySetCustom(patterns))

  // ---- 升级 ----
  ipcMain.handle(IPC.UpdateState, () => getUpdateState())

  ipcMain.handle(IPC.UpdateCheck, () => checkForUpdates())

  ipcMain.handle(IPC.UpdateDownload, () => startUpdateDownload())

  ipcMain.handle(IPC.UpdateCancel, () => cancelUpdateDownload())

  ipcMain.handle(IPC.UpdateOpen, () => openUpdateInstaller())

  ipcMain.handle(IPC.UpdateInstall, () => installUpdate())

  ipcMain.handle(IPC.UpdateSkip, (_e, version: string) => skipUpdateVersion(version))

  ipcMain.handle(IPC.UpdatePrefs, (_e, patch: UpdatePrefsPatch) => setUpdatePrefs(patch))

  ipcMain.handle(IPC.UpdateSeen, () => markUpdateSeen())

  ipcMain.handle(IPC.UiLanguageGet, (): UiLanguage => getUiLanguage())
  ipcMain.handle(IPC.UiLanguageSet, (_e, lang: UiLanguage): UiLanguage => {
    const next = setUiLanguage(lang)
    broadcast(EV.LanguageChanged, { lang: next })
    return next
  })

  ipcMain.handle(IPC.SettingsGet, (): SettingsState => {
    const space = getSpace()
    const model = getModelConfig()
    if (!space || !model) throw new Error('尚未完成首次配置')
    return { space, model, hasApiKey: model.providerId === 'archipelago' ? !!currentSeaToken() : !!getApiKey(model.providerId) }
  })

  ipcMain.handle(IPC.SettingsSave, (_e, input: SettingsSaveInput): SettingsState => {
    if (input.islandName !== undefined || input.ownerName !== undefined) {
      updateSpace({ name: input.islandName, ownerName: input.ownerName })
      // 岛名/岛主改了就重报登记,账号页设备列表里的岛名不用等下次登录才刷新
      void rebindIsland()
    }
    if (input.providerId && input.modelId) {
      setModelConfig({ providerId: input.providerId, modelId: input.modelId })
    }
    if (input.apiKey && input.apiKey.trim()) {
      const providerId = input.providerId ?? getModelConfig()?.providerId
      if (providerId) setApiKey(providerId, input.apiKey.trim())
    }
    const space = getSpace()
    const model = getModelConfig()
    if (!space || !model) throw new Error('尚未完成首次配置')
    return { space, model, hasApiKey: model.providerId === 'archipelago' ? !!currentSeaToken() : !!getApiKey(model.providerId) }
  })

  // 群岛账号(海域服务,0.8 登录门):账号即门——登录成功才挂载数据根、才开业务库
  // 群岛通道积分(0.9):快照带 30s 缓存;兑换成功即失效缓存
  ipcMain.handle(IPC.CreditsGet, async (_e, force?: boolean): Promise<CreditsSnapshot> => creditsSnapshot(force === true))

  ipcMain.handle(IPC.CreditsRedeem, async (_e, code: string): Promise<RedeemResult> => {
    if (!code || typeof code !== 'string') throw new Error('请输入兑换码')
    return await redeemCredits(code.trim())
  })

  ipcMain.handle(IPC.AuthState, (): SeaSessionState | null => getAuthState())

  ipcMain.handle(IPC.AuthRefresh, async (): Promise<SeaSessionState | null> => {
    invalidateCreditsCache()
    const state = await refreshAuthState()
    // 负载形状须与 AuthChangedEvent{state} 一致(同 updater 的 UpdateState);broadcast 收 unknown,
    // 裸发 state 会让渲染端 e.state 恒 undefined → 打开账号页签即误锁登录屏
    broadcast(EV.AuthChanged, { state })
    postOnAuthChanged(!!state) // #28:登录态刷新成功(登录屏走完的出口之一)立即收一次信
    return state
  })

  ipcMain.handle(IPC.AuthRequestCode, (_e, email: string) => requestCode(email))

  ipcMain.handle(IPC.AuthVerify, async (_e, email: string, code: string): Promise<SeaLoginNext> => {
    const next = await verifyLogin(email, code)
    // #28:验证通过即触发首拉(claim 待认领时会话未落盘,postOnAuthChanged 内部守卫会转短间隔重试)
    postOnAuthChanged(true)
    return next
  })

  ipcMain.handle(IPC.AuthClaimConfirm, async (): Promise<SeaLoginNext> => {
    const next = await confirmClaim()
    postOnAuthChanged(true) // #28:认领完成会话已落盘,立即收信
    return next
  })

  ipcMain.handle(IPC.AuthClaimDecline, async (): Promise<SeaLoginNext> => {
    const next = await declineClaim()
    postOnAuthChanged(true) // #28:走向导路径,等绑岛就绪后首拉(守卫内短间隔重试)
    return next
  })

  ipcMain.handle(IPC.AuthLogout, async (): Promise<void> => {
    await seaLogout()
    broadcast(EV.AuthChanged, { state: null })
    postOnAuthChanged(false) // #28:复位首拉与节流,换号重登立刻拉不吃旧账号的 lastPullAt
  })

  // ---- 邮局(岛际信件通信,2026-10-29) ----
  ipcMain.handle(IPC.PostOverview, (): PostOverview => {
    return postOverview()
  })

  ipcMain.handle(IPC.PostSend, async (_e, input: PostSendInput): Promise<PostLetter> => {
    return await sendLetter({
      toIsland: input.toIsland,
      subject: input.subject,
      body: input.body,
      attachmentPaths: (input.attachments ?? []).map((a) => a.path)
    })
  })

  ipcMain.handle(IPC.PostFriendRespond, async (_e, fromIsland: string, accept: boolean): Promise<void> => {
    await postFriendRespond(fromIsland, accept)
  })

  ipcMain.handle(IPC.PostSaveInviteQr, (_e, dataUrl: string) => postSaveInviteQr(dataUrl))
  ipcMain.handle(IPC.PostCopyInviteImage, (_e, dataUrl: string) => postCopyInviteImage(dataUrl))
  ipcMain.handle(IPC.PostFriendRequest, async (_e, token: string, note: string): Promise<void> => {
    await postFriendRequest(token, note)
  })

  ipcMain.handle(IPC.PostBlock, async (_e, islandUid: string, fromLetterId?: string): Promise<void> => {
    await postBlock(islandUid, fromLetterId)
  })

  ipcMain.handle(IPC.PostDeleteContact, async (_e, islandUid: string, fromLetterId?: string): Promise<void> => {
    await postDeleteContact(islandUid, fromLetterId)
  })

  ipcMain.handle(IPC.PostDeleteLetter, (_e, letterId: string): void => {
    postDeleteLetter(letterId)
  })

  ipcMain.handle(IPC.PostInviteCreate, (): Promise<PostInviteInfo> => {
    return postInviteCreate()
  })

  ipcMain.handle(IPC.PostInviteParse, (_e, text: string): Promise<PostInviteParsed> => {
    return postInviteParse(text)
  })

  ipcMain.handle(IPC.PostMarkRead, (_e, letterId: string): void => {
    postMarkRead(letterId)
  })

  // 批量标已读(#27):一个事务一次广播,进邮局的 1.5s 批量标读走这里
  ipcMain.handle(IPC.PostMarkReadMany, (_e, letterIds: string[]): void => {
    postMarkReadMany(letterIds)
  })

  // 进邮局页补拉(#28):≥30s 节流,等拉取落库后返回(渲染层区分「正在收取」与「确实没有」)
  ipcMain.handle(IPC.PostPull, (): Promise<void> => postPullNow())

  ipcMain.handle(IPC.PostAttachmentsPick, (): Promise<MessageAttachment[]> => {
    return postPickAttachments()
  })

  ipcMain.handle(IPC.PostAttachmentsIntake, (_e, items: AttachmentIntakeItem[]): Promise<MessageAttachment[]> => {
    return postIntakeAttachments(items)
  })
}

async function testConnection(input: TestConnectionInput): Promise<TestResult> {
  const provider = getProvider(input.providerId)
  if (!provider) return { ok: false, error: `未知的模型厂商:${input.providerId}` }
  const apiKey = input.apiKey.trim()
  if (!apiKey) return { ok: false, error: '请先填写 API Key' }
  const started = Date.now()
  try {
    await chatOnce({
      baseUrl: provider.baseUrl,
      apiKey,
      model: input.modelId,
      maxTokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
      signal: withTimeout(undefined, 20_000)
    })
    return { ok: true, latencyMs: Date.now() - started }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}
