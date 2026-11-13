import { randomUUID } from 'node:crypto'
import { BrowserWindow, Notification, type WebContents } from 'electron'
import type { Bot, ChatMessage, ChatQuote, MessageAttachment, ProviderInfo, RelationMeta, ToolEventMeta } from '@shared/types'
import { currentIslandUid, currentSeaToken, seaRelayBaseUrl } from './auth'
import { sanitizeQuotes } from '@shared/quote-core'
import { getProvider } from '@shared/providers'
import { EV } from '@shared/ipc-channels'
import { archetypeName } from '@shared/archetypes'
import type {
  ChatActivityEvent,
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatStoppedEvent,
  ChatStepEvent,
  ChatUserAddedEvent
} from '@shared/ipc-channels'
import { getBot, listBots } from './bots'
import { chatStream, ContextTooLongError, llmContentChars, reasoningEchoValue, type LlmContentPart, type LlmMessage, type ToolSpec, type UsageInfo, RelayError } from './llm'
import { createRetryBudget } from './upstream-retry'
import { isImageUnsupportedError, readImageDataUrl } from './attachments'
import { reviewTurn } from './memory'
import { getApiKey } from './secrets'
import { getSpace } from './space'
import { resolveBotPath } from './fs-tools'
import { finishToolEvent, getOrCreateSession, getOrCreateTaskSession, insertMessage, listMessages, type SessionRow } from './sessions'
import { getDb, metaGet, metaSet, nowIso } from './store'
import { buildContextMessages, compactIfNeeded, forceCompact, recordPromptUsage } from './steward'
import { clearTurnApprovals } from './approval'
import { executeTool, toolsFor } from './tools'
import { getTaskThread, TASK_THREAD_BRIEF, taskWorkdirBriefOf, tryGenerateTaskThreadTitle, type TaskExecBase } from './task-threads'
import { ensureWorkdirReady, finalizeTaskTurn } from './task-workdir'
import { mcpToolEventKey, warmMcpToolsForBot } from './mcp'
import {
  MAX_STEPS,
  EXHAUST_WARN_AHEAD,
  EXHAUST_REMINDER,
  EXHAUST_SUFFIX_CHAT,
  EXHAUST_SUFFIX_TASK,
  REPEAT_REMINDER,
  createRepeatGuard,
  noteToolCall,
  toolCallSignature
} from './turn-guard'

// 单聊会话 + agent loop(M3 流式 / M2.1 对话建 Bot / §7.2 居民私信的 R0 子集)
// 一次回合 = 至多 MAX_STEPS 步"模型 → 工具 → 模型"循环;
// 居民间私信走 hidden 回合(写入对方上下文,不进用户界面);
// 通报(expects_reply=false,件 3)不等待:落库即返回,对方空闲立即消化/忙则当前回合
// 结束后合批消化一次(N 条积压 = 1 个回合)——见 scheduleDigest/runDigest
// 有影响的工具(写文件/执行命令/联网)在居民单聊里落 kind='tool' 事件行,实时可见(铁律 1)

// visible=用户可见回合(岛主发消息触发、会发 ChatDone/ChatStopped/ChatError 的那种);
// 静默回信/通报消化等后台回合 visible=false——它们进行中时单聊界面保持可发可停的原状(第四十五轮拍板)。
// kind=回合类型(2026-10-30 列表实时状态):消息列表据此显示「正在想/回信中/做任务中」分层文案;
// 后台回合虽不进单聊界面,列表行照常亮——「谁在忙」从此对岛主可见
//
// 键=回合所属线程(2026-11-06「新建任务」线程键化):普通单聊(含私信/定时任务)用 botId,
// 任务会话用 task:<threadId>——同一居民的单聊与多个任务会话可并行各跑各的回合,互不占用
// (群聊侧 groupActive 的 "groupId:botId" 复合键是同款先例)。
const active = new Map<string, { controller: AbortController; visible: boolean; kind: TurnKind }>()

// 回合进行中的 promise(2026-11-10 可等待停止):结束任务的握手要等当前回合连同 finalize
// 一起收完再动工作树;键与 active 同款。注册发生在 runTurn 调 runTurnInner 之后(两行之间
// 无 await,单线程下不可能有停止请求插进来,窗口闭合)
const turnWaiters = new Map<string, Promise<unknown>>()

/** 结束任务握手进行中的线程:新回合一律拒绝(先停干净再归档) */
const closingThreads = new Set<string>()

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 单聊回合类型:列表 busy 文案的分层依据(relation/digest 同显「回信中」);
 *  任务会话回合恒用 'chat'(列表 busy 文案由渲染端直接映射);定时任务回合用 'scheduled'
 *  (2026-11-06 自 'task' 更名:任务会话上线后 'task' 字面量归任务会话族所有,防 future agent 混淆) */
export type TurnKind = 'chat' | 'relation' | 'digest' | 'scheduled'

/** 任务会话回合在 active 注册表里的键 */
function taskKey(threadId: string): string {
  return `task:${threadId}`
}

/** 回合生命周期广播(2026-10-30 列表实时状态):active 增删处调用,渲染端重查 busy 真态 */
function broadcastTurnChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EV.TurnChanged)
}

/** 各线程进行中回合的类型快照(列表预览聚合用):键=botId(普通单聊)或 task:<threadId>(任务会话),
 *  空闲线程不在返回里 */
export function activeTurnKinds(): Map<string, TurnKind> {
  return new Map([...active].map(([key, entry]) => [key, entry.kind]))
}

// ---- 私信三队列(件 3 通报消化 / 2026-11-05 回复唤醒:排队回信 + 唤醒转述)----
// 都是内存态,重启即静默——消息本体已落库进上下文,该居民下次任何回合自然看到(拍板 6);
// 三个队列共用「空闲立即起回合、忙则等当前回合结束再泵」的节拍(runTurn 收尾统一泵)

// 通报消化:只存「有待消化」信号与最近一条往来(合批语义,N 条积压=1 个回合)
const digestPending = new Map<string, { peer: string; exchangeId?: string }>()

function runDigest(botId: string): void {
  if (!digestPending.has(botId) || active.has(botId)) return
  const info = digestPending.get(botId)
  if (!info) return
  digestPending.delete(botId)
  const bot = getBot(botId)
  if (!bot) return
  // 与回信回合同款(depth=1:无 send_message、可 post_to_group 上墙);
  // 不等待、失败不重试——通报已在上下文,时机自然补
  void runTurn(bot, {
    depth: 1,
    silent: true,
    kind: 'digest',
    relation: { peer: info.peer, exchangeId: info.exchangeId }
  })
    .catch((err) => console.error('[chat] 通报消化回合失败:', err))
    .finally(() => pumpQueues(botId))
}

/** 通报落库后登记消化(件 3):空闲立即消化,忙则排队、当前回合结束(runTurn 收尾)合批 */
export function scheduleDigest(botId: string, peer: string, exchangeId?: string): void {
  digestPending.set(botId, { peer, exchangeId })
  pumpQueues(botId)
}

// 排队回信(回复唤醒拍板 2):等回信的私信遇到 B 忙时入队,B 当前回合结束即回信——
// 消灭旧同步路径「信已落库却说没回应」的半吊子态;同一对话的合批语义保留(最新一封为代表,
// 信都在上下文)。2026-11-06 codex 审查修复:单槽会被下一封跨对话来信覆盖(那位发起方
// 永远等不到回信与唤醒),改为按居民的队列——同 peer 尾部合批、跨 peer 各自排队
const replyPending = new Map<string, { peer: string; exchangeId: string }[]>()

function runPendingReply(botId: string): void {
  if (active.has(botId)) return
  const list = replyPending.get(botId)
  const info = list?.shift()
  if (!info) return
  const bot = getBot(botId)
  if (!bot) return
  void runTurn(bot, {
    depth: 1,
    silent: true,
    relation: { peer: info.peer, exchangeId: info.exchangeId }
  })
    .catch((err) => console.error('[chat] 排队回信回合失败:', err))
    .finally(() => pumpQueues(botId))
}

/** 等回信私信的回信回合入口(回复唤醒,2026-11-05):B 空闲立即回信,忙则排队;
 *  回信落地/没回上来的收尾统一在 runTurnInner 触发发起方唤醒(settleReplyWake) */
export function startReplyTurn(bot: Bot, peer: string, exchangeId: string): void {
  queueReply(bot.id, peer, exchangeId)
}

/** 回信入队(按 botId;崩溃恢复按落库行重建时也走这里)。同 peer 连续来信合批
 *  (最新一封为代表,信都在 B 上下文里);跨 peer 各自排队不覆盖 */
function queueReply(botId: string, peer: string, exchangeId: string): void {
  const list = replyPending.get(botId) ?? []
  const last = list[list.length - 1]
  if (last && last.peer === peer) list[list.length - 1] = { peer, exchangeId }
  else list.push({ peer, exchangeId })
  replyPending.set(botId, list)
  pumpQueues(botId)
}

