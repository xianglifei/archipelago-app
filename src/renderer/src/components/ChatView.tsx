import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  BellRing,
  BookOpen,
  Check,
  ChevronRight,
  ClipboardList,
  Clock,
  CornerUpLeft,
  FilePenLine,
  FilePlus2,
  Folder,
  Globe,
  Hourglass,
  Loader2,
  Lock,
  MessagesSquare,
  Pencil,
  Share2,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  SquareTerminal,
  UserRound,
  Wrench,
  X
} from 'lucide-react'
import type {
  ApprovalMeta,
  Bot,
  ChatMessage,
  ExchangeDetail,
  MessageAttachment,
  QuoteMeta,
  ReasoningMeta,
  RelationMeta,
  RelayMeta,
  TaskRunMeta,
  TaskThreadInfo,
  ToolEventMeta,
  TurnMeta
} from '@shared/types'
import { api, onChatActivity, onChatDelta, onChatDone, onChatError, onChatReasoning, onChatStopped, onChatStep, onChatSync, onChatUserAdded } from '../api'
import { chatErrorText } from '../chat-error'
import { formatStamp } from '../utils/time'
import { openFileSmart } from '../utils/open-file'
import ResidentAvatar from './ResidentAvatar'
import Composer, { UserAttachments, filesFromDataTransfer, useAttachmentIntake } from './Composer'
import { Markdown, WorkspaceBaseContext } from './markdown/Markdown'
import { Reasoning } from './markdown/Reasoning'
import { MessageActions } from './markdown/MessageActions'
import { QuoteSelection } from './quote/QuoteSelection'
import { QuoteCards } from './quote/QuoteCards'
import { chatQuoteKey, makeChatQuote, quoteStore } from './quote/quoteStore'
import { ChatSelectionBar, ExportStatusNote } from './ChatSelectionBar'
import { useMessageExport } from '../utils/useMessageExport'
import {
  buildDisplay,
  isActionItem,
  timelineEdgeMs,
  type SilentTurnGroup,
  type TimelineItem,
  type TurnGroup
} from '../utils/turn-display'
import { loadTurnProcessPref, turnProcessPrefExpanded } from '../utils/turn-process-pref'
import { useTranslation } from '../i18n'

// 单聊(M3):流式回复,思考过程折叠;居民私信以事件行内联展示(DS Bot 式);
// 一次私信交流(同一 exchangeId 的 relation 行)折叠为单气泡,点开浮窗看完整往返;
// 上下文管家对用户不可见,永远是一条连续聊天
//
// 回合折叠(方案 C,2026-10-27):一次「用户消息→思考/工具/私信过程行→最终回复」是一个回合,
// 出结果后过程默认整体收起为「已工作 N 秒」小签,点开按时间线还原;进行中的默认态跟随设置
// 「工作过程」(2026-11-08:默认改折叠,可选展开,utils/turn-process-pref.ts)。
// 新数据按 turnId 分组,旧消息无 turnId 按位置推导兜底;静默回信(B 处理来信)的过程行折进私信浮窗
// (分组纯逻辑在 utils/turn-display.ts,含 #34 静默回信进行中的「回信中」签)。
// 中间步正文(2026-10-28 拍板修订):带工具调用的步骤产出的过渡文字落 kind='note' 过程行,
// 以纯文本折进时间线;最终回复气泡只装最后一步的正文,实时气泡在步界(工具开跑)清空。

/** 「已工作 N 秒」的时长写法(双语) */
type TFn = (key: string, opts?: Record<string, unknown>) => string

function formatWork(ms: number, t: TFn): string {
  const secs = Math.max(1, Math.round(ms / 1000))
  if (secs < 60) return t('chat.workSecs', { n: secs })
  const mins = Math.floor(secs / 60)
  if (mins < 60)
    return secs % 60 ? t('chat.workMins', { m: mins, s: secs % 60 }) : t('chat.workMinsOnly', { m: mins })
  return t('chat.workHours', { h: Math.floor(mins / 60), m: mins % 60 })
}