// 唤醒转述(回复唤醒):B 的回信落地后给发起方排的「去向岛主转述」回合;FIFO 不合批
// (拍板 5:多封信齐回各自唤醒各自转述,消息更清晰)。
// 失败重试(2026-11-05 兜底拍板):网络/模型故障回队重试,至多 3 次、间隔 30s
// (notBefore 未到让泵跳过留着,到点定时器再泵);耗尽放弃——回复投影行已落库可见,不黑洞。
// threadId(2026-11-06「新建任务」):任务里托人办事的交流,唤醒转述回那个任务回合
const wakePending = new Map<string, { peer: string; exchangeId?: string; brief: string; attempts?: number; notBefore?: number; threadId?: string }[]>()

/** 唤醒重试间隔(测试可用 QD_WAKE_RETRY_DELAY_MS 环境变量调小) */
const WAKE_RETRY_DELAY_MS = Number(process.env.QD_WAKE_RETRY_DELAY_MS ?? 30_000)

function runWake(botId: string): void {
  const list = wakePending.get(botId)
  if (!list || list.length === 0 || active.has(botId)) return
  const info = list.shift()
  if (!info) return
  // 重试冷却未到:放回队首留给下一泵(30s 定时器到点会再泵)
  if (info.notBefore !== undefined && info.notBefore > Date.now()) {
    list.unshift(info)
    return
  }
  // 任务会话出处(2026-11-06「新建任务」):任务里托人办事,回信转述回那个任务(上下文与岛主
  // 都在那里);任务已归档则回落单聊转述,不黑洞。任务线程里还有进行中回合时留队首,下轮泵再起
  let threadId = info.threadId
  if (threadId) {
    const thread = getTaskThread(threadId)
    if (!thread || thread.status !== 'open') threadId = undefined
  }
  if (threadId && active.has(taskKey(threadId))) {
    list.unshift(info)
    return
  }
  if (list.length === 0) wakePending.delete(botId)
  const bot = getBot(botId)
  if (!bot) return
  // 形状对齐定时任务回合:后台触发但对岛主开口——流式可见、可停、失焦通知;
  // depth 1 无 send_message(防环);收尾广播 ChatSync 让侧栏/预览都能刷到这次主动开口
  const win = BrowserWindow.getAllWindows()[0]
  void runTurn(bot, {
    depth: 1,
    silent: false,
    sender: win?.webContents,
    kind: 'relation',
    relay: { peer: info.peer, exchangeId: info.exchangeId, brief: info.brief },
    thread: threadId ? { threadId } : undefined
  })
    .then((r) => {
      if (!r.ok && (info.attempts ?? 0) < 2) {
        const retry = [...(wakePending.get(botId) ?? [])]
        retry.unshift({ ...info, attempts: (info.attempts ?? 0) + 1, notBefore: Date.now() + WAKE_RETRY_DELAY_MS })
        wakePending.set(botId, retry)
        setTimeout(() => pumpQueues(botId), WAKE_RETRY_DELAY_MS)
      }
    })
    .catch((err) => console.error('[chat] 唤醒转述回合失败:', err))
    .finally(() => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send(EV.ChatSync, { botId } satisfies { botId: string })
      }
      pumpQueues(botId)
    })
}

/** 回合收尾统一泵三个私信队列:谁先到谁先起,另一个因 active 占用留在队列下次再泵 */
function pumpQueues(botId: string): void {
  runDigest(botId)
  runPendingReply(botId)
  runWake(botId)
}

/** 唤醒 brief 构造(在线路径与崩溃恢复同款):回信原文随 brief 挂上下文尾部 */
function relayBrief(peer: string, replyText: string, noReply: boolean, failed: boolean): string {
  if (noReply)
    return `你之前用私信联系「${peer}」,TA 处理了但没有回上来${failed ? '(回合出了问题)' : ''}。用一两句话如实向岛主转述这个结果,不编造内容。`
  return `「${peer}」的回信到了:\n${replyText}\n\n用一两句话向岛主转述要点;若岛主当初的交代里还有后续动作(存文件/发到群里等),按交代继续做完再汇报。`
}

/**
 * 按交流 id 找回任务会话出处(2026-11-06「新建任务」):发起方「发给」行的 meta 记了 threadId
 * (send_message 落投影时写入)——回信投影与唤醒转述按它回那个任务。任务已归档视为无出处
 * (回落单聊,不复活已结束的任务);查无出处(普通单聊私信)照旧单聊。
 */
function exchangeThreadOf(exchangeId?: string): string | undefined {
  if (!exchangeId) return undefined
  try {
    const row = getDb()
      .prepare(
        `SELECT meta FROM messages WHERE kind = 'relation' AND exchange_id = ? AND meta LIKE '%"dir":"out"%' ORDER BY id LIMIT 1`
      )
      .get(exchangeId) as { meta: string | null } | undefined
    const threadId = row?.meta ? (JSON.parse(row.meta) as RelationMeta).threadId : undefined
    if (!threadId) return undefined
    return getTaskThread(threadId)?.status === 'open' ? threadId : undefined
  } catch {
    return undefined
  }
}

/**
 * 回信落地后的发起方收尾(回复唤醒,2026-11-05 拍板):往发起方会话落「收到回复」投影行
 * (没回上来也落 noReply 标记行——A 侧交流签亮「未获回应」,比旧路径可见),并排一个
 * 唤醒回合让发起方去向岛主转述。按名字找不到发起方(改名/离岛竞态)只记日志跳过——
 * 回信本体在回信方自己的会话里,不黑洞。
 * 投影与唤醒都落「发起交流的会话」(2026-11-06):任务里托人办事回那个任务,普通私信回单聊。
 */
function settleReplyWake(
  bot: Bot,
  info: { peer: string; exchangeId?: string; replyText: string; noReply?: boolean; failed?: boolean }
): void {
  const initiator = listBots().find((b) => b.name === info.peer) // listBots 已滤离岛(软删)居民
  if (!initiator) {
    console.warn(`[chat] 回信唤醒:发起方「${info.peer}」已不在岛上,跳过唤醒与回执行`)
    return
  }
  const threadId = exchangeThreadOf(info.exchangeId)
  const session = threadId ? getOrCreateTaskSession(initiator.id, threadId) : getOrCreateSession(initiator.id)
  insertMessage(
    session.id,
    'assistant',
    info.noReply ? '' : `[来自 ${bot.name} 的回复] ${info.replyText.trim()}`,
    null,
    false,
    'relation',
    info.noReply
      ? { dir: 'reply-in', peer: bot.name, noReply: true, ...(threadId ? { threadId } : {}) }
      : { dir: 'reply-in', peer: bot.name, ...(threadId ? { threadId } : {}) },
    info.exchangeId
  )
  const list = wakePending.get(initiator.id) ?? []
  list.push({
    peer: bot.name,
    exchangeId: info.exchangeId,
    brief: relayBrief(bot.name, info.replyText.trim(), info.noReply === true, info.failed === true),
    ...(threadId ? { threadId } : {})
  })
  wakePending.set(initiator.id, list)
  pumpQueues(initiator.id)
}

/**
 * 崩溃恢复(回复唤醒兜底,2026-11-05 拍板):App 退出/崩溃丢掉的内存队列,从落库行重建——
 * ①信未回:B 侧有 'in' 行但该交流一直没有 reply 行(等回信的信回队、通报走消化队列,
 *   以来信行的「·通报」协议标记分流);②回信未转述:A 侧有唤醒路径落的 reply-in 投影行
 *   (turn_id 为空=异步路径的标记,同步时代投影行必带回合 id),但该交流没有转述消息(meta.relay)。
 * 两扫都只看 epoch 之后的行(首次挂载置位,旧版本存量交流一概不动,防升级首启连环误唤醒);
 * 恢复动作=重新入队,与在线路径同一套泵。挂载点=auth.mount(登录/开机解锁/认领统一入口)。
 */
export function recoverReplyWake(): void {
  // 换账号挂载:内存队列可能还压着旧账号的条目,先清干净(getBot 查不到也会被各 runner 丢弃,双保险)
  digestPending.clear()
  replyPending.clear()
  wakePending.clear()
  const epochKey = 'replyWake.epoch'
  const epoch = metaGet<string>(epochKey)
  if (!epoch) {
    metaSet(epochKey, nowIso())
    return
  }
  interface ScanRow {
    id: number
    bot_id: string
    content: string
    kind: string
    meta: string | null
    exchange_id: string | null
    turn_id: string | null
  }
  const rows = getDb()
    .prepare(
      `SELECT m.id, s.bot_id, m.content, m.kind, m.meta, m.exchange_id, m.turn_id FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE m.kind IN ('relation', 'chat') AND m.created_at >= ? ORDER BY m.id ASC`
    )
    .all(epoch) as ScanRow[]
  type ScanMeta = { dir?: string; peer?: string; noReply?: boolean; relay?: { exchangeId?: string }; threadId?: string }
  const metaOf = (r: ScanRow): ScanMeta => {
    try {
      return r.meta ? (JSON.parse(r.meta) as ScanMeta) : {}
    } catch {
      return {}
    }
  }
  // 已回复的交流(任意 reply 行)/已转述的交流(relay 消息)——两扫的排除集
  const replied = new Set<string>()
  const relayed = new Set<string>()
  for (const r of rows) {
    if (r.kind !== 'relation' || !r.exchange_id) continue
    const meta = metaOf(r)
    if (meta.dir === 'reply') replied.add(r.exchange_id)
  }
  for (const r of rows) {
    if (r.kind !== 'chat') continue
    const meta = metaOf(r)
    const ex = meta.relay?.exchangeId
    if (ex) relayed.add(ex)
  }
  let recovered = 0
  // ① 信未回:每居民×对话取最新一封(同对话多封都在 B 上下文里,一个回信回合读得见;
  //   跨对话各取各的,旧交流下次挂载再收敛)
  const latestLetter = new Map<string, ScanRow & { peer: string }>()
  for (const r of rows) {
    if (r.kind !== 'relation' || !r.exchange_id || r.exchange_id === '') continue
    const meta = metaOf(r)
    if (meta.dir !== 'in' || replied.has(r.exchange_id)) continue
    if (typeof meta.peer !== 'string') continue
    latestLetter.set(`${r.bot_id}:${meta.peer}`, { ...r, peer: meta.peer })
  }
  for (const [, letter] of latestLetter) {
    const bot = getBot(letter.bot_id)
    if (!bot) continue
    if (letter.content.includes('·通报]')) scheduleDigest(letter.bot_id, letter.peer, letter.exchange_id ?? undefined)
    else queueReply(letter.bot_id, letter.peer, letter.exchange_id ?? '')
    recovered++
  }
  // ② 回信未转述:turn_id 为空的 reply-in(异步路径标记)且该交流没有 relay 消息
  const latestWake = new Map<string, ScanRow & { peer: string }>()
  for (const r of rows) {
    if (r.kind !== 'relation' || !r.exchange_id || r.turn_id !== null) continue
    const meta = metaOf(r)
    if (meta.dir !== 'reply-in' || relayed.has(r.exchange_id)) continue
    if (typeof meta.peer !== 'string') continue
    latestWake.set(`${r.bot_id}:${r.exchange_id}`, { ...r, peer: meta.peer })
  }
  for (const [, w] of latestWake) {
    const meta = metaOf(w)
    const text = w.content.replace(/^\[[^\]]*\]\s*/, '')
    const list = wakePending.get(w.bot_id) ?? []
    // 任务会话出处(2026-11-06):reply-in 投影行 meta 记的 threadId——重建的唤醒转述回那个任务
    list.push({
      peer: w.peer,
      exchangeId: w.exchange_id ?? undefined,
      brief: relayBrief(w.peer, text, meta.noReply === true, false),
      ...(typeof meta.threadId === 'string' ? { threadId: meta.threadId } : {})
    })
    wakePending.set(w.bot_id, list)
    pumpQueues(w.bot_id)
    recovered++
  }
  // ③ 回信已落、发起方投影未落(2026-11-06 codex 审查修复):回信行与 settleReplyWake 的
  //   reply-in 投影分两次写,中间崩溃/退出会让两扫都跳过它(①被 reply 行排除、②要 reply-in
  //   才命中)——唤醒永久丢失。补收尾:有 reply 行但该交流既无 reply-in 投影也没转述过的,
  //   按落库行重建投影+唤醒(与在线路径同一收尾函数,任务出处/归档回落语义天然一致)
  const projected = new Set<string>()
  for (const r of rows) {
    if (r.kind !== 'relation' || !r.exchange_id) continue
    if (metaOf(r).dir === 'reply-in') projected.add(r.exchange_id)
  }
  const orphanReply = new Map<string, ScanRow>()
  for (const r of rows) {
    if (r.kind !== 'relation' || !r.exchange_id) continue
    const meta = metaOf(r)
    if (meta.dir !== 'reply' || projected.has(r.exchange_id) || relayed.has(r.exchange_id)) continue
    orphanReply.set(`${r.bot_id}:${r.exchange_id}`, r)
  }
  for (const [, reply] of orphanReply) {
    const replier = getBot(reply.bot_id)
    const meta = metaOf(reply)
    if (!replier || typeof meta.peer !== 'string') continue
    settleReplyWake(replier, {
      peer: meta.peer,
      exchangeId: reply.exchange_id ?? undefined,
      replyText: reply.content.replace(/^\[[^\]]*\]\s*/, ''),
      noReply: meta.noReply === true
    })
    recovered++
  }
  if (recovered > 0) console.log(`[chat] 回复唤醒崩溃恢复:重建 ${recovered} 项待办(信未回/回信未转述/投影未落)`)
}

export function stopStream(botId: string): void {
  active.get(botId)?.controller.abort(new Error('stopped'))
}

/** 停止任务会话里进行中的回合(键=task:<threadId>,与单聊互不干扰) */
export function stopTaskThread(threadId: string): void {
  active.get(taskKey(threadId))?.controller.abort(new Error('stopped'))
}

/**
 * 可等待停止(2026-11-10 第一批;codex 评审 M4/M5 修订):abort → 等子进程与回合收尾(含
 * finalize,killTree 的 2s 强杀升级也在等待内)。返回**是否真正停下**——超时不假装成功,
 * 由调用方(ipc 结束流程)决定放行还是中止收尾;closing 标记的生命周期归 begin/end 对
 * (覆盖停止→清理→归档全程,期间的唤醒回合在 runTurnInner 入口被拒,归档后按既有规则回落单聊)。
 */
export async function stopAndAwaitTaskThread(threadId: string, timeoutMs = 30_000): Promise<boolean> {
  active.get(taskKey(threadId))?.controller.abort(new Error('stopped'))
  const running = turnWaiters.get(taskKey(threadId))
  if (!running) return true
  try {
    await Promise.race([running.then(() => undefined, () => undefined), delay(timeoutMs)])
    return true
  } catch {
    return false
  }
}

/** 结束流程开始:拒绝该线程的新回合(sendTaskThreadMessage 与 runTurnInner 入口都查) */
export function beginTaskThreadClose(threadId: string): void {
  closingThreads.add(threadId)
}

/** 结束流程完成(归档之后):恢复该线程接受新回合(若仍 open,例如收尾中止) */
export function endTaskThreadClose(threadId: string): void {
  closingThreads.delete(threadId)
}

/** 结束握手进行中(新回合应被拒) */
export function isTaskThreadClosing(threadId: string): boolean {
  return closingThreads.has(threadId)
}

/** 该居民是否正在回合中(定时任务调度器用:忙时顺延,不与岛主的对话互踩);
 *  只看居民单聊线程——任务会话回合不算「居民在忙」(并行的本意,定时任务照常跑自己的单聊上下文) */
export function isTurnActive(botId: string): boolean {
  return active.has(botId)
}

/** 该居民是否有用户可见回合在进行(单聊界面据此恢复停止键:切走再切回/重载后 busy 丢失的兜底真态) */
export function isUserTurnActive(botId: string): boolean {
  return active.get(botId)?.visible === true
}

export function getHistory(botId: string): {
  sessionId: string
  messages: ChatMessage[]
  turnActive: boolean
  /** 进行中回合的类型(空闲缺省;#34):'relation'/'digest'=正在静默回私信,渲染端据此亮「回信中」签的运行态 */
  turnKind?: TurnKind
} {
  const session = getOrCreateSession(botId)
  const current = active.get(botId)
  return {
    sessionId: session.id,
    messages: listMessages(session.id, false),
    turnActive: current?.visible === true,
    turnKind: current?.kind
  }
}

/** 任务会话历史(形状同 getHistory):消息取任务会话自己的,turnActive 看 task:<threadId> 真态 */
export function getTaskThreadHistory(threadId: string): {
  sessionId: string
  messages: ChatMessage[]
  turnActive: boolean
  turnKind?: TurnKind
} {
  const thread = getTaskThread(threadId)
  if (!thread) throw new Error('任务不存在')
  const session = getOrCreateTaskSession(thread.botId, threadId)
  const current = active.get(taskKey(threadId))
  return {
    sessionId: session.id,
    messages: listMessages(session.id, false),
    turnActive: current?.visible === true,
    turnKind: current?.kind
  }
}

function safeParseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ---- 工具动作事件行 ----
// 只给有影响的工具落行:写文件、执行命令、联网;纯读取类(read_file/list_dir/find/search/read_own_chat)
// 是过程噪音不单独展示;send_message 已有私信事件行、invite_resident 已有审批卡,不重复

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 双语(2026-10-30):label/outcome 的结构化形态——k=渲染端词典 key(chat.tool.* / chat.out.*),
 *  随 meta 存库(labelK/outcomeK);渲染端优先读结构化 key,切语言后新旧行都按当前语言显示。
 *  中文正文/摘要仍照旧落 content 与 outcome(存量显示与既有协议匹配的依据),由下方 zh 渲染器现算,
 *  与旧版输出逐字节一致。 */