export default function ChatView({
  bot,
  task,
  residents,
  onOpenProfile,
  onRecharge,
  onOpenModelSource
}: {
  bot: Bot
  /** 任务会话模式(2026-11-06「新建任务」):历史/发送/事件按线程路由,头部与空态换任务口径;
   *  传入即任务视图——居民属性(档案按钮/@ 浮窗/审批面板)照常可用 */
  task?: TaskThreadInfo
  /** 全岛居民(@ 浮窗候选;单聊 @ 仅名字提及,不路由不拉人——2026-10-27 拍板) */
  residents?: Bot[]
  onOpenProfile?: () => void
  /** 余额预警条「去充值」:跳设置 → 套餐与积分(0.9) */
  onRecharge?: () => void
  /** 错误条「去设置换 Key」:跳设置 → 岛务 → 模型来源(2026-11-13 BYOK) */
  onOpenModelSource?: () => void
}) {
  const { t } = useTranslation()
  const taskId = task?.id
  const [messages, setMessages] = useState<ChatMessage[]>([])

  // 群岛通道余额(0.9):驱动输入框上方预警条与发送置灰;<200 且 >0 提示、≤0 置灰
  const [balance, setBalance] = useState<number | null>(null)
  const refreshCredits = (): Promise<void> =>
    api
      .creditsGet()
      .then((snap) => setBalance(snap.balanceMilli))
      .catch(() => setBalance(null))
  useEffect(() => {
    void refreshCredits()
  }, [])

  // 回合过程默认折叠/展开(2026-11-08 设置项):挂载即拉(登录守卫内),运行签挂载瞬间读缓存
  useEffect(() => {
    void loadTurnProcessPref()
  }, [])

  const [streamText, setStreamText] = useState('')
  const [streamReasoning, setStreamReasoning] = useState('')
  // 流已建立但还没出字(收到 : keep-alive 注释行):折叠签显示「排队等待大模型」而非干等
  const [streamActive, setStreamActive] = useState(false)
  const [busy, setBusy] = useState(false)
  // 静默回信进行中(#34,2026-11-05):主进程真态(relation/digest 回合在跑),随 chatHistory 下发;
  // 驱动「回信中 · Ns」运行签的秒跳与收起,回合真死(崩溃残留)则按停止口径展示
  const [replying, setReplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 错误码决定动作组(2026-11-13 BYOK):自带 Key 撞 401/402/网络故障时给「换 Key / 切回群岛通道」
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined)
  // 切回通道后的说明(非错误态,用 info 样式,跟着下一条错误一起被替换)
  const [notice, setNotice] = useState<string | null>(null)
  // 当前居民走哪条通道:只有群岛通道才受积分余额约束;自带 Key 下余额与「能不能发」无关
  const byok = bot.providerId !== 'archipelago'
  // 自带 Key 的硬故障在聊天里就能救回来(2026-11-13 BYOK):撞 401 的地方是聊天,不是设置。
  // 三类码给同一组逃生动作;其余错误仍是「知道了」。
  const showKeyEscape =
    byok && (errorCode === 'key_invalid' || errorCode === 'key_insufficient' || errorCode === 'network_error')
  const [input, setInput] = useState('')
  // 随本条消息发送的附件(2026-10-29 输入框升级):回形针/粘贴/拖拽三入口,由共享 Composer 承载
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  // 拖放区=整个聊天视图(体验反馈 2026-10-30):拖到消息区任意位置松手即挂上,不必精确瞄准输入框
  const { intakeFiles } = useAttachmentIntake({ mode: 'chat', attachments, onAttachmentsChange: setAttachments })
  const [openExchange, setOpenExchange] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 聊天视图根(选区引用 2026-11-02):选区须落在它内部才弹「引用/复制」浮窗
  const rootRef = useRef<HTMLDivElement>(null)
  // 吸底跟随:只有用户本来就在底部附近才跟着滚(往上翻阅时不硬拽回来,也不与滚动锚定打架)
  const pinnedRef = useRef(true)
  // 终结事件序号(Done/Stopped/Error 各递增一次):chatHistory 快照里的 turnActive 只在「快照之后没发生终结」时才可信
  const turnSeqRef = useRef(0)

  // 切回群岛通道:不弹二次确认(逃生路径不该再多一步),切完用 info 条说明恢复积分计费
  async function switchBackToRelay(): Promise<void> {
    try {
      await api.settingsSave({ providerId: 'archipelago', modelId: bot.modelId })
      setError(null)
      setErrorCode(undefined)
      setNotice(t('chat.switchedBackRelay'))
      void refreshCredits()
    } catch (err) {
      setErrorCode(undefined)
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  // 选区引用(2026-11-02):按会话分桶,切走再切回保留;发送消费、失败回滚
  // 头部内联改名(2026-11-06,仅任务模式):Enter 保存 / Esc 取消 / 失焦保存,与侧栏行改名同款
  const [renamingTitle, setRenamingTitle] = useState<string | null>(null)
  function commitHeaderRename(): void {
    const value = renamingTitle
    if (!taskId || value === null) return
    setRenamingTitle(null)
    const next = value.trim()
    if (next === (task?.title ?? '') ) return
    api.taskThreadRename(taskId, next).catch((err) => window.alert(err instanceof Error ? err.message : String(err)))
  }

  // 更换工作目录(2026-11-10 第一批):chip 点击 → 原生选目录 → 绑定授权卡(落本线程会话);
  // 结果线程由 ThreadsChanged 广播刷新,拒绝/阻断的人话回执走 alert
  async function changeWorkdir(): Promise<void> {
    if (!taskId) return
    const dir = await api.pickDirectory()
    if (!dir) return
    try {
      const r = await api.taskThreadSetWorkdir(taskId, dir)
      if (!r.ok) window.alert(r.message)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }

  // 任务会话的引用分桶独立(2026-11-06):与该居民单聊的待发引用互不混
  const quoteKey = chatQuoteKey(taskId ? `task:${taskId}` : bot.id)
  // 多选导出(2026-11-02):header 进多选模式,勾选用户消息与居民正文,导出/复制为 Markdown
  // 任务会话导出走 threadId(2026-11-06):主进程按线程取会话,标题用任务名
  const exporter = useMessageExport(taskId ? { threadId: taskId } : { botId: bot.id })
  // 单聊可选全集:kind='chat' 的行(过程类思考/工具/审批/私信不导);勾选按消息 id 绑定,新到消息同样可勾
  const selectableIds = messages.filter((m) => !m.kind || m.kind === 'chat').map((m) => m.id)
  const selFor = (id: number | undefined) =>
    exporter.selecting && id !== undefined
      ? { selected: exporter.selectedIds.has(id), onToggle: () => exporter.toggle(id) }
      : undefined
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => exporter.selectedIds.has(id))

  useEffect(() => {
    let disposed = false
    pinnedRef.current = true
    // 事件路由(2026-11-06「新建任务」):任务视图只吃带本线程 threadId 的事件,
    // 单聊视图只吃不带 threadId 的事件——同一居民的单聊与任务并行时流互不串门
    const mine = (botId: string, threadId?: string): boolean =>
      botId === bot.id && (taskId ? threadId === taskId : threadId === undefined)
    const fetchHistory = (): Promise<{ messages: ChatMessage[]; turnKind?: string; turnActive: boolean }> =>
      taskId ? api.taskThreadHistory(taskId) : api.chatHistory(bot.id)
    const offs = [
      onChatUserAdded(({ botId, threadId, message }) => {
        if (!mine(botId, threadId)) return
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
      }),
      onChatDelta(({ botId, threadId, text }) => {
        if (!mine(botId, threadId)) return
        // 停在会话里时,任务回合等自主可见回合开跑(busy 只在本地发送/挂载快照时点亮)——
        // 首个 delta 即点亮,流式气泡与停止键才不会缺席;静默回信回合不发 delta 不受影响
        setBusy(true)
        setStreamText((t) => t + text)
      }),
      onChatReasoning(({ botId, threadId, text }) => {
        if (!mine(botId, threadId)) return
        setStreamReasoning((t) => t + text)
      }),
      onChatActivity(({ botId, threadId }) => {
        if (!mine(botId, threadId)) return
        setBusy(true)
        setStreamActive(true)
      }),
      // 步界(2026-10-28 拍板修订):本段正文已落 note 行折进时间线,实时气泡清空让位给下一段;
      // 最终段无步界,打完直接由 ChatDone 转正,不会出现「缩水」。思考缓冲一并清,
      // 否则工具执行期签上会误亮「正在思考」
      onChatStep(({ botId, threadId }) => {
        if (!mine(botId, threadId)) return
        setStreamText('')
        setStreamReasoning('')
      }),
      onChatDone(({ botId, threadId, message }) => {
        if (!mine(botId, threadId)) return
        turnSeqRef.current++
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
        setStreamText('')
        setStreamReasoning('')
        setStreamActive(false)
        setBusy(false)
      }),
      onChatStopped(({ botId, threadId, message }) => {
        if (!mine(botId, threadId)) return
        turnSeqRef.current++
        if (message) {
          setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
        }
        setStreamText('')
        setStreamReasoning('')
        setStreamActive(false)
        setBusy(false)
      }),
      onChatError(({ botId, threadId, error: err, code }) => {
        if (!mine(botId, threadId)) return
        turnSeqRef.current++
        setError(chatErrorText(t, code, err, { byok }))
        setErrorCode(code)
        setNotice(null)
        setStreamText('')
        setStreamReasoning('')
        setStreamActive(false)
        setBusy(false)
        if (code === 'insufficient_credits') void refreshCredits()
      }),
      // 居民私信事件行落库后,静默重载历史(两个相关窗口都会收到);
      // #34:回信过程行/回复行落库都走这里,顺带刷新「回信中」真态(回合起止时 active 注册表已就位)。
      // ChatSync 载荷只带 botId(无 threadId):该居民任一会话变动都会重拉本视图历史,多拉无害。
      // 快照守卫(2026-11-06 codex 审查修复):拉取期间若有终结事件到达(Done/Error/Stop 已把消息
      // 追加进本视图),迟到的旧快照会把刚落的消息抹掉——事件落库必伴随新一轮 ChatSync 拉取在
      // 路上,丢弃本帧即可,不会丢数据
      onChatSync(({ botId }) => {
        if (botId !== bot.id) return
        const seqAtSync = turnSeqRef.current
        fetchHistory()
          .then((result) => {
            if (disposed || turnSeqRef.current !== seqAtSync) return
            setMessages(result.messages)
            setReplying(result.turnKind === 'relation' || result.turnKind === 'digest')
          })
          .catch(console.error)
      })
    ]
    const seqAtFetch = turnSeqRef.current
    fetchHistory()
      .then((result) => {
        // 首拉同款守卫:快照之后已有终结事件到达(序号变了)就整帧丢弃——事件已把消息追加进
        // 状态,回写旧快照会把它们抹掉;后续 ChatSync 拉取会带来更新的历史
        if (disposed || turnSeqRef.current !== seqAtFetch) return
        setMessages(result.messages)
        setReplying(result.turnKind === 'relation' || result.turnKind === 'digest')
        // 回合真态兜底:切走再切回/窗口重载后 busy 是组件本地态已经丢了,主进程说还在跑就恢复停止键;
        // 快照之后若已有终结事件到达(序号变了),这个 turnActive 就过期了,不回置——否则把刚熄的 busy 又点亮
        if (result.turnActive) setBusy(true)
      })
      .catch((err) => console.error(err))
    return () => {
      disposed = true
      offs.forEach((off) => off())
    }
    // t 入依赖:语言切换后重挂事件,不足额积分等错误文案不再停留在旧语言;
    // byok 入依赖:切档后重挂事件,401 的人话/逃生按钮口径跟着新通道走
  }, [bot.id, taskId, t, byok])

  // 消息/流式内容变化时,吸底才跟随;直接设 scrollTop(不惊动祖先滚动容器),绘制前执行不闪跳
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streamText, streamReasoning])

  function onBodyScroll(): void {
    const el = bodyRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 24
  }

  async function send(): Promise<void> {
    const text = input.trim()
    const pendingQuotes = quoteStore.record(quoteKey).quotes
    if ((!text && attachments.length === 0 && pendingQuotes.length === 0) || busy) return
    // 第四处积分门(原型只列了三处):0 积分 + 自带 Key 时这里也必须放行,否则按钮可点、
    // 一点就被「积分已用尽」挡回去——恰好是 BYOK 最该救的人
    if (!byok && balance !== null && balance <= 0) {
      setErrorCode(undefined)
      setError(t('chat.errExhausted'))
      return
    }
    const sending = attachments
    // 选区引用(2026-11-02):发送即消费;IPC 失败(居民不存在等)把引用还回输入框,chip 不丢
    const quotes = quoteStore.take(quoteKey)
    setInput('')
    setAttachments([])
    setError(null)
    setNotice(null)
    setBusy(true)
    setStreamText('')
    setStreamReasoning('')
    setStreamActive(false)
    pinnedRef.current = true
    try {
      if (taskId) await api.taskThreadSend(taskId, text, sending, quotes)
      else await api.chatSend(bot.id, text, sending, quotes)
    } catch (err) {
      quoteStore.restore(quoteKey, quotes)
      // 发送被拒(居民不存在/通道不可用等)草稿回魂(2026-11-06 codex 审查修复:此前正文与
      // 附件直接蒸发);等待期间用户已重新输入/添加的,不覆盖只补回空缺位
      setInput((cur) => (cur.trim() === '' ? text : cur))
      setAttachments((cur) => (cur.length === 0 ? sending : cur))
      // 本地报错没有错误码:清掉上一条的码,否则「换 Key / 切回」这组逃生按钮会挂在不相干的错上
      setErrorCode(undefined)
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  // 最后一条正文消息(事件行/审批/思考行不算),操作条对它常显;最后一条用户消息界定进行中的回合
  const lastBubbleId = [...messages].reverse().find((m) => !m.kind || m.kind === 'chat')?.id
  const lastUserId = [...messages].reverse().find((m) => (!m.kind || m.kind === 'chat') && m.role === 'user')?.id
  const display = buildDisplay(messages, replying)

  // 挂起中的审批(理论上一个会话同时最多一张,取最新);审批即输入:输入行让位给决策面板
  const pendingApproval = [...messages]
    .reverse()
    .find((m) => m.kind === 'approval' && (m.meta as ApprovalMeta | undefined)?.status === 'pending')
  const decidingRef = useRef(false)

  async function decideApproval(choice: 'allow' | 'deny' | 'turn' | 'always'): Promise<void> {
    const meta = pendingApproval?.meta as ApprovalMeta | undefined
    if (!meta || decidingRef.current) return
    // noAlways 卡(2026-11-10 工作目录绑定):没有「以后全自动」档——快捷键与按钮同门,IPC 侧也不该到达
    if (choice === 'always' && meta.noAlways) return
    decidingRef.current = true
    try {
      await api.approvalResolve(meta.approvalId, choice)
    } catch (err) {
      // 提交失败要给用户看见(此前只 console.error,面板按钮永久禁用像死机);
      // 不吞:面板 busy 由 finally 解除,用户可重试或换一档决策
      setErrorCode(undefined)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      decidingRef.current = false
    }
  }

  // 四档键盘:⏎ 允许 / Esc 拒绝 / ⌘⏎ 本回合不再问 / ⌥⏎ 以后全自动(私信详情浮窗或全局弹窗开着时不抢键)
  useEffect(() => {
    // 多选导出模式开着时键盘让位:Esc=退出多选而非拒绝审批,先退出多选再按 Esc 才轮到审批
    if (!pendingApproval || openExchange || exporter.selecting) return
    const onKey = (e: KeyboardEvent): void => {
      if (document.querySelector('.modal-overlay')) return
      // 输入控件(档案面板加记忆/搜索框等)、按钮/链接等交互件与输入法组合中不抢键:在别的
      // 输入框按 Enter/选字会误触「允许」;焦点在「拒绝」按钮上按 Enter 是激活该按钮,全局
      // 抢键+preventDefault 会把它变成「允许」(2026-11-06 codex 审查修复);已被上层处理的让位
      if (e.defaultPrevented || e.isComposing) return
      const target = e.target as HTMLElement | null
      if (target?.closest('button, a, select, input, textarea, [contenteditable]')) return
      if (e.key === 'Enter' && e.altKey) {
        e.preventDefault()
        void decideApproval('always')
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void decideApproval('turn')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void decideApproval('allow')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        void decideApproval('deny')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // 正文相对路径(产出/xxx.md)的解析基点:绑定了工作目录的任务按任务执行根(M11:
  // 工作树就绪用工作树,否则绑定目录;历史消息在换绑后会按当前绑定解析,属已知近似);
  // 其余场景照旧按当前居民工作区(2026-11-06 后缀规则)
  const mdPathBase = taskId
    ? (task?.wtState === 'ready' && task?.wtPath) || task?.workdirPath || bot.workspacePath
    : bot.workspacePath
  return (
    <WorkspaceBaseContext.Provider value={mdPathBase}>
    <div
      className="chat"
      ref={rootRef}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        const { files, dirs } = filesFromDataTransfer(e.dataTransfer)
        if (files.length === 0) return
        e.preventDefault()
        void intakeFiles(files, dirs)
      }}
    >
      <QuoteSelection
        rootRef={rootRef}
        resolveBase={bot.workspacePath}
        onAdd={(c) => quoteStore.add(quoteKey, makeChatQuote(c.text, c.kind, c.botName))}
      />
      <header className={`chat-header ${pendingApproval ? 'asking' : ''}`}>
        {exporter.status ? (
          <ExportStatusNote
            status={exporter.status}
            onReveal={() => {
              const st = exporter.status
              if (st?.kind === 'saved') void api.revealInFolder(st.path)
            }}
            onClose={exporter.dismissStatus}
          />
        ) : exporter.selecting ? (
          <ChatSelectionBar
            selectedCount={exporter.selectedIds.size}
            allSelected={allSelected}
            busy={exporter.busy}
            error={exporter.error}
            onToggleAll={() => exporter.selectAll(allSelected ? [] : selectableIds)}
            onCopy={() => void exporter.run('copy')}
            onExport={() => void exporter.run('save')}
            onCancel={exporter.exit}
          />
        ) : (
          <>
            <ResidentAvatar appearance={bot.appearance} fallbackName={bot.name} fallbackColor={bot.color} size="lg">
              {/* 任务会话(2026-11-06):头像右下角任务签(P2 方案 A,与列表行同款) */}
              {taskId && (
                <span className="task-badge" aria-hidden>
                  <ClipboardList size={10} />
                </span>
              )}
            </ResidentAvatar>
            {taskId ? (
              /* 任务视图头部:标题(线程名)+副行(哪位居民承办)——标题认事、头像与副行认人;
                  重命名按钮进入内联编辑(Enter 保存,与侧栏行改名同款) */
              <div className="chat-title-col">
                {renamingTitle === null ? (
                  <div className="chat-title">{task?.title || t('sidebar.taskUntitled')}</div>
                ) : (
                  <input
                    className="task-rename header"
                    autoFocus
                    value={renamingTitle}
                    onChange={(e) => setRenamingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitHeaderRename()
                      if (e.key === 'Escape') setRenamingTitle(null)
                      e.stopPropagation()
                    }}
                    onBlur={commitHeaderRename}
                    onFocus={(e) => e.target.select()}
                  />
                )}
                <div className="chat-sub">
                  {t('chat.taskSubtitle', { name: bot.name })}
                  {task?.workdirPath && (
                    <button
                      type="button"
                      className="task-workdir-chip"
                      title={task.wtError ?? task.workdirPath}
                      onClick={() => void changeWorkdir()}
                    >
                      <Folder size={11} />
                      {t('task.workdirChip', {
                        dir: task.workdirPath.replace(/^.*[/\\]/, ''),
                        ref: task.wtState === 'error' ? '⚠' : (task.wtBranch ?? t('task.workdirDirect'))
                      })}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              /* 0.9.2 自走查:去掉第二行「岛务长 · 模型名」(C2,违背去模型化),只留名字+标签一行并垂直居中;
                  标签样式全员化(C3)——任何居民填了角色标签都有同款徽章,不再岛务长专属 */
              <div className="chat-title">
                {bot.name}
                {bot.isMain ? (
                  <span className="badge">{t('common.steward')}</span>
                ) : bot.role ? (
                  <span className="badge">{bot.role}</span>
                ) : null}
              </div>
            )}
            <div className="header-actions">
              {taskId && (
                <button
                  className="icon-btn ghost-btn"
                  title={t('sidebar.renameTask')}
                  onClick={() => setRenamingTitle(task?.title ?? '')}
                >
                  <Pencil size={15} />
                </button>
              )}
              <button className="icon-btn ghost-btn" title={t('chat.exportTitle')} onClick={exporter.enter}>
                <Share2 size={16} />
              </button>
              {onOpenProfile && (
                <button className="icon-btn ghost-btn" title={t('chat.profile')} onClick={onOpenProfile}>
                  <UserRound size={16} />
                </button>
              )}
            </div>
          </>
        )}
      </header>

      <div className="chat-body" ref={bodyRef} onScroll={onBodyScroll}>
        {messages.length === 0 && !streamText && (
          <div className="chat-empty">
            {taskId ? <ClipboardList size={22} /> : <Sparkles size={22} />}
            <p>{taskId ? t('chat.taskEmpty') : t('chat.greet', { name: bot.name })}</p>
          </div>
        )}
        {display.map((item) => {
          if (item.type === 'turn') {
            return (
              <TurnGroupView
                key={item.group.key}
                group={item.group}
                running={busy && item.group.userMessage?.id === lastUserId}
                thinking={busy && !streamText && !!streamReasoning}
                queued={busy && !streamText && !streamReasoning && streamActive}
                isLastChat={item.group.anchor?.id === lastBubbleId && !busy}
                onOpenExchange={setOpenExchange}
                selFor={selFor}
              />
            )
          }
          if (item.type === 'exchange') {
            return <ExchangeBubble key={item.exchangeId} rows={item.rows} onOpen={() => setOpenExchange(item.exchangeId)} />
          }
          if (item.type === 'silentTurn') {
            // 空组且非运行(回复已落地/来信从未被处理)不渲染——签是进行中的临时物,不留常驻
            return item.group.timeline.length === 0 && !item.running ? null : (
              <SilentTurnFold key={item.group.key} group={item.group} running={item.running} />
            )
          }
          const m = item.message
          if (m.kind === 'tool') return <ToolEventLine key={m.id} message={m} />
          if (m.kind === 'approval') return <ApprovalChip key={m.id} message={m} />
          if (m.kind === 'relation') return <RelationLine key={m.id} message={m} />
          if (m.kind === 'note') return <NoteLine key={m.id} message={m} />
          if (m.kind === 'reasoning') {
            return (
              <Reasoning key={m.id} text={m.reasoning ?? ''} elapsedMs={(m.meta as ReasoningMeta | undefined)?.durationMs} />
            )
          }
          return <Bubble key={m.id} message={m} isLast={m.id === lastBubbleId && !busy} selection={selFor(m.id)} />
        })}
        {busy && streamText && (
          <div className="msg assistant">
            <div className="msg-col">
              <div className="bubble bot-bubble">
                <Markdown content={streamText} streaming />
              </div>
            </div>
          </div>
        )}
        {/* 思考阶段的实时指示统一由回合折叠签承担(「工作中 · Ns · 正在思考」),
            正文气泡里不再放思考 bar——避免提交结论时 bar 突然消失的闪动(2026-10-27 走查二轮) */}
        {error && (
          <div className="chat-error">
            <span>{error}</span>
            {showKeyEscape ? (
              <span className="chat-error-actions">
                {onOpenModelSource && (
                  <button
                    onClick={() => {
                      setError(null)
                      setErrorCode(undefined)
                      onOpenModelSource()
                    }}
                  >
                    {t('chat.errGoFixKey')}
                  </button>
                )}
                <button onClick={() => void switchBackToRelay()}>{t('chat.errSwitchBack')}</button>
              </span>
            ) : (
              <button
                onClick={() => {
                  setError(null)
                  setErrorCode(undefined)
                }}
              >
                {t('common.gotIt')}
              </button>
            )}
          </div>
        )}
        {notice && (
          <div className="chat-error info">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)}>{t('common.gotIt')}</button>
          </div>
        )}
      </div>

      <footer className={`composer ${pendingApproval ? 'approval' : ''}`}>
        {pendingApproval ? (
          <ApprovalPanel bot={bot} message={pendingApproval} onDecide={decideApproval} />
        ) : (
          <>
            {!byok && balance !== null && balance <= 0 && (
              <div className="composer-warnbar exhausted" onClick={onRecharge}>
                {t('credits.warnExhausted')}<button className="link-btn">{t('chat.goTopUp')}</button>
              </div>
            )}
            {!byok && balance !== null && balance > 0 && balance < 200_000 && (
              <div className="composer-warnbar" onClick={onRecharge}>
                {t('chat.warnLow')}<button className="link-btn">{t('chat.goTopUp')}</button>
              </div>
            )}
            <Composer
              input={input}
              onInputChange={setInput}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              busy={busy}
              onStop={() => void (taskId ? api.taskThreadStop(taskId) : api.chatStop(bot.id))}
              onSend={() => void send()}
              placeholder={
                !byok && balance !== null && balance <= 0
                  ? t('chat.placeholderExhausted')
                  : taskId
                    ? t('chat.placeholderTask', { name: bot.name })
                    : t('chat.placeholder', { name: bot.name })
              }
              sendDisabled={!byok && balance !== null && balance <= 0}
              mentionCandidates={residents ?? [{ name: bot.name }]}
              quoteKey={quoteKey}
            />
          </>
        )}
      </footer>
      {openExchange && <ExchangeModal exchangeId={openExchange} onClose={() => setOpenExchange(null)} />}
    </div>
    </WorkspaceBaseContext.Provider>
  )
}

/** 回合视图:用户气泡 → 过程折叠签(含时间线) → 正文气泡;进行中即使还没有过程行也亮签(计时即活动指示) */
function TurnGroupView({
  group,
  running,
  thinking,
  queued,
  isLastChat,
  onOpenExchange,
  selFor
}: {
  group: TurnGroup
  running: boolean
  thinking: boolean
  /** 已连上服务端但还没出字(排队中):签上亮「排队等待大模型」 */
  queued: boolean
  isLastChat: boolean
  onOpenExchange: (exchangeId: string) => void
  /** 多选导出(2026-11-02):按消息 id 取勾选态,undefined=多选未开 */
  selFor: (id: number | undefined) => { selected: boolean; onToggle: () => void } | undefined
}) {
  return (
    <>
      {group.userMessage && <Bubble message={group.userMessage} selection={selFor(group.userMessage.id)} />}
      {(group.timeline.length > 0 || running) && (
        <TurnFold group={group} running={running} thinking={thinking} queued={queued} onOpenExchange={onOpenExchange} />
      )}
      {group.anchor && <Bubble message={group.anchor} isLast={isLastChat} selection={selFor(group.anchor.id)} />}
    </>
  )
}

/**
 * 回合过程折叠签(方案 C):出结果后默认收起为「已工作 N 秒 · M 个动作」,点开按时间线还原;
 * 进行中的默认态跟随设置「工作过程」(2026-11-08:默认改折叠、可选展开,挂载瞬间读一次偏好,
 * 工具动作在签上显示当前在干什么,点开看全程);停止/被中断/崩溃残留默认展开(异常不许藏,不受设置影响);
 * 完成即折叠(方案 C 走查定稿)。折叠态是组件态,切会话即重置,不持久化。
 */
function TurnFold({
  group,
  running,
  thinking,
  queued,
  onOpenExchange
}: {
  group: TurnGroup
  running: boolean
  thinking: boolean
  queued: boolean
  onOpenExchange: (exchangeId: string) => void
}) {
  const { t } = useTranslation()
  const stoppedPartial = (group.anchor?.meta as TurnMeta | undefined)?.stopped === true
  const noAnchor = !group.anchor
  // 运行中跟随「工作过程」设置(默认折叠);停止/崩溃残留(无 anchor 又非运行)强制展开——异常不许藏
  const defaultOpen = stoppedPartial || (noAnchor && !running) || (running && turnProcessPrefExpanded())
  const [open, setOpen] = useState(defaultOpen)
  // 运行结束的收口:只有「完整正文落地」的完成才整体收起(方案 C 定稿);
  // 停止/报错保持现场不收——折叠档用户可能全程没展开看过,收口瞬间再收一次就把过程藏没了。
  // 停止有两种形态都算异常收尾:带着 stopped 的 partial anchor,或停得早根本没落 anchor
  // (签走「已停止」口径);两者都以「保持当前开合」处理,重挂载的默认展开兜底不受影响
  // (2026-11-08 codex 评审补:此前停止也一律被收起)
  const prevRunning = useRef(running)
  useEffect(() => {
    if (prevRunning.current && !running && group.anchor && !stoppedPartial) setOpen(false)
    prevRunning.current = running
  }, [running, stoppedPartial, group])

  // 进行中每秒跳「工作中 · Ns」;完成后不再计秒(历史工时不随时间增长)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  const actions = group.timeline.filter(isActionItem).length
  const startMs = timelineEdgeMs(group, 'start')
  // 正在执行的工具动作(执行中签上亮出当前在干什么,图标换转圈)
  const runningTool = running
    ? [...group.timeline]
        .reverse()
        .find(
          (item): item is Extract<TimelineItem, { kind: 'tool' }> =>
            item.kind === 'tool' && (item.message.meta as ToolEventMeta | undefined)?.status === 'running'
        )
    : undefined
  let label: string
  if (running) {
    label =
      t('chat.turnRunning', { work: formatWork(now - startMs, t) }) +
      (runningTool
        ? ` · ${toolKeyText(t, (runningTool.message.meta as ToolEventMeta | undefined)?.labelK, runningTool.message.content)}`
        : thinking
          ? t('chat.thinkingSuffix')
          : queued
            ? t('chat.queuedSuffix')
            : '')
  } else if (noAnchor) {
    label = actions > 0 ? t('chat.stoppedActions', { count: actions }) : t('chat.stopped')
  } else {
    const worked = formatWork(Math.max(0, timelineEdgeMs(group, 'end') - startMs), t)
    label = stoppedPartial
      ? t('chat.workedStopped', { work: worked })
      : actions > 0
        ? t('chat.workedActions', { work: worked, count: actions })
        : t('chat.worked', { work: worked })
  }

  return (
    <div className="turn-fold">
      <button type="button" className="turn-fold-sign" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {runningTool ? <Loader2 size={12} className="spin" /> : <Clock size={12} />}
        <span>{label}</span>
        <ChevronRight size={12} className="turn-fold-chevron" data-open={open || undefined} />
      </button>
      {open && (
        <div className="turn-fold-body">
          {group.timeline.map((item) => (
            <TimelineRow key={itemKey(item)} item={item} onOpenExchange={onOpenExchange} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 静默回信进行中的兜底签(#34,2026-11-05):B 处理来信的思考/旁白/工具行不再逐条铺在消息流,
 * 收进一粒「回信中 · Ns」运行签(进行中默认态跟随设置「工作过程」,2026-11-08 起与「工作中」签同管、
 * 默认折叠,点开按时间线看全程,签上亮当前工具动作),
 * 与「工作中 · Ns」同一套运行态语言。回复行落地整签消失——过程照旧折进私信浮窗的
 * 「处理了这封私信」区,不新增常驻物;回合死在半路(崩溃/重启)回复行没落地的残留,
 * 按停止口径显示并默认展开(与 TurnFold「停止、被中断默认展开」同口径),过程不吞。
 */
function SilentTurnFold({ group, running }: { group: SilentTurnGroup; running: boolean }) {
  const { t } = useTranslation()
  // 运行中默认态跟随「工作过程」设置(2026-11-08 与「工作中」签口径统一,默认折叠);
  // 残留(非运行)默认展开——异常不许藏
  const [open, setOpen] = useState(running ? turnProcessPrefExpanded() : true)
  // 进行中每秒跳「回信中 · Ns」;起点=来信送达时刻(空窗期还没有过程行也照走)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  const actions = group.timeline.filter(isActionItem).length
  // 正在执行的工具动作(签上亮出当前在干什么,图标换转圈;与 TurnFold 运行态一致)
  const runningTool = running
    ? [...group.timeline]
        .reverse()
        .find(
          (item): item is Extract<TimelineItem, { kind: 'tool' }> =>
            item.kind === 'tool' && (item.message.meta as ToolEventMeta | undefined)?.status === 'running'
        )
    : undefined
  const label = running
    ? t('chat.replyRunning', { work: formatWork(now - (Date.parse(group.startAt) || now), t) }) +
      (runningTool
        ? ` · ${toolKeyText(t, (runningTool.message.meta as ToolEventMeta | undefined)?.labelK, runningTool.message.content)}`
        : '')
    : actions > 0
      ? t('chat.stoppedActions', { count: actions })
      : t('chat.stopped')

  return (
    <div className="turn-fold">
      <button type="button" className="turn-fold-sign" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {runningTool ? <Loader2 size={12} className="spin" /> : <Clock size={12} />}
        <span>{label}</span>
        <ChevronRight size={12} className="turn-fold-chevron" data-open={open || undefined} />
      </button>
      {open && (
        <div className="turn-fold-body">
          {group.timeline.map((item) => (
            <TimelineRow key={itemKey(item)} item={item} onOpenExchange={() => undefined} />
          ))}
        </div>
      )}
    </div>
  )
}

function itemKey(item: TimelineItem): string {
  switch (item.kind) {
    case 'reasoning':
      return `reasoning:${item.message.id}`
    case 'reasoningText':
      return 'reasoningText'
    case 'note':
      return `note:${item.message.id}`
    case 'tool':
      return `tool:${item.message.id}`
    case 'approval':
      return `approval:${item.message.id}`
    case 'relation':
      return `relation:${item.message.id}`
    case 'exchange':
      return `exchange:${item.exchangeId}`
  }
}

/** 时间线单项:思考块(默认收起)/工具签/审批回执/旧版私信行/私信交流签 */
function TimelineRow({
  item,
  onOpenExchange
}: {
  item: TimelineItem
  onOpenExchange: (exchangeId: string) => void
}) {
  if (item.kind === 'reasoning') {
    return <Reasoning text={item.message.reasoning ?? ''} elapsedMs={(item.message.meta as ReasoningMeta | undefined)?.durationMs} />
  }
  if (item.kind === 'reasoningText') return <Reasoning text={item.text} />
  if (item.kind === 'note') return <NoteLine message={item.message} />
  if (item.kind === 'tool') return <ToolEventLine message={item.message} />
  if (item.kind === 'approval') return <ApprovalChip message={item.message} />
  if (item.kind === 'relation') return <RelationLine message={item.message} />
  return <ExchangeBubble rows={item.rows} onOpen={() => onOpenExchange(item.exchangeId)} />
}

function Bubble({
  message,
  isLast = false,
  selection
}: {
  message: ChatMessage
  isLast?: boolean
  /** 多选导出(2026-11-02):多选模式开着时消息行首的圆形勾选框;undefined=多选未开 */
  selection?: { selected: boolean; onToggle: () => void }
}) {
  const { t } = useTranslation()
  if (message.role === 'user') {
    // 2026-10-30 评审:附件不再挤进绿色正文气泡——图片缩略图/文件卡/路径 chip 各自成块,
    // 看上去像连续发了几条消息;正文气泡只在有文字时渲染;
    // 选区引用卡(2026-11-02)同模式独立成块,置于附件之上(先读语境再看物件)
    return (
      <div className="msg user">
        {selection && (
          <button
            type="button"
            className={`select-check${selection.selected ? ' on' : ''}`}
            aria-pressed={selection.selected}
            aria-label={t('chat.exportCheck')}
            onClick={selection.onToggle}
          >
            <Check size={12} />
          </button>
        )}
        <div className="user-col">
          <QuoteCards quotes={(message.meta as QuoteMeta | undefined)?.quotes} />
          <UserAttachments attachments={message.attachments ?? []} />
          {message.content.trim() ? (
            <div className="bubble user-bubble" data-quote-source="user">
              {message.content}
            </div>
          ) : null}
        </div>
      </div>
    )
  }
  // 2026-10-23 评审:消息气泡内不再显示头像(顶部与侧栏已有,避免三处重复);
  // 回合折叠(方案 C)后思考移入回合时间线,正文气泡只留正文;
  // 定时任务触发的消息(2026-10-29)在气泡上方带一枚「定时任务」小签,解释「为什么 TA 现在开口」;
  // 唤醒转述(回复唤醒,2026-11-05)同款「收到回信」小签——对方回信落地后 TA 被唤醒才说的这段话
  const taskBadge = (message.meta as TaskRunMeta | undefined)?.taskId
  const relayBadge = (message.meta as RelayMeta | undefined)?.relay
  return (
    <div className="msg assistant">
      {selection && (
        <button
          type="button"
          className={`select-check${selection.selected ? ' on' : ''}`}
          aria-pressed={selection.selected}
          aria-label={t('chat.exportCheck')}
          onClick={selection.onToggle}
        >
          <Check size={12} />
        </button>
      )}
      <div className="msg-col">
        {taskBadge && (
          <div className="task-run-badge">
            <BellRing size={12} />
            <span>{t('chat.taskBadge')}</span>
          </div>
        )}
        {relayBadge && (
          <div className="task-run-badge">
            <MessagesSquare size={12} />
            <span>{t('chat.relayBadge')}</span>
          </div>
        )}
        <div className="bubble bot-bubble" data-quote-source="assistant">
          <Markdown content={message.content} />
        </div>
        {message.content && <MessageActions text={message.content} always={isLast} />}
      </div>
    </div>
  )
}

/** 居民私信事件行(DS Bot 式):居中小行,显示跟谁说了什么/谁发来了什么/回复了什么 */
function RelationLine({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const meta = (message.meta as RelationMeta | undefined) ?? { dir: 'out', peer: t('chat.residentFallback') }
  const text = message.content.replace(/^\[[^\]]*\]\s*/, '')

  const config =
    meta.dir === 'in'
      ? { icon: <ArrowDownLeft size={12} />, label: t('chat.dmIn', { peer: meta.peer }) }
      : meta.dir === 'reply'
        ? { icon: <CornerUpLeft size={12} />, label: t('chat.dmReply', { peer: meta.peer }) }
        : meta.dir === 'reply-in'
          ? { icon: <ArrowDownLeft size={12} />, label: t('chat.dmReplyIn', { peer: meta.peer }) }
          : { icon: <ArrowUpRight size={12} />, label: t('chat.dmOut', { peer: meta.peer }) }

  return (
    <div className="relation-line">
      <button className="relation-chip" onClick={() => setExpanded((v) => !v)} title={expanded ? t('chat.collapse') : t('chat.expand')}>
        {config.icon}
        <span>{config.label}</span>
        <span className="relation-time">{formatStamp(message.createdAt)}</span>
      </button>
      <div
        className={`relation-text ${expanded ? 'expanded' : ''}`}
        data-quote-source="relation"
        onClick={() => {
          // 拖选正文时 click 不切换展开态(否则选区被展开/收起动作毁掉,引用选不上)
          if (document.getSelection()?.toString()) return
          setExpanded((v) => !v)
        }}
      >
        {text}
      </div>
    </div>
  )
}

/** 中间步正文旁白行(2026-10-28 拍板修订):带工具调用的步骤产出的过渡文字,纯文本折进时间线,无样式不计数动作 */
function NoteLine({ message }: { message: ChatMessage }) {
  return <div className="note-line" data-quote-source="note">{message.reasoning ?? ''}</div>
}

/** 工具动作事件行(§1 永远可见):居民写文件/执行命令/联网时居中一粒小签,执行中转圈、完成带摘要 */
function toolKeyText(
  t: TFn,
  key: { k: string; p?: Record<string, string | number> } | undefined,
  fallback: string
): string {
  return key ? t(key.k, key.p ?? {}) : fallback
}

function ToolEventLine({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const meta = (message.meta as ToolEventMeta | undefined) ?? { toolName: '', status: 'done' as const }
  const [openError, setOpenError] = useState<string | null>(null)
  const displayText = toolKeyText(t, meta.labelK, message.content)
  const icon =
    meta.toolName === 'write_file' ? (
      <FilePlus2 size={12} />
    ) : meta.toolName === 'edit_file' ? (
      <FilePenLine size={12} />
    ) : meta.toolName === 'run_command' ? (
      <SquareTerminal size={12} />
    ) : meta.toolName === 'web_search' ? (
      <Globe size={12} />
    ) : meta.toolName === 'web_fetch' ? (
      <BookOpen size={12} />
    ) : (
      <Wrench size={12} />
    )

  // 写入/编辑行带目标绝对路径(meta.path)时,文件名可点打开:.md 进内置阅读器,其余系统程序
  const spaceIdx = displayText.indexOf(' ')
  const splittable = Boolean(meta.path) && spaceIdx > 0
  async function openFile(): Promise<void> {
    if (!meta.path) return
    const err = await openFileSmart(meta.path)
    setOpenError(err || null)
    if (err) setTimeout(() => setOpenError(null), 3000)
  }

  return (
    <div className="tool-line">
      <span className={`tool-chip ${meta.status}`}>
        {meta.status === 'running' ? <Loader2 size={12} className="spin" /> : icon}
        <span className="tool-label">
          {splittable ? (
            <>
              {displayText.slice(0, spaceIdx)}{' '}
              <button
                className={`tool-file-link${openError ? ' failed' : ''}`}
                title={openError ?? meta.path}
                onClick={() => void openFile()}
              >
                {displayText.slice(spaceIdx + 1)}
              </button>
            </>
          ) : (
            displayText
          )}
        </span>
        {(meta.outcomeK || meta.outcome) && (
          <span className="tool-outcome">{toolKeyText(t, meta.outcomeK, meta.outcome ?? '')}</span>
        )}
        <span className="relation-time">{formatStamp(message.createdAt)}</span>
      </span>
      {openError && <span className="tool-open-error">{openError}</span>}
    </div>
  )
}

/** 私信交流气泡:一次 send_message 的 relation 行折叠为一粒小签,正文不外露,点开浮窗看全程 */
function ExchangeBubble({ rows, onOpen }: { rows: ChatMessage[]; onOpen: () => void }) {
  const { t } = useTranslation()
  const dirOf = (m: ChatMessage): string | undefined => (m.meta as RelationMeta | undefined)?.dir
  const first = rows[0]! // 调用方按 relation 分组后才渲染,组内必有行
  const peer = (first.meta as RelationMeta | undefined)?.peer ?? t('chat.residentFallback')
  const isInitiator = rows.some((m) => dirOf(m) === 'out')
  const sends = rows.filter((m) => dirOf(m) === 'out').length
  // 「无回复」标记行(dir='reply'/'reply-in' + noReply)不算真回复:处理过但没回上来,签尾亮「未获回应」;
  // 发起方侧的 noReply 投影行为回复唤醒新增(2026-11-05),两侧对称可见
  const realReply = rows.some((m) => dirOf(m) === 'reply' && !(m.meta as RelationMeta | undefined)?.noReply)
  const markedNoReply = rows.some((m) => (dirOf(m) === 'reply' || dirOf(m) === 'reply-in') && (m.meta as RelationMeta | undefined)?.noReply)
  const realReplyIn = rows.some((m) => dirOf(m) === 'reply-in' && !(m.meta as RelationMeta | undefined)?.noReply)
  const suffix = isInitiator
    ? realReplyIn
      ? sends > 1
        ? t('chat.exRounds', { count: sends })
        : t('chat.exReplied')
      : markedNoReply
        ? t('chat.exNoReply')
        : null
    : realReply
      ? t('chat.exDidReply')
      : markedNoReply
        ? t('chat.exNoReply')
        : null
  const label = isInitiator ? t('chat.dmOut', { peer }) : t('chat.dmIn', { peer })
  return (
    <div className="tool-line">
      <button className="tool-chip exchange" onClick={onOpen} title={t('chat.exView')}>
        <MessagesSquare size={12} />
        <span className="tool-label">{label}</span>
        {suffix && <span className="tool-outcome">{suffix}</span>}
        <span className="relation-time">{formatStamp(first.createdAt)}</span>
        <ChevronRight size={12} />
      </button>
    </div>
  )
}

/** 私信交流详情浮窗:主进程从发起方会话重建的完整往返日志(两侧投影已去重) */
function ExchangeModal({ exchangeId, onClose }: { exchangeId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [detail, setDetail] = useState<ExchangeDetail | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let disposed = false
    api
      .exchangeDetail(exchangeId)
      .then((d) => {
        if (disposed) return
        if (d) setDetail(d)
        else setFailed(true)
      })
      .catch(() => {
        if (!disposed) setFailed(true)
      })
    return () => {
      disposed = true
    }
  }, [exchangeId])

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal exchange-modal">
        <div className="exchange-head">
          <h2>
            <MessagesSquare size={16} /> {t('chat.exTitle')}
          </h2>
          <button className="icon-btn ghost-btn sm" onClick={onClose} title={t('common.close')}>
            <X size={14} />
          </button>
        </div>
        {failed ? (
          <p className="modal-lead">{t('chat.exNotFound')}</p>
        ) : !detail ? (
          <p className="modal-lead">{t('common.loading')}</p>
        ) : (
          <>
            <div className="exchange-title">
              {detail.initiator} ↔ {detail.peer}
              <span className="relation-time">{formatStamp(detail.createdAt)}</span>
              {!detail.replied && <span className="file-badge gone">{t('chat.exNoReply')}</span>}
            </div>
            <div className="exchange-rounds">
              {detail.rounds.map((r, i) => (
                <div className="exchange-round" key={i}>
                  {/* 回信方的处理过程(思考+工具)挂在 TA 的回复轮内、正文上方(方案 C 二次拍板) */}
                  {r.from === detail.peer && detail.peerProcess && detail.peerProcess.length > 0 && (
                    <ExchangeProcessFold rows={detail.peerProcess} />
                  )}
                  <div className="exchange-round-head">
                    <span className="avatar dot" style={{ background: r.color ?? '#c4c4c4' }}>
                      {r.from.slice(0, 1)}
                    </span>
                    <span className="exchange-names">
                      {r.from} → {r.to}
                    </span>
                    <span className="relation-time">{formatStamp(r.createdAt)}</span>
                  </div>
                  <div className="exchange-round-body" data-quote-source="relation">
                    <Markdown content={r.content} />
                  </div>
                </div>
              ))}
              {/* 处理过但没有回复:过程折叠区挂在来信下方,不丢 */}
              {!detail.rounds.some((r) => r.from === detail.peer) &&
                detail.peerProcess &&
                detail.peerProcess.length > 0 && (
                  <ExchangeProcessFold rows={detail.peerProcess} noReply={detail.peerNoReply === true} />
                )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 私信浮窗内的「处理这封私信」折叠区:回信方静默回合的思考+工具时间线,默认收起。
 * 只有回信方的过程进浮窗;发起方的思考在发起方自己窗口的回合时间线里,两边各只出现一次。
 */
function ExchangeProcessFold({ rows, noReply = false }: { rows: ChatMessage[]; noReply?: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const start = Date.parse(rows[0]?.createdAt ?? '') || 0
  const end = Date.parse(rows[rows.length - 1]?.createdAt ?? '') || 0
  const tools = rows.filter((r) => r.kind === 'tool').length
  const label =
    t('chat.exHandled', { work: formatWork(Math.max(0, end - start), t) }) +
    (tools > 0 ? t('chat.actionsSuffix', { count: tools }) : '')
  return (
    <div className="exchange-process">
      <button type="button" className="turn-fold-sign" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Clock size={12} />
        <span>{label}</span>
        {noReply && <span className="exchange-noreply">{t('chat.exNoReplyText')}</span>}
        <ChevronRight size={12} className="turn-fold-chevron" data-open={open || undefined} />
      </button>
      {open && (
        <div className="turn-fold-body">
          {rows.map((r) =>
            r.kind === 'reasoning' ? (
              <Reasoning key={r.id} text={r.reasoning ?? ''} elapsedMs={(r.meta as ReasoningMeta | undefined)?.durationMs} />
            ) : r.kind === 'note' ? (
              <NoteLine key={r.id} message={r} />
            ) : r.kind === 'approval' ? (
              // 已决审批回执(2026-11-06):浮窗过程区也收全自动放行签,走共享审批签渲染
              <ApprovalChip key={r.id} message={r} />
            ) : (
              <ToolEventLine key={r.id} message={r} />
            )
          )}
        </div>
      )}
    </div>
  )
}

/** 危险命令 token 高亮(rm -rf / sudo 等,朴素前端规则,分类以主进程 classifyCommand 为准) */
function highlightDanger(cmd: string): ReactNode[] {
  const re = /\b(rm\s+-[a-zA-Z]*[rf][a-zA-Z]*|sudo|mkfs(?:\.\S+)?|dd\s+if=|chmod\s+777)\b/g
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd)) !== null) {
    if (m.index > last) out.push(cmd.slice(last, m.index))
    out.push(
      <span key={key++} className="ap-danger">
        {m[0]}
      </span>
    )
    last = m.index + m[0].length
  }
  if (last < cmd.length) out.push(cmd.slice(last))
  return out
}

/** 入住申请卡的头像底色:按名字散列到一组固定色,不引入新状态 */
function botColorFor(name: string): string {
  const palette = ['#2f6b63', '#7c3aed', '#2563eb', '#db2777', '#d97706', '#059669']
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]!
}

/** 审批 payload:按工具定制——命令高亮危险 token、写文件给路径+摘要、邀请居民给入住申请卡 */
function ApprovalPayload({ meta }: { meta: ApprovalMeta }) {
  const { t } = useTranslation()
  if (meta.toolName === 'run_command') {
    return (
      <div className="ap-payload">
        <div className="ap-cmd">
          <SquareTerminal size={13} />
          <code>{highlightDanger(meta.detail)}</code>
        </div>
      </div>
    )
  }
  if (meta.toolName === 'write_file' || meta.toolName === 'edit_file') {
    const lines = meta.detail.split('\n')
    const path = lines[0] ?? ''
    const rest = lines.slice(1).join('\n').trim()
    return (
      <div className="ap-payload">
        <div className="ap-path">
          <Folder size={12} />
          <code>{path}</code>
        </div>
        {rest && <div className="ap-summary">{rest}</div>}
      </div>
    )
  }
  if (meta.toolName === 'invite_resident') {
    const grab = (key: string): string =>
      meta.detail
        .split('\n')
        .find((l) => l.startsWith(key))
        ?.slice(key.length)
        .trim() ?? ''
    // locale:protocol —— 以下前缀与主进程 approval payload 的中文格式成对,是解析协议
    const name = grab('名字:') // locale:protocol
    const role = grab('角色:') // locale:protocol
    const persona = grab('人设:') // locale:protocol
    if (name) {
      return (
        <div className="ap-payload">
          <div className="ap-invite">
            <span className="ap-invite-avatar" style={{ background: botColorFor(name) }}>
              {name.slice(0, 2)}
            </span>
            <div className="ap-invite-info">
              <div className="ap-invite-name">
                {name}
                <span className="ap-invite-tag">{t('approval.apply')}</span>
              </div>
              {(role || persona) && (
                <div className="ap-invite-desc">
                  {[role ? t('approval.rolePrefix') + role : '', persona ? t('approval.personaPrefix') + persona : '']
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </div>
          </div>
        </div>
      )
    }
  }
  if (meta.toolName === 'create_skill' || meta.toolName === 'update_skill' || meta.toolName === 'install_skill') {
    const grab = (key: string): string =>
      meta.detail
        .split('\n')
        .find((l) => l.startsWith(key))
        ?.slice(key.length)
        .trim() ?? ''
    // locale:protocol —— 同上:主进程技能审批 payload 的中文键是解析协议
    const name = grab('技能:') // locale:protocol
    const creator = grab('创建者:') // locale:protocol
    const desc = grab('描述:') // locale:protocol
    const bodyIdx = meta.detail.indexOf('正文:\n') // locale:protocol
    const body = bodyIdx >= 0 ? meta.detail.slice(bodyIdx + '正文:\n'.length) : '' // locale:protocol
    const action =
      meta.toolName === 'create_skill'
        ? t('approval.actCreate')
        : meta.toolName === 'update_skill'
          ? t('approval.actUpdate')
          : t('approval.actLearn')
    if (name) {
      return (
        <div className="ap-payload">
          <div className="ap-invite">
            <span className="ap-invite-avatar skill">
              <Sparkles size={14} />
            </span>
            <div className="ap-invite-info">
              <div className="ap-invite-name">
                {name}
                <span className="ap-invite-tag">{action}</span>
              </div>
              <div className="ap-invite-desc">
                {[creator ? t('approval.creatorNote', { name: creator }) : '', desc].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
          {body && <pre className="ap-plain">{body}</pre>}
        </div>
      )
    }
  }
  return (
    <div className="ap-payload">
      <pre className="ap-plain">{meta.detail}</pre>
    </div>
  )
}

/** 审批决策面板(审批即输入):pending 时替换整个输入行,三档决策完交还输入框 */
function ApprovalPanel({
  bot,
  message,
  onDecide
}: {
  bot: Bot
  message: ChatMessage
  onDecide: (choice: 'allow' | 'deny' | 'turn' | 'always') => void | Promise<void>
}) {
  const { t } = useTranslation()
  const meta = message.meta as ApprovalMeta
  const isWinKeys = window.archipelago.platform === 'win32' // 卡面快捷键提示随平台(mac ⌘/win Ctrl)
  const [busy, setBusy] = useState(false)
  // 初值即按「已等待时长」算(2026-11-06 codex 审查修复:此前初值是 epoch 秒数,首帧闪一串十几亿)
  const [seconds, setSeconds] = useState(() =>
    Math.max(0, Math.round((Date.now() - (Date.parse(message.createdAt) || Date.now())) / 1000))
  )

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds(
        Math.max(0, Math.round((Date.now() - (Date.parse(message.createdAt) || Date.now())) / 1000))
      )
    }, 1000)
    return () => clearInterval(timer)
  }, [message.createdAt])

  function decide(choice: 'allow' | 'deny' | 'turn' | 'always'): void {
    if (busy) return
    setBusy(true)
    // 提交结束(含失败)解除面板 busy(2026-11-06 codex 审查修复:此前失败后按钮永久禁用;
    // 失败详情由 decideApproval 落到聊天区错误条,用户可重试或换一档决策)
    void Promise.resolve(onDecide(choice)).finally(() => setBusy(false))
  }

  return (
    <div className="approval-panel" role="alertdialog" aria-label={`${bot.name} ${meta.title}`}>
      <div className="ap-head">
        <ResidentAvatar appearance={bot.appearance} fallbackName={bot.name} fallbackColor={bot.color} size="small" />
        <div className="ap-head-text">
          <div className="ap-title">
            {bot.name} {meta.title}
          </div>
          <div className="ap-sub">{t('approval.sub', { secs: seconds })}</div>
        </div>
        <span className="ap-pill">
          <i className="ap-pulse" />
          {t('approval.pill')}
        </span>
      </div>
      <ApprovalPayload meta={meta} />
      <div className="ap-reason">
        <ShieldAlert size={12} />
        {meta.reason}
      </div>
      <div className="ap-actions">
        <span className="ap-hint">
          <Lock size={11} /> {t('approval.inputHint')}
        </span>
        <button className="btn ap-deny" disabled={busy} onClick={() => decide('deny')}>
          {t('approval.deny')} <kbd>Esc</kbd>
        </button>
        <button className="btn ap-turn" disabled={busy} onClick={() => decide('turn')}>
          {t('approval.turn')} <kbd>{isWinKeys ? 'Ctrl+Enter' : '⌘⏎'}</kbd>
        </button>
        <button className="btn primary" disabled={busy} onClick={() => decide('allow')}>
          {t('approval.allow')} <kbd>⏎</kbd>
        </button>
        {bot.permission === 'semi' && !meta.noAlways && (
          <button className="btn ap-always" disabled={busy} onClick={() => decide('always')}>
            {t('approval.always')} <kbd>{isWinKeys ? 'Alt+Enter' : '⌥⏎'}</kbd>
          </button>
        )}
      </div>
    </div>
  )
}

/** 审批小签(消息流内,与工具/私信事件行同语言):pending=等待签,决策后=回执签,点开浮窗看详情 */
function ApprovalChip({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const meta =
    (message.meta as ApprovalMeta | undefined) ?? {
      approvalId: '',
      toolName: '',
      title: t('approval.fallbackTitle'),
      detail: '',
      reason: '',
      status: 'pending' as const
    }
  const [open, setOpen] = useState(false)
  const [flipDown, setFlipDown] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  const isPending = meta.status === 'pending'
  // auto-approved=全自动档自动放行的留痕签(ok 绿);escalatedTo=点「以后全自动」后本卡盖的转档章
  const ok = meta.status === 'approved' || meta.status === 'turn-allowed' || meta.status === 'auto-approved'
  const label = isPending
    ? t('approval.chipPending')
    : meta.status === 'turn-allowed'
      ? t('approval.chipTurn')
      : meta.status === 'auto-approved'
        ? t('approval.chipAuto')
        : meta.status === 'approved'
          ? meta.escalatedTo === 'auto'
            ? t('approval.chipAllowedAuto')
            : t('approval.chipAllowed')
          : meta.status === 'denied'
            ? t('approval.chipDenied')
            : t('approval.chipAborted')
  const summary = meta.toolName === 'run_command' ? meta.detail.replace(/\s+/g, ' ') : meta.title

  // 点浮窗外收起
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.approval-line')) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // 打开浮窗时测一次:签离消息滚动区顶部太近(向上放不下)就翻转向下弹,
  // 否则浮窗会被滚动容器顶边裁掉、看起来被消息区顶栏压住(2026-10-25 评审发现)
  useEffect(() => {
    if (!open) return
    const chip = chipRef.current
    const scroller = chip?.closest('.chat-body')
    if (!chip || !scroller) return
    const c = chip.getBoundingClientRect()
    const s = scroller.getBoundingClientRect()
    setFlipDown(c.top - s.top < 340)
  }, [open])

  return (
    <span className="approval-line">
      <button
        ref={chipRef}
        className={`approval-chip ${isPending ? 'waiting' : ok ? 'ok' : 'no'}`}
        title={isPending ? t('approval.titlePending') : t('approval.titleDetail')}
        onClick={() => !isPending && setOpen((v) => !v)}
      >
        {isPending ? (
          <Hourglass size={12} />
        ) : ok ? (
          <ShieldCheck size={12} />
        ) : (
          <ShieldX size={12} />
        )}
        <span className="ac-label">{label}</span>
        {!isPending && (
          <>
            <span>·</span>
            <code>{summary.length > 60 ? `${summary.slice(0, 60)}…` : summary}</code>
            <span className="ac-time">{formatStamp(meta.decidedAt ?? message.createdAt)}</span>
            <ChevronRight size={11} />
          </>
        )}
      </button>
      {open && !isPending && (
        <div className={`approval-pop ${flipDown ? 'flip' : ''}`} role="dialog" aria-label={t('approval.titleDetail')}>
          <div className="apop-title">{t('approval.titleDetail')}</div>
          <dl className="apop-list">
            <div className="apop-row">
              <dt>{t('approval.popStatus')}</dt>
              <dd>
                <span className={`apop-status ${ok ? '' : 'no'}`}>{label}</span>
              </dd>
            </div>
            <div className="apop-row">
              <dt>{t('approval.popTool')}</dt>
              <dd>
                <code>{meta.toolName || '—'}</code>
              </dd>
            </div>
            {meta.detail && (
              <div className="apop-row">
                <dt>{t('approval.popContent')}</dt>
                <dd>
                  <code>{meta.detail}</code>
                </dd>
              </div>
            )}
            {meta.reason && (
              <div className="apop-row">
                <dt>{t('approval.popReason')}</dt>
                <dd>{meta.reason}</dd>
              </div>
            )}
            <div className="apop-row">
              <dt>{t('approval.popReqAt')}</dt>
              <dd>{formatStamp(message.createdAt)}</dd>
            </div>
            {meta.decidedAt && (
              <div className="apop-row">
                <dt>{t('approval.popDecAt')}</dt>
                <dd>{formatStamp(meta.decidedAt)}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </span>
  )
}