type ToolKey = { k: string; p?: Record<string, string | number> }

/** 主进程侧 zh 渲染器:key → 中文模板插值;与渲染端 zh 词典 chat.tool.* 成对维护 */
const TOOL_ZH: Record<string, string> = {
  'chat.tool.write': '写入 {{file}}',
  'chat.tool.edit': '编辑 {{file}}',
  'chat.tool.run': '执行 {{cmd}}',
  'chat.tool.search': '搜索「{{q}}」',
  'chat.tool.fetch': '读网页 {{url}}',
  'chat.tool.setTask': '登记任务 {{title}}',
  'chat.tool.updTask': '改动任务 {{title}}',
  'chat.tool.delTask': '取消任务 {{title}}',
  'chat.tool.mcp': '用了 {{svc}} · {{tool}}',
  'chat.out.denied': '被拒',
  'chat.out.aborted': '已中止',
  'chat.out.wrote': '{{n}} 字符',
  'chat.out.notWritten': '未写入',
  'chat.out.replaced': '{{n}} 处',
  'chat.out.notModified': '未修改',
  'chat.out.exit': 'exit {{code}} · {{secs}}',
  'chat.out.secs': '{{secs}}',
  'chat.out.done': '完成',
  'chat.out.noResults': '无结果',
  'chat.out.failed': '失败',
  'chat.out.registered': '已登记',
  'chat.out.updated': '已改',
  'chat.out.canceled': '已取消',
  'chat.out.notDone': '未成'
}

function renderToolKeyZh(key: ToolKey): string {
  const tpl = TOOL_ZH[key.k] ?? ''
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, n: string) => String(key.p?.[n] ?? ''))
}

/** label 的结构化 key;返回 null = 该工具不落行 */
export function toolEventLabelKey(name: string, args: Record<string, unknown>): ToolKey | null {
  if (name === 'write_file' || name === 'edit_file') {
    const p = String(args.path ?? '').trim()
    if (!p) return null
    const base = p.slice(p.lastIndexOf('/') + 1) || p
    return { k: name === 'write_file' ? 'chat.tool.write' : 'chat.tool.edit', p: { file: clip(base, 48) } }
  }
  if (name === 'run_command') {
    const c = String(args.command ?? '').trim().replace(/\s+/g, ' ')
    return c ? { k: 'chat.tool.run', p: { cmd: clip(c, 56) } } : null
  }
  if (name === 'web_search') {
    const q = String(args.query ?? '').trim()
    return q ? { k: 'chat.tool.search', p: { q: clip(q, 28) } } : null
  }
  if (name === 'web_fetch') {
    const u = String(args.url ?? '').trim()
    if (!u) return null
    let shown = u
    try {
      const parsed = new URL(u)
      shown = parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname)
    } catch {
      // 非法 URL 原样显示
    }
    return { k: 'chat.tool.fetch', p: { url: clip(shown, 48) } }
  }
  // 定时任务三工具(2026-10-29):登记/改动是「答应过的任务」的可见凭据,落行让岛主当场看到
  if (name === 'set_task' || name === 'update_task' || name === 'cancel_task') {
    const t = String(args.title ?? args.task ?? '').trim()
    const k = name === 'set_task' ? 'chat.tool.setTask' : name === 'update_task' ? 'chat.tool.updTask' : 'chat.tool.delTask'
    return t ? { k, p: { title: clip(t, 40) } } : null
  }
  return null
}

/** 事件行文案(动作 + 对象,中文);返回 null = 该工具不落行 */
export function toolEventLabel(name: string, args: Record<string, unknown>): string | null {
  const key = toolEventLabelKey(name, args)
  return key ? renderToolKeyZh(key) : null
}

/** 收尾摘要的结构化 key */
export function toolEventOutcomeKey(
  name: string,
  args: Record<string, unknown>,
  result: string,
  elapsedMs: number
): ToolKey {
  if (/岛主拒绝了|岛主没有同意/.test(result)) return { k: 'chat.out.denied' }
  if (/本次回合已停止|回合被停止/.test(result)) return { k: 'chat.out.aborted' }
  if (name === 'write_file') {
    return result.startsWith('已写入')
      ? { k: 'chat.out.wrote', p: { n: String(args.content ?? '').length } }
      : { k: 'chat.out.notWritten' }
  }
  if (name === 'edit_file') {
    const m = result.match(/^已替换 (\d+) 处/)
    return m ? { k: 'chat.out.replaced', p: { n: m[1]! } } : { k: 'chat.out.notModified' }
  }
  if (name === 'run_command') {
    const secs = `${(elapsedMs / 1000).toFixed(1)}s`
    const m = result.match(/\[exit code: (\w+)\]\s*$/)
    return m ? { k: 'chat.out.exit', p: { code: m[1]!, secs } } : { k: 'chat.out.secs', p: { secs } }
  }
  if (name === 'web_search') {
    return result.startsWith('[联网搜索结果')
      ? { k: 'chat.out.done' }
      : result.startsWith('没搜到')
        ? { k: 'chat.out.noResults' }
        : { k: 'chat.out.failed' }
  }
  if (name === 'set_task' || name === 'update_task' || name === 'cancel_task') {
    if (result.startsWith('已登记')) return { k: 'chat.out.registered' }
    if (result.startsWith('已改好')) return { k: 'chat.out.updated' }
    if (result.startsWith('已取消')) return { k: 'chat.out.canceled' }
    return { k: 'chat.out.notDone' }
  }
  return /^(抓取失败|读取失败|失败|无法)/.test(result) ? { k: 'chat.out.failed' } : { k: 'chat.out.done' }
}

/** 收尾摘要(中文);工具的拒绝/中止文案也在这里归类 */
export function toolEventOutcome(
  name: string,
  args: Record<string, unknown>,
  result: string,
  elapsedMs: number
): string {
  return renderToolKeyZh(toolEventOutcomeKey(name, args, result, elapsedMs))
}

/** 在回合所属会话(任务会话回合=任务会话,否则居民单聊)里落一行「执行中」,返回收尾句柄;不该落行的工具返回 null */
function beginToolEvent(
  bot: Bot,
  name: string,
  args: Record<string, unknown>,
  turnId?: string,
  sessionId?: string,
  execRoot?: string
): { done: (result: string) => void; fail: () => void } | null {
  // MCP 连接器工具(2026-11-06):转译名不带展示名,单独按 slug 反解连接器名(落「用了 瑞幸咖啡 · createOrder」)
  const labelKey = name.startsWith('mcp__') ? mcpToolEventKey(bot.id, name) : toolEventLabelKey(name, args)
  const label = labelKey ? renderToolKeyZh(labelKey) : null
  if (!label || !labelKey) return null
  const started = Date.now()
  let messageId: number
  try {
    const session = sessionId ? { id: sessionId } : getOrCreateSession(bot.id)
    const meta: ToolEventMeta = { toolName: name, status: 'running', labelK: labelKey }
    // 写入/编辑的目标路径存绝对路径(与工具实际执行的解析一致),界面文件名可点开文件;
    // 任务回合按执行基点解析(2026-11-10)
    if ((name === 'write_file' || name === 'edit_file') && typeof args.path === 'string' && args.path.trim()) {
      meta.path = resolveBotPath(bot, args.path, execRoot)
    }
    messageId = insertMessage(session.id, 'assistant', label, null, false, 'tool', meta, undefined, turnId).id
  } catch (err) {
    console.error('[chat] 工具事件行落库失败:', err)
    return null
  }
  return {
    done: (result) => {
      const oKey = toolEventOutcomeKey(name, args, result, Date.now() - started)
      finishToolEvent(messageId, 'done', renderToolKeyZh(oKey), oKey)
    },
    fail: () => finishToolEvent(messageId, 'failed', '失败', { k: 'chat.out.failed' })
  }
}

/** 应用不在前台时发系统通知(M1.3) */
export function notifyIfBlurred(sender: WebContents, title: string, body: string): void {
  try {
    const win = BrowserWindow.fromWebContents(sender)
    if (win && win.isFocused()) return
    const notification = new Notification({ title, body: body || ' ' })
    notification.on('click', () => win?.show())
    notification.show()
  } catch {
    // 通知不可用时静默
  }
}

export interface ToolLoopOptions {
  /** 附加请求头(群岛通道 x-island-uid) */
  headers?: Record<string, string>
  provider: ProviderInfo
  apiKey: string
  context: LlmMessage[]
  tools: ToolSpec[]
  depth: number
  signal: AbortSignal
  emit?: { onDelta?: (text: string) => void; onReasoning?: (text: string) => void; onActivity?: () => void; onStep?: () => void }
  /** 在居民单聊里落工具事件行(单聊回合用;群聊的消息表没有事件行,暂不落) */
  toolEvents?: boolean
  /** 回合 id(方案 C):本回合落库的思考/旁白/工具/私信/正文行全部携带,界面按回合折叠过程;群聊不落行可不传 */
  turnId?: string
  /** 真实用量回传(B2):每次模型调用完成时带本次请求的 prompt 字符数与用量,供 token 估算校准 */
  onUsage?: (promptChars: number, usage: UsageInfo) => void
  /** 本回合发生的聊天场景(2026-10-29 定时任务):'group:<id>'=群聊;缺省=单聊。set_task 据此记交代场景 */
  chat?: string
  /** 回合所属会话(2026-11-06「新建任务」):任务会话回合传任务会话 id——思考/旁白/工具事件行
   *  落进任务会话(缺省落居民单聊);审批卡的会话路由由 threadId 承担 */
  sessionId?: string
  /** 任务会话回合(2026-11-06):审批卡落发起回合的会话(透传给 executeTool) */
  threadId?: string
  /** 任务执行基点(2026-11-10 工作目录绑定):绑定线程的回合传入,透传给 executeTool——
   *  文件工具的相对解析与写围栏、命令默认 cwd 与 git 身份 env 全部切到基点 */
  execBase?: TaskExecBase
  /** 定时任务回合(2026-11-03 失控护栏):步数耗尽收尾句换成任务口径(指路「回『继续』续跑」) */
  taskTurn?: boolean
}

/** 通用 agent 循环:模型 → 工具 → 模型;不落库、不发事件,由调用方(DM/群聊)包装。
 *  text 语义=最后完成一步的正文(2026-10-28 拍板修订):带工具调用的中间步正文是过程旁白,
 *  单聊落 kind='note' 过程行折进时间线(群聊直接不落),不再拼接进最终回复 */
export async function runToolLoop(
  bot: Bot,
  opts: ToolLoopOptions
): Promise<{ ok: boolean; text: string; reasoning: string; aborted: boolean; error?: Error; processRows: number }> {
  let text = ''
  let reasoning = ''
  // 步数用尽时给用户一句可见的收尾(不再多花一轮模型调用)
  let exhausted = false
  // 本回合落了几条过程行(思考+工具):无正文的静默回信靠它判断要不要落「无回复」标记
  let processRows = 0
  // 失控护栏状态(2026-11-03):重复调用检测跨步连续计数,注入只进上下文不进时间线
  const repeatGuard = createRepeatGuard()
  // 上游瞬时故障重试预算(方案 2026-11-03):整回合一份(≤6 次),全部步内共享防重试放大
  const retryBudget = createRetryBudget()
  // 本步已流出的正文(每步清零):流中途断掉(停止/断网)时 chatStream 抛错拿不到
  // result.content,界面却已经显示过这些 delta——累积下来交给 catch,「保留已流出的部分」才不断档
  let streamed = ''
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // 本步思考时长:有流式回调时掐「首个→最后一个 reasoning delta」;静默回合没有回调,按整步调用时长估
      const stepStart = Date.now()
      let firstReasoningAt: number | null = null
      let lastReasoningAt: number | null = null
      streamed = ''
      const onReasoning = opts.emit?.onReasoning
        ? (chunk: string): void => {
            const now = Date.now()
            firstReasoningAt ??= now
            lastReasoningAt = now
            opts.emit?.onReasoning?.(chunk)
          }
        : undefined
      const onDelta = opts.emit?.onDelta
        ? (chunk: string): void => {
            streamed += chunk
            opts.emit?.onDelta?.(chunk)
          }
        : undefined
      const result = await chatStream(
        {
          baseUrl: opts.provider.baseUrl,
          apiKey: opts.apiKey,
          model: bot.modelId,
          messages: opts.context,
          tools: opts.tools,
          signal: opts.signal,
          headers: opts.headers
        },
        { onDelta, onReasoning, onActivity: opts.emit?.onActivity },
        { budget: retryBudget }
      )
      // 真实用量回传(B2):以本次请求的上下文字符数换算 chars/token 比率
      // A(2026-11-06):回传的 reasoning_content 同样进 prompt,字符数一并计入,比率不漂移
      if (result.usage && opts.onUsage) {
        opts.onUsage(
          opts.context.reduce((sum, m) => sum + llmContentChars(m.content) + (m.reasoning_content?.length ?? 0), 0),
          result.usage
        )
      }
      // 末步正文语义(2026-10-28 拍板修订):text 只保留最近完成步的正文——正常收尾它就是结论;
      // 出错/中止时它是「已产出的部分」,与旧版「全部拼接」不同,中间步文字已各自落 note 行
      text = result.content
      if (result.reasoning) reasoning += result.reasoning
      const stepReasoning = result.reasoning ?? ''
      // 每步思考落一行过程行(方案 C):插在本步工具行之前,时间线上「思考→工具→思考」穿插;
      // 正文放 reasoning 列,content 留空(不进 FTS、不进上下文)
      if (opts.toolEvents && opts.turnId && stepReasoning.trim()) {
        try {
          const sessionId = opts.sessionId ?? getOrCreateSession(bot.id).id
          const durationMs =
            firstReasoningAt !== null && lastReasoningAt !== null ? lastReasoningAt - firstReasoningAt : Date.now() - stepStart
          insertMessage(sessionId, 'assistant', '', stepReasoning, false, 'reasoning', { durationMs }, undefined, opts.turnId)
          processRows++
        } catch (err) {
          console.error('[chat] 思考过程行落库失败:', err)
        }
      }
      if (!result.toolCalls || result.toolCalls.length === 0) break
      if (step === MAX_STEPS - 1) exhausted = true

      // 步界(2026-10-28 拍板修订):本步之后还有工具轮,刚流出的这段正文是过程旁白——
      // 落 note 行折进时间线(文字进 reasoning 列,待遇同思考行:不进 FTS、不进后续上下文;
      // 群聊无过程行基建,直接不落),并通知界面清空实时气泡让位给下一段。
      // 步数耗尽的末步例外:它的文字直接作正文(兜底句会拼上去),不落也不清
      if (step !== MAX_STEPS - 1) {
        if (opts.toolEvents && opts.turnId && result.content.trim()) {
          try {
            const sessionId = opts.sessionId ?? getOrCreateSession(bot.id).id
            insertMessage(sessionId, 'assistant', '', result.content, false, 'note', undefined, undefined, opts.turnId)
            processRows++
          } catch (err) {
            console.error('[chat] 中间正文行落库失败:', err)
          }
        }
        opts.emit?.onStep?.()
      }

      // A(2026-11-06):DeepSeek 思考模式协议要求带过 reasoning_content 的 assistant 消息,回合内下一步
      // 回放须原样带上——仅群岛通道(上游 DeepSeek)挂,取值策略(出现过+干净收尾)见 reasoningEchoValue
      const reasoningEcho = opts.provider.id === 'archipelago' ? reasoningEchoValue(result) : undefined
      opts.context.push({
        role: 'assistant',
        content: result.content,
        ...(reasoningEcho !== undefined ? { reasoning_content: reasoningEcho } : {}),
        tool_calls: result.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments }
        }))
      })
      // 剩 EXHAUST_WARN_AHEAD 步的这步收尾后注入预警(0 起第 MAX-11 步):给模型留 10 步执行收尾动作
      const exhaustWarnStep = step === MAX_STEPS - EXHAUST_WARN_AHEAD - 1
      for (let ci = 0; ci < result.toolCalls.length; ci++) {
        const call = result.toolCalls[ci]! // 循环条件已守 length,下标必在界内
        // 用户已停止:同批后续工具不再执行(模型一次给多个调用时,停第一条长命令后
        // 不该接着跑第二条写文件)。结果以停止占位补齐 tool_call 协议,循环交由
        // 下一步的 chatStream 在已中止信号上收尾
        if (opts.signal.aborted) {
          opts.context.push({ role: 'tool', tool_call_id: call.id, content: '本次回合已停止,这个工具没有执行。' })
          continue
        }
        const event = opts.toolEvents
          ? beginToolEvent(bot, call.name, safeParseJson(call.arguments), opts.turnId, opts.sessionId, opts.execBase?.root)
          : null
        if (event) processRows++
        let outcome: string
        try {
          outcome = await executeTool(bot, call.name, safeParseJson(call.arguments), {
            depth: opts.depth,
            signal: opts.signal,
            startReply: startReplyTurn,
            turnId: opts.turnId,
            notifyDigest: scheduleDigest,
            chat: opts.chat,
            threadId: opts.threadId,
            sessionId: opts.sessionId,
            execBase: opts.execBase
          })
          event?.done(outcome)
        } catch (err) {
          outcome = `工具 ${call.name} 执行失败:${err instanceof Error ? err.message : String(err)}`
          event?.fail()
        }
        // 失控护栏注入只改进上下文的工具结果(event 展示保持纯结果):重复提醒命中时附在该次结果尾;
        // 收尾预警只注一次,附在本步最后一个结果尾(该步必有调用,toolCalls 非空才走到这)
        let contextOutcome = outcome
        if (noteToolCall(repeatGuard, toolCallSignature(call.name, safeParseJson(call.arguments)))) {
          contextOutcome += `\n\n${REPEAT_REMINDER}`
        }
        if (exhaustWarnStep && ci === result.toolCalls.length - 1) {
          contextOutcome += `\n\n${EXHAUST_REMINDER}`
        }
        opts.context.push({ role: 'tool', tool_call_id: call.id, content: contextOutcome })
      }
    }
    if (exhausted) {
      // 任务回合换任务口径:无人值守场景没人能「跟我说一声」,指路事后回「继续」续跑(2026-11-03 拍板)
      text += opts.taskTurn ? EXHAUST_SUFFIX_TASK : EXHAUST_SUFFIX_CHAT
    }
    return { ok: true, text, reasoning, aborted: false, processRows }
  } catch (err) {
    // 中断落在流式正文中途:已流出的部分就是最新产出,照「出错/停止保留已流出部分」的口径带回
    if (streamed) text = streamed
    // 结构化错误(如积分不足)原样带出,让 runTurn 区分呈现
    return {
      ok: false,
      text,
      reasoning,
      aborted: opts.signal.aborted,
      error: err instanceof Error ? err : new Error(String(err)),
      processRows
    }
  }
}

interface TurnOptions {
  /** 0 = 与岛主的正常回合;>0 = 正在处理其他居民的私信 */
  depth: number
  /** 静默回合(处理居民私信):不推流、不发对话事件 */
  silent: boolean
  /** 回合类型(2026-10-30 列表实时状态):缺省从 opts 推导——任务>私信回信>普通对话;
   *  仅通报消化(runDigest)须显式传 'digest' 与私信回信区分(两者 opts 形状相同) */
  kind?: TurnKind
  sender?: WebContents
  /** 本回合岛主的原话,供记忆 review 使用 */
  userText?: string
  /** 本次是居民私信的回复回合:保存为 relation 事件行而非普通气泡 */
  relation?: { peer: string; exchangeId?: string }
  /** 唤醒转述回合(回复唤醒,2026-11-05 拍板):对方回信落地后唤醒本居民去向岛主转述,
   *  brief 注入上下文尾部(同任务回合);产出普通气泡+「收到回信」小签;depth 1 无 send_message 天然防环 */
  relay?: { peer: string; exchangeId?: string; brief: string }
  /** 回合 id(方案 C):sendMessage 已生成并落在用户消息上,这里沿用;静默回合缺省自生成 */
  turnId?: string
  /** 岛主随本条消息发的附件(2026-10-29):图片在上下文组装后内联给多模态模型,文件/文件夹只留说明行 */
  attachments?: MessageAttachment[]
  /** 定时任务触发回合(2026-10-29):无用户消息,brief 注入上下文尾部;各结束路径回调 onSettled,
   *  调度器据此推进状态机(busy=岛主正在聊顺延 / credits=积分不足标未执行 / ok=完成或前滚周期) */
  task?: {
    taskId: string
    brief: string
    onSettled: (r: { ok: boolean; code?: string }) => void
  }
  /** 任务会话回合(2026-11-06「新建任务」):上下文/落库/审批/事件全路由到该线程的独立会话——
   *  居民属性(人设/性格/技能/记忆)照常注入,历史从零;active 键=task:<threadId>,
   *  与居民单聊并行互不占用;首轮 settled 后自动起标题 */
  thread?: {
    threadId: string
  }
}

async function runTurnInner(bot: Bot, opts: TurnOptions): Promise<{ ok: boolean; content: string }> {
  const sender = opts.sender
  const emit = !opts.silent && sender !== undefined
  const turnId = opts.turnId ?? randomUUID()
  // 回合所属线程(2026-11-06):任务会话回合占 task:<threadId> 键,普通回合照旧占 botId 键——
  // 同一居民的单聊与多个任务会话可并行;「上一条还在进行中」只在同一线程内成立
  const turnKey = opts.thread ? taskKey(opts.thread.threadId) : bot.id
  const threadId = opts.thread?.threadId

  if (active.has(turnKey)) {
    if (opts.task) opts.task.onSettled({ ok: false, code: 'busy' })
    if (emit) {
      sender!.send(EV.ChatError, { botId: bot.id, threadId, error: '上一条回复还在进行中,稍候或点停止' } satisfies ChatErrorEvent)
    }
    // 回复唤醒:泵队列与真开跑之间的窄竞态撞上忙——回信重入队,下次泵再起,不丢
    // (唤醒的重试统一由 runWake 收口,这里不重复入队)
    if (opts.relation && opts.kind !== 'digest') {
      queueReply(bot.id, opts.relation.peer, opts.relation.exchangeId ?? '')
    }
    return { ok: false, content: '' }
  }

  // 结束流程进行中(M4):唤醒转述等直连 runTurn 的入口在此统一被拒(不走
  // sendTaskThreadMessage),回合不启动;归档后 exchangeThreadOf 自然回落单聊,不黑洞
  if (opts.thread && isTaskThreadClosing(opts.thread.threadId)) {
    if (emit) {
      sender!.send(EV.ChatError, { botId: bot.id, threadId, error: '任务正在结束,稍候再发' } satisfies ChatErrorEvent)
    }
    return { ok: false, content: '' }
  }

  // 0.9:群岛通道(积分计费)——key=登录会话令牌,baseUrl 随 SEA 环境走;自带 Key 通道仅作逃生舱(UI 已隐藏)
  const isRelay = bot.providerId === 'archipelago'
  const provider = getProvider(bot.providerId)
  const apiKey = isRelay ? currentSeaToken() : getApiKey(bot.providerId)
  if (!provider || !apiKey) {
    const error = isRelay ? '登录已失效,请退出后重新登录' : `尚未配置 ${provider?.label ?? bot.providerId} 的 API Key`
    if (opts.task) opts.task.onSettled({ ok: false, code: 'no-provider' })
    if (emit) {
      sender!.send(EV.ChatError, { botId: bot.id, threadId, error } satisfies ChatErrorEvent)
    }
    // 回复唤醒:回信回合没跑起来(通道不可用)——发起方仍要被唤醒如实交代,信不黑洞
    if (opts.relation) {
      settleReplyWake(bot, { peer: opts.relation.peer, exchangeId: opts.relation.exchangeId, replyText: '', noReply: true, failed: true })
    }
    return { ok: false, content: '' }
  }
  const effectiveProvider = isRelay ? { ...provider, baseUrl: seaRelayBaseUrl() } : provider
  const islandUid = isRelay ? currentIslandUid() : null

  // 回合槽(2026-11-10 起):槽覆盖 prepare→执行→finalize 全程,try/finally 统一释放——
  // 此前 active.delete 在收尾早期,finalize 期间侧栏已显空闲、下一条消息可撞进同一工作树;
  // 槽内禁止递归 runTurn(busy 检查天然拦)。异常路径也保证释放(顺带修掉「throw 后 busy 卡死」的存量隐患)
  const controller = new AbortController()
  active.set(turnKey, {
    controller,
    visible: emit,
    kind: opts.kind ?? (opts.task ? 'scheduled' : opts.relation ? 'relation' : 'chat')
  })
  broadcastTurnChanged()
  let session!: SessionRow
  let result!: Awaited<ReturnType<typeof runToolLoop>>
  // 执行基点提升到 try 外(2026-11-10):finalize 要用回合捕获的基点做退役工作树保护(M6)
  let execBase: TaskExecBase | null = null
  try {
    // 工作目录闸(2026-11-10 第一批):绑定线程先 prepare/verify(fail-closed,绝不静默降级),
    // 闸的产物(execBase)是上下文组装与工具层的输入,故在槽内、组装前执行
    let threadBrief: string | null = null
    if (opts.thread) {
      const gate = await ensureWorkdirReady(bot, opts.thread.threadId)
      if (!gate.ok) {
        if (emit) {
          sender!.send(EV.ChatError, { botId: bot.id, threadId, error: gate.message } satisfies ChatErrorEvent)
        }
        return { ok: false, content: '' }
      }
      execBase = gate.execBase
      // 统一 brief builder(2026-11-10):任务框定 + 工作目录段一次拼好,正常组装与压缩重建两路径同源
      const fresh = getTaskThread(opts.thread.threadId)
      const workdirBrief = fresh ? taskWorkdirBriefOf(fresh) : null
      threadBrief = workdirBrief ? `${TASK_THREAD_BRIEF}\n\n${workdirBrief}` : TASK_THREAD_BRIEF
    }

    // 会话路由(2026-11-06):任务会话回合落任务会话(上下文=居民属性+该线程自己的历史),
    // 普通回合照旧落居民单聊;system prompt/记忆/技能对两者一视同仁(buildContextMessages 只换 session)
    session = opts.thread ? getOrCreateTaskSession(bot.id, opts.thread.threadId) : getOrCreateSession(bot.id)
    const space = getSpace()
    const roster = listBots().map((b) => ({ name: b.name, role: b.role, archetype: archetypeName(b.archetype), isMain: b.isMain }))
    const context = buildContextMessages(bot, space, roster, session, listMessages(session.id))
    // 定时任务触发(2026-10-29):无用户消息,框定语挂在上下文最尾(当前时间行之后)——
    // 居民读到的最后一句就是「现在是你答应岛主的任务时刻」,天然以执行者身份开口
    if (opts.task) {
      context.push({ role: 'system', content: opts.task.brief })
    }
    // 任务会话框定(2026-11-06):同注入位——居民读到的最后一句是「这是为一件具体的事开的独立工作会话」,
    // 天然以执行者身份接话;历史里没有单聊内容,但性格/记忆/技能都在(它们随 system prompt 注入)
    if (threadBrief) {
      context.push({ role: 'system', content: threadBrief })
    }
    // 唤醒转述(回复唤醒,2026-11-05):回信内容随 brief 挂在上下文最尾,居民读到的
    // 最后一句就是「X 的回信到了」,天然以转述者身份开口;岛主当初的交代在历史里,链不断
    if (opts.relay) {
      context.push({ role: 'system', content: opts.relay.brief })
    }
    // 图片内联(2026-10-29 输入框升级):本回合岛主发的图以多模态分段附在最后一条用户消息上;
    // 历史轮次的图只留 [图片] 路径说明行不重复进上下文(省 token)。说明行由 buildContextMessages
    // 从落库的 attachments 注入,内联撤掉后自然回退成路径引用
    const images = (opts.attachments ?? []).filter((a) => a.kind === 'image')
    let contextWithImages = context
    if (images.length > 0) {
      const lastUserIdx = context.map((m) => m.role).lastIndexOf('user')
      if (lastUserIdx >= 0) {
        const raw = context[lastUserIdx]!.content
        const parts: LlmContentPart[] = [{ type: 'text', text: typeof raw === 'string' ? raw : '' }]
        for (const img of images) {
          const part = readImageDataUrl(img)
          if (part) parts.push(part)
        }
        if (parts.length > 1) {
          contextWithImages = context.slice()
          contextWithImages[lastUserIdx] = { ...context[lastUserIdx]!, content: parts }
        }
      }
    }
    // MCP 连接器(2026-11-06):回合开始前暖连接+刷新工具缓存——toolsFor 是同步读缓存,
    // 冷启动必须在这里预热;无分配=一次索引查询直通,失败吞进连接器状态绝不打断回合
    await warmMcpToolsForBot(bot.id)
    const runLoop = (ctx: LlmMessage[]) =>
      runToolLoop(bot, {
        provider: effectiveProvider,
        apiKey,
        headers: islandUid ? { 'x-island-uid': islandUid } : undefined,
        context: ctx,
        tools: toolsFor(bot, opts.depth, opts.thread ? 'task' : 'dm', execBase?.root),
        depth: opts.depth,
        signal: controller.signal,
        // 单聊回合(含处理居民私信的静默回合)都落工具事件行:岛主盯着谁的窗口都能看到 TA 在动本机
        toolEvents: true,
        // 定时任务回合(2026-11-03 失控护栏):耗尽收尾句走任务口径
        taskTurn: opts.task !== undefined,
        turnId,
        // 任务会话回合(2026-11-06):过程行与审批卡都路由到任务会话
        sessionId: session.id,
        threadId,
        // 任务执行基点(2026-11-10):文件/命令工具切工作树(绑定线程)
        execBase: execBase ?? undefined,
        emit: emit
          ? {
              onDelta: (chunk) => sender!.send(EV.ChatDelta, { botId: bot.id, threadId, text: chunk } satisfies ChatDeltaEvent),
              onReasoning: (chunk) => sender!.send(EV.ChatReasoning, { botId: bot.id, threadId, text: chunk } satisfies ChatDeltaEvent),
              onActivity: () => sender!.send(EV.ChatActivity, { botId: bot.id, threadId } satisfies ChatActivityEvent),
              // 步界:本段正文已落 note 行折进时间线,界面清空实时气泡(最终段不清,打完直接转正)
              onStep: () => sender!.send(EV.ChatStep, { botId: bot.id, threadId } satisfies ChatStepEvent)
            }
          : undefined,
        onUsage: (chars, u) => recordPromptUsage(session.id, chars, u.promptTokens)
      })
    result = await runLoop(contextWithImages)
    // 图片降级(2026-10-29):模型/通道不认图时撤掉内联只留 [图片] 路径说明行重试一次——
    // 居民还能用工具碰原图,绝不因一张图卡死整条消息(ZCode 同款思路)
    if (
      !result.ok &&
      !result.text.trim() &&
      images.length > 0 &&
      result.error &&
      isImageUnsupportedError(String(result.error.message))
    ) {
      result = await runLoop(context)
    }
    // 超长兜底(B3):模型侧拒了超长请求且没有产出时,同步强制压缩后重试一次(每回合至多一次);
    // forceCompact 改了 sessions 的 summary/cutoff,重建上下文前必须重取会话行;任务框定语随重建补挂
    if (!result.ok && !result.text.trim() && result.error instanceof ContextTooLongError) {
      const compacted = await forceCompact(bot, session).catch((err) => {
        console.error('[steward] 超长强制压缩失败:', err)
        return false
      })
      if (compacted) {
        const fresh = opts.thread ? getOrCreateTaskSession(bot.id, opts.thread.threadId) : getOrCreateSession(bot.id)
        const rebuilt = buildContextMessages(bot, space, roster, fresh, listMessages(fresh.id))
        // 注入顺序与首轮一致:定时任务 brief → 任务框定(含工作目录段,统一 builder)→ 唤醒转述
        if (opts.task) rebuilt.push({ role: 'system', content: opts.task.brief })
        if (threadBrief) rebuilt.push({ role: 'system', content: threadBrief })
        if (opts.relay) rebuilt.push({ role: 'system', content: opts.relay.brief })
        result = await runLoop(rebuilt)
      }
    }
  } finally {
    // finalize(2026-11-10 第一批,回合槽内、槽释放前):绑定 worktree 的线程做收尾决策树
    // (自动提交/残留快照);超时/失败进恢复队列,不重跑模型回合。非绑定/直连线程内部天然 no-op
    if (opts.thread && getTaskThread(opts.thread.threadId)?.workdirPath) {
      // capturedBase=回合捕获的基点——回合中途换绑时,旧工作树的最后残留按它保护(M6)
      await finalizeTaskTurn(bot, opts.thread.threadId, { capturedBase: execBase ?? undefined }).catch((err) =>
        console.error('[chat] 任务收尾 finalize 失败(已留恢复):', err)
      )
    }
    active.delete(turnKey)
    broadcastTurnChanged()
    // 回合结束,「本回合不再问」的免问表随之失效(键=线程:只清本线程的,并行线程的免问不受牵连)
    clearTurnApprovals(turnKey)
  }

  const isRelationTurn = opts.relation !== undefined
  const hasText = result.text.trim().length > 0
  const savedContent = isRelationTurn && hasText ? `[回复 ${opts.relation!.peer}] ${result.text.trim()}` : result.text

  /** 回信回合收尾统一触发发起方唤醒(回复唤醒,2026-11-05 拍板):真回复/部分回复/没回上来
   *  三种结局发起方都会被唤醒一次向岛主转述(没回上来的如实说),信不黑洞 */
  const wakeInitiator = (info: { replyText: string; noReply?: boolean; failed?: boolean }): void => {
    if (!opts.relation) return
    settleReplyWake(bot, {
      peer: opts.relation.peer,
      exchangeId: opts.relation.exchangeId,
      ...info
    })
  }

  /** 静默回信没产出正文:落一行「无回复」标记(dir='reply' + noReply)。
   *  它既是这个静默回合的完成信号(界面据此收起实时过程行),也让过程行有 turnId 可挂进私信浮窗。
   *  2026-11-06 codex 审查修复:不看 processRows 落库——没有过程行的空结局也要有终态标记,
   *  否则崩溃恢复会把该交流当「信未回」重跑(重复回信+重复唤醒发起方) */
  const markNoReply = (): void => {
    insertMessage(
      session.id,
      'assistant',
      '',
      null,
      false,
      'relation',
      { dir: 'reply', peer: opts.relation!.peer, noReply: true },
      opts.relation?.exchangeId,
      turnId
    )
  }

  if (result.ok) {
    if (isRelationTurn && !hasText) {
      markNoReply()
      wakeInitiator({ replyText: '', noReply: true })
      return { ok: true, content: '' }
    }
    // 思考已按步落 kind='reasoning' 过程行(方案 C),正文消息不再拼一坨存 reasoning 字段
    const saved = insertMessage(
      session.id,
      'assistant',
      savedContent,
      null,
      false,
      isRelationTurn ? 'relation' : 'chat',
      isRelationTurn
        ? { dir: 'reply', peer: opts.relation!.peer }
        : opts.task
          ? { taskId: opts.task.taskId }
          : opts.relay
            ? { relay: { peer: opts.relay.peer, exchangeId: opts.relay.exchangeId } }
            : undefined,
      opts.relation?.exchangeId,
      turnId
    )
    if (isRelationTurn) wakeInitiator({ replyText: result.text })
    if (emit) {
      sender!.send(EV.ChatDone, { botId: bot.id, threadId, message: saved } satisfies ChatDoneEvent)
      notifyIfBlurred(sender!, bot.name, result.text.trim().slice(0, 60))
    }
    // 记忆被动整理(仅与岛主的回合)与上下文压缩,都在回合后异步进行;
    // 任务会话回合照常沉淀记忆(P4:同一个居民,任务经历单聊里也记得——memory 内按居民串行化防并发互踩)
    if (!opts.silent && opts.userText) {
      void reviewTurn(bot, opts.userText, result.text).catch(() => undefined)
      if (opts.thread) {
        void tryGenerateTaskThreadTitle(opts.thread.threadId, opts.userText, result.text).catch(() => undefined)
      }
    }
    if (opts.task) opts.task.onSettled({ ok: true })
    void compactIfNeeded(bot, session).catch((err) => {
      console.error('[steward] 压缩失败:', err)
    })
    return { ok: true, content: result.text }
  }

  // 出错/停止:保留已流出的部分
  if (emit || isRelationTurn) {
    if (hasText) {
      const partial = insertMessage(
        session.id,
        'assistant',
        isRelationTurn ? `[回复 ${opts.relation!.peer}] ${result.text.trim()}` : result.text,
        null,
        false,
        isRelationTurn ? 'relation' : 'chat',
        isRelationTurn
          ? { dir: 'reply', peer: opts.relation!.peer }
          : opts.relay
            ? { relay: { peer: opts.relay.peer, exchangeId: opts.relay.exchangeId }, stopped: true }
            : { stopped: true },
        opts.relation?.exchangeId,
        turnId
      )
      // 回信回合被停但已写出部分:部分正文也是回信,发起方照样唤醒转述(failed 让 TA 知道没写完)
      if (isRelationTurn) wakeInitiator({ replyText: result.text, failed: true })
      if (emit) {
        sender!.send(EV.ChatStopped, { botId: bot.id, threadId, message: partial } satisfies ChatStoppedEvent)
      }
    } else if (isRelationTurn) {
      markNoReply()
      wakeInitiator({ replyText: '', noReply: true, failed: true })
    } else if (emit) {
      if (result.aborted) {
        sender!.send(EV.ChatStopped, { botId: bot.id, threadId, message: null } satisfies ChatStoppedEvent)
      } else if (result.error instanceof ContextTooLongError) {
        // 超长兜底(B3):压缩重试后仍超长(或已无可压缩的早期消息)——给明确指引而非误导性的「请重试」
        sender!.send(EV.ChatError, {
          botId: bot.id,
          threadId,
          error: '这段对话太长了，先把之前聊的内容让我总结一下，或者换个新话题吧',
          code: 'context_too_long'
        } satisfies ChatErrorEvent)
      } else if (result.error instanceof RelayError && result.error.code === 'insufficient_credits') {
        sender!.send(EV.ChatError, {
          botId: bot.id,
          threadId,
          error: '积分不足,请充值后再试',
          code: 'insufficient_credits'
        } satisfies ChatErrorEvent)
      } else if (result.error instanceof RelayError) {
        sender!.send(EV.ChatError, { botId: bot.id, threadId, error: result.error.message, code: result.error.code } satisfies ChatErrorEvent)
      } else {
        console.error('[chat] 回合失败:', result.error)
        sender!.send(EV.ChatError, { botId: bot.id, threadId, error: '对话中断,请重试' } satisfies ChatErrorEvent)
      }
    }
  }
  // 任务触发回合的失败收尾:结构化错误码交给调度器落状态(busy 在早退路径单独回过)
  if (opts.task) {
    const code = result.aborted
      ? 'aborted'
      : result.error instanceof RelayError && result.error.code === 'insufficient_credits'
        ? 'credits'
        : result.error instanceof ContextTooLongError
          ? 'context'
          : 'error'
    opts.task.onSettled({ ok: false, code })
  }
  return { ok: false, content: result.text }
}

export async function runTurn(bot: Bot, opts: TurnOptions): Promise<{ ok: boolean; content: string }> {
  // 回合进行中的 promise 登记(2026-11-10 可等待停止):结束任务的握手等它连同 finalize 一起收完。
  // M3:只在**本调用认领了槽位**时登记——busy 早退的调用若也登记,会把真正运行回合的 waiter
  // 覆盖成瞬时 promise 再删掉,停止握手随即「等到」一个假完成。认领判定=调用前槽空闲:
  // runTurnInner 从入口到 active.set 之间无 await(单线程无穿插),该检查与内部 busy 检查等价。
  const key = opts.thread ? taskKey(opts.thread.threadId) : bot.id
  if (!active.has(key)) {
    const inner = runTurnInner(bot, opts)
    turnWaiters.set(key, inner)
    try {
      return await inner
    } finally {
      if (turnWaiters.get(key) === inner) turnWaiters.delete(key)
      pumpQueues(bot.id)
    }
  }
  // busy:走早退路径(发错误事件/回信重入队),不碰 waiter
  try {
    return await runTurnInner(bot, opts)
  } finally {
    pumpQueues(bot.id)
  }
}

export async function sendMessage(
  botId: string,
  text: string,
  sender: WebContents,
  attachments?: MessageAttachment[],
  quotes?: ChatQuote[]
): Promise<void> {
  const bot = getBot(botId)
  if (!bot) throw new Error('居民不存在')
  const trimmed = text.trim()
  const atts = (attachments ?? []).filter((a) => a && typeof a.path === 'string' && a.path)
  // 选区引用(2026-11-02):服务端净化(渲染层守卫只是体验,这里是闸);引用单独成条也算有效消息
  const safeQuotes = sanitizeQuotes(quotes)
  if (!trimmed && atts.length === 0 && safeQuotes.length === 0) return

  const session = getOrCreateSession(botId)
  // 回合 id(方案 C):用户消息与后续过程行/最终回复共用,界面按它折叠过程
  const turnId = randomUUID()
  const userMessage = insertMessage(
    session.id,
    'user',
    trimmed,
    null,
    false,
    'chat',
    safeQuotes.length > 0 ? { quotes: safeQuotes } : undefined,
    undefined,
    turnId,
    atts
  )
  sender.send(EV.ChatUserAdded, { botId, message: userMessage } satisfies ChatUserAddedEvent)

  // 出错时已经通过 ChatError 事件告知渲染端,这里不再向上抛
  await runTurn(bot, { depth: 0, silent: false, sender, userText: trimmed, turnId, attachments: atts })
}

/**
 * 在任务会话里发消息(2026-11-06「新建任务」):与 sendMessage 同构——用户消息落任务会话、
 * 事件带 threadId、runTurn 带 thread 路由(上下文/审批/过程行/标题钩子全在任务线程里);
 * 附件与选区引用的支持面与单聊一致。
 */
export async function sendTaskThreadMessage(
  threadId: string,
  text: string,
  sender: WebContents,
  attachments?: MessageAttachment[],
  quotes?: ChatQuote[]
): Promise<void> {
  const thread = getTaskThread(threadId)
  if (!thread) throw new Error('任务不存在')
  if (thread.status !== 'open') throw new Error('任务已结束')
  // 结束握手进行中(2026-11-10 可等待停止):先停干净再归档,窗口期新回合一律拒绝
  if (isTaskThreadClosing(threadId)) throw new Error('任务正在结束,稍候再发')
  const bot = getBot(thread.botId)
  if (!bot) throw new Error('居民不存在')
  const trimmed = text.trim()
  const atts = (attachments ?? []).filter((a) => a && typeof a.path === 'string' && a.path)
  const safeQuotes = sanitizeQuotes(quotes)
  if (!trimmed && atts.length === 0 && safeQuotes.length === 0) return

  const session = getOrCreateTaskSession(bot.id, threadId)
  const turnId = randomUUID()
  const userMessage = insertMessage(
    session.id,
    'user',
    trimmed,
    null,
    false,
    'chat',
    safeQuotes.length > 0 ? { quotes: safeQuotes } : undefined,
    undefined,
    turnId,
    atts
  )
  sender.send(EV.ChatUserAdded, { botId: bot.id, threadId, message: userMessage } satisfies ChatUserAddedEvent)

  // 出错时已经通过 ChatError 事件告知渲染端,这里不再向上抛
  await runTurn(bot, {
    depth: 0,
    silent: false,
    sender,
    userText: trimmed,
    turnId,
    attachments: atts,
    thread: { threadId }
  })
}
