import { randomUUID } from 'node:crypto'
import { BrowserWindow, type WebContents } from 'electron'
import type {
  Bot,
  ChatQuote,
  CreateGroupInput,
  GroupHistoryResult,
  GroupInfo,
  GroupMessage,
  GroupThinkingState,
  MessageAttachment,
  QuoteMeta,
  UpdateGroupInput
} from '@shared/types'
import { EV } from '@shared/ipc-channels'
import type {
  GroupDeltaEvent,
  GroupDoneEvent,
  GroupErrorEvent,
  GroupStepEvent,
  GroupTurnStartEvent,
  GroupUserAddedEvent
} from '@shared/ipc-channels'
import { getProvider } from '@shared/providers'
import { archetypeName } from '@shared/archetypes'
import { sanitizeQuotes, quoteLines } from '@shared/quote-core'
import { ensureMainBot, getBot, listBots } from './bots'
import { notifyIfBlurred, runToolLoop } from './chat'
import { clearTurnApprovals } from './approval'
import { warmMcpToolsForBot } from './mcp'
import { ContextTooLongError, RelayError, type LlmContentPart, type LlmMessage } from './llm'
import { llmCredentials } from './llm'
import { isImageUnsupportedError } from '@shared/attachments-core'
import { attachmentLines, readImageDataUrl } from './attachments'
import { parseAttachments } from '@shared/attachments-core'
import { currentIslandUid } from './auth'
import { memoryNote, reviewGroupTurn } from './memory'
import { buildGroupSystemPrompt, type RosterEntry } from './prompts'
import {
  compactGroupIfNeeded,
  currentTimeLine,
  forceCompactGroup,
  gapMarker,
  groupSummaryRow,
  groupTailMessages,
  GROUP_RETRY_WINDOW,
  GROUP_TURN_CLIP_CHARS,
  GROUP_TURN_RECENT_FULL,
  GROUP_TURN_WINDOW,
  recordPromptUsage
} from './steward'
import { getDb, nowIso } from './store'
import { getSpace } from './space'
import { toolsFor } from './tools'

// 群聊(M5):值守模式(默认管理员应答)、@点名传棒、[PASS]、顺序队列(5.7)
// 每条群消息按到达顺序串行处理;成员回合与单聊共用 runToolLoop(可用工具与记忆)

interface GroupRow {
  id: string
  name: string
  announcement: string
  admin_bot_id: string
  created_at: string
  deleted_at: string | null
}

interface GroupMessageRow {
  id: number
  group_id: string
  sender_type: string
  bot_id: string | null
  content: string
  created_at: string
  attachments: string | null
  /** 选区引用(2026-11-02):用户消息携带的 QuoteMeta JSON;旧消息 NULL */
  meta: string | null
}

function fromRow(row: GroupRow): GroupInfo {
  return {
    id: row.id,
    name: row.name,
    announcement: row.announcement,
    adminBotId: row.admin_bot_id,
    createdAt: row.created_at,
    members: membersOf(row.id)
  }
}

function membersOf(groupId: string): Bot[] {
  const rows = getDb()
    .prepare(
      `SELECT b.*, gm.bot_id FROM group_members gm JOIN bots b ON b.id = gm.bot_id
       WHERE gm.group_id = ? AND b.deleted_at IS NULL
       ORDER BY (b.id = (SELECT admin_bot_id FROM groups WHERE id = gm.group_id)) DESC, b.is_main DESC, b.created_at ASC`
    )
    .all(groupId) as { id: string }[]
  const bots = listBots()
  return rows.map((r) => bots.find((b) => b.id === r.id)).filter((b): b is Bot => Boolean(b))
}

export function listGroups(): GroupInfo[] {
  const rows = getDb()
    .prepare('SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY created_at ASC')
    .all() as GroupRow[]
  return rows.map(fromRow)
}

export function getGroup(id: string): GroupInfo | null {
  const row = getDb()
    .prepare('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL')
    .get(id) as GroupRow | undefined
  return row ? fromRow(row) : null
}

/** 建群(M5.1):管理员(2026-10-27 解绑 Momo)——显式指定优先(须在成员内),
 *  缺省回落主 Bot,主 Bot 不在成员里则取名册首位;群结构上至少要有一位居民(管理员必是成员) */
export function createGroup(input: CreateGroupInput): GroupInfo {
  const name = input.name.trim()
  if (!name) throw new Error('群需要一个名字')
  const main = ensureMainBot()
  const validIds = new Set<string>()
  for (const id of input.memberIds) {
    if (getBot(id)) validIds.add(id)
  }
  let adminId = input.adminBotId && validIds.has(input.adminBotId) ? input.adminBotId : null
  if (!adminId) {
    if (validIds.has(main.id)) adminId = main.id
    else {
      const first = [...validIds][0]
      if (!first) throw new Error('群至少要有一位居民')
      adminId = first
    }
  }
  const id = randomUUID()
  const ts = nowIso()
  const db = getDb()
  db.prepare(
    'INSERT INTO groups (id, name, announcement, admin_bot_id, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name, input.announcement.trim(), adminId, ts)
  const insertMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, bot_id, added_at) VALUES (?, ?, ?)')
  for (const botId of validIds) insertMember.run(id, botId, ts)
  return getGroup(id) as GroupInfo
}

export function softDeleteGroup(id: string): void {
  getDb().prepare('UPDATE groups SET deleted_at = ? WHERE id = ?').run(nowIso(), id)
}

/** 群管理(2026-10-23 三轮评审):改群名 + 全量同步成员;无效 id 静默忽略。
 *  管理员(2026-10-27 解绑 Momo):仍在群内则保留,被移出则自动移交给名册首位(主 Bot 优先)。
 *  群名册每回合实时读库,改名/换成员对下一回合即时生效;正在进行中的成员回合不中断。 */
export function updateGroup(id: string, input: UpdateGroupInput): GroupInfo {
  const db = getDb()
  const row = db.prepare('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL').get(id) as GroupRow | undefined
  if (!row) throw new Error('群不存在')
  const name = input.name.trim()
  if (!name) throw new Error('群需要一个名字')
  const main = ensureMainBot()
  const validIds = new Set<string>()
  for (const botId of input.memberIds) {
    if (getBot(botId)) validIds.add(botId)
  }
  if (validIds.size === 0) throw new Error('群至少要有一位居民')
  // 名册首位(主 Bot 优先,其次最早入住)——管理员被移出时移交给 TA
  const ordered = [...validIds].sort((a, b) => {
    const ba = getBot(a)
    const bb = getBot(b)
    const ma = ba?.id === main.id ? 0 : 1
    const mb = bb?.id === main.id ? 0 : 1
    return ma - mb || (ba?.createdAt ?? '').localeCompare(bb?.createdAt ?? '')
  })
  const adminId = validIds.has(row.admin_bot_id) ? row.admin_bot_id : (ordered[0] as string)
  db.prepare('UPDATE groups SET name = ?, admin_bot_id = ? WHERE id = ?').run(name, adminId, id)
  const current = db.prepare('SELECT bot_id FROM group_members WHERE group_id = ?').all(id) as {
    bot_id: string
  }[]
  const remove = db.prepare('DELETE FROM group_members WHERE group_id = ? AND bot_id = ?')
  for (const { bot_id } of current) {
    if (!validIds.has(bot_id)) remove.run(id, bot_id)
  }
  const insertMember = db.prepare(
    'INSERT OR IGNORE INTO group_members (group_id, bot_id, added_at) VALUES (?, ?, ?)'
  )
  for (const botId of validIds) insertMember.run(id, botId, nowIso())
  return getGroup(id) as GroupInfo
}

function botLookups(): Map<string, Bot> {
  return new Map(listBots().map((b) => [b.id, b]))
}

function toMessage(row: GroupMessageRow, bots: Map<string, Bot>): GroupMessage {
  const bot = row.bot_id ? bots.get(row.bot_id) : undefined
  // 选区引用(2026-11-02):落库时已 sanitize,读侧再过一遍闸;解析失败/为空按无引用处理
  let meta: QuoteMeta | undefined
  if (row.meta && row.sender_type === 'user') {
    try {
      const parsed = JSON.parse(row.meta) as QuoteMeta
      const quotes = sanitizeQuotes(parsed.quotes)
      if (quotes.length > 0) meta = { quotes }
    } catch {
      // meta 损坏时按无引用处理
    }
  }
  return {
    id: row.id,
    groupId: row.group_id,
    senderType: row.sender_type === 'user' ? 'user' : 'bot',
    botId: row.bot_id,
    botName: bot?.name ?? null,
    botColor: bot?.color ?? null,
    content: row.content,
    createdAt: row.created_at,
    attachments: parseAttachments(row.attachments),
    meta
  }
}

export function listGroupMessages(groupId: string): GroupMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM group_messages WHERE group_id = ? ORDER BY id ASC')
    .all(groupId) as GroupMessageRow[]
  const bots = botLookups()
  return rows.map((r) => toMessage(r, bots))
}

/** 当前该群正在发言的居民(2026-10-30 左下角思考指示的真态来源):群聊按群串行,
 *  同群至多一个活跃回合;恢复场景(@所有人轮到第几位)拿不到,queue 置 0 由后续事件自我纠正 */
export function groupThinking(groupId: string): GroupThinkingState | null {
  for (const key of groupActive.keys()) {
    if (!key.startsWith(`${groupId}:`)) continue
    const bot = getBot(key.slice(groupId.length + 1))
    return bot ? { botId: bot.id, botName: bot.name, queue: 0 } : null
  }
  return null
}

/** 群历史 + 思考真态:界面挂载(切走再切回)时恢复指示条/停止键 */
export function groupHistory(groupId: string): GroupHistoryResult {
  return { messages: listGroupMessages(groupId), thinking: groupThinking(groupId) }
}

/** 群消息预算(件 4,2026-10-28,deepseek-bot relay 预算移植):自岛主上次在该群发言以来的
 *  bot 消息总数(应答与上墙都计,免加列区分触发源);到 3×成员数即「暂停不丢弃」——
 *  post_to_group 返回劝阻文案,岛主下次在群里开口计数自然清零(重新数最新 user 消息之后的 bot 行) */
export function groupMessageBudget(group: GroupInfo): { count: number; limit: number } {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM group_messages
       WHERE group_id = ? AND sender_type = 'bot'
         AND id > COALESCE((SELECT MAX(id) FROM group_messages WHERE group_id = ? AND sender_type = 'user'), 0)`
    )
    .get(group.id, group.id) as { n: number }
  return { count: row.n, limit: 3 * group.members.length }
}

export function insertGroupMessage(
  groupId: string,
  senderType: 'user' | 'bot',
  botId: string | null,
  content: string,
  attachments?: MessageAttachment[],
  meta?: QuoteMeta
): GroupMessage {
  const db = getDb()
  const info = db
    .prepare(
      'INSERT INTO group_messages (group_id, sender_type, bot_id, content, created_at, attachments, meta) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      groupId,
      senderType,
      botId,
      content,
      nowIso(),
      attachments && attachments.length > 0 ? JSON.stringify(attachments) : null,
      meta ? JSON.stringify(meta) : null
    )
  const row = db
    .prepare('SELECT * FROM group_messages WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as GroupMessageRow
  return toMessage(row, botLookups())
}

// ---- 回合调度 ----

const chains = new Map<string, Promise<void>>()
const groupActive = new Map<string, AbortController>()

/** M5.6:停止该群所有进行中的成员回合 */
export function stopGroup(groupId: string): void {
  for (const [key, controller] of groupActive) {
    if (key.startsWith(`${groupId}:`)) controller.abort(new Error('stopped'))
  }
}

/** 有任一成员回合进行中的群 id 集合(2026-10-30 列表实时状态):消息列表群行显示「讨论中」的依据。
 *  群级布尔,不透出是谁——「谁在想」归群聊界面左下角指示条(GroupTurnStart),两层粒度互补 */
export function busyGroupIds(): Set<string> {
  const ids = new Set<string>()
  for (const key of groupActive.keys()) ids.add(key.slice(0, key.indexOf(':')))
  return ids
}

/** 回合生命周期广播(2026-10-30 列表实时状态):groupActive 增删处调用(与 chat.ts 单聊侧同构) */
function broadcastTurnChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EV.TurnChanged)
}

/** M5.7:群消息按到达顺序串行处理,后来的排队,不打断进行中的发言 */
export function groupSend(
  groupId: string,
  text: string,
  sender: WebContents,
  attachments?: MessageAttachment[],
  quotes?: ChatQuote[]
): void {
  const previous = chains.get(groupId) ?? Promise.resolve()
  const task: Promise<void> = previous
    .then(() => processGroupMessage(groupId, text, sender, attachments, quotes))
    .catch((err) => console.error('[group]', err))
    .finally(() => {
      if (chains.get(groupId) === task) chains.delete(groupId)
    })
  chains.set(groupId, task)
}

async function processGroupMessage(
  groupId: string,
  text: string,
  sender: WebContents,
  attachments?: MessageAttachment[],
  quotes?: ChatQuote[]
): Promise<void> {
  const group = getGroup(groupId)
  if (!group || group.members.length === 0) return
  const trimmed = text.trim()
  const atts = (attachments ?? []).filter((a) => a && typeof a.path === 'string' && a.path)
  // 选区引用(2026-11-02):服务端净化,与单聊同闸;引用单独成条也算有效消息
  const safeQuotes = sanitizeQuotes(quotes)
  if (!trimmed && atts.length === 0 && safeQuotes.length === 0) return

  const message =
    safeQuotes.length > 0
      ? insertGroupMessage(groupId, 'user', null, trimmed, atts, { quotes: safeQuotes })
      : insertGroupMessage(groupId, 'user', null, trimmed, atts)
  sender.send(EV.GroupUserAdded, { groupId, message } satisfies GroupUserAddedEvent)

  // M5.2/M5.3:@点名(含 @所有人/@大家)优先;否则值守管理员应答
  const atAll = /@(所有人|大家|全部)/.test(trimmed)
  const mentioned = group.members.filter((m) => trimmed.includes(`@${m.name}`))
  const targets = atAll
    ? group.members
    : mentioned.length > 0
      ? mentioned
      : [group.members.find((m) => m.id === group.adminBotId) ?? group.members[0]!]

  for (const [i, bot] of targets.entries()) {
    // queue=排在后面的居民数:TurnStart 载荷给「后面还有 N 位」提示用
    await runGroupTurn(bot, group, sender, message, targets.length - 1 - i)
  }
}

/** 群聊上下文组装(A1+A2,2026-10-28):群系统提示 + 记忆 + 群摘要检查点 +
 *  截断点后窗口内转写;相邻消息跨自然日或隔超阈值时插时间锚行,结尾带当前时间行。
 *  时间锚以 user 行插入——群转写里岛主与其他居民本就都是 user,群系统提示只保持头部一条 */

/** 行内选区引用(2026-11-02):读侧解析+净化,损坏/为空返回 undefined */
function quoteMetaOf(row: GroupMessageRow): QuoteMeta | undefined {
  if (!row.meta || row.sender_type !== 'user') return undefined
  try {
    const quotes = sanitizeQuotes((JSON.parse(row.meta) as QuoteMeta).quotes)
    return quotes.length > 0 ? { quotes } : undefined
  } catch {
    return undefined
  }
}

function buildGroupTurnContext(
  bot: Bot,
  group: GroupInfo,
  roster: RosterEntry[],
  space: ReturnType<typeof getSpace>,
  limit = GROUP_TURN_WINDOW
): LlmMessage[] {
  const admin = group.members.find((m) => m.id === group.adminBotId)
  const context: LlmMessage[] = [
    {
      role: 'system',
      content: buildGroupSystemPrompt(bot, space, roster, {
        name: group.name,
        announcement: group.announcement,
        adminName: admin?.name ?? 'Momo'
      })
    }
  ]
  const memory = memoryNote(bot.id)
  if (memory) context.push({ role: 'system', content: memory })
  const { summary, cutoffId } = groupSummaryRow(group.id)
  if (summary && (cutoffId ?? 0) > 0) {
    context.push({ role: 'system', content: `[本群更早对话的摘要,仅供参考,不要主动复述]\n${summary}` })
  }
  const names = new Map(listBots().map((b) => [b.id, b.name]))
  const rows = groupTailMessages(group.id).slice(-limit)
  // 件 5(2026-10-28):窗口内较早的消息按字符截断注入、最近 GROUP_TURN_RECENT_FULL 条全文,
  // 长交付物不再整条吃窗;群消息落库原文永不截,岛主看到的群记录始终完整,截断含居民自己的旧发言
  const fullFrom = Math.max(0, rows.length - GROUP_TURN_RECENT_FULL)
  let prev: { created_at: string } | null = null
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i]!
    if (prev) {
      const marker = gapMarker(prev.created_at, m.created_at)
      if (marker) context.push({ role: 'user', content: marker })
    }
    const body =
      i < fullFrom && m.content.length > GROUP_TURN_CLIP_CHARS
        ? `${m.content.slice(0, GROUP_TURN_CLIP_CHARS)}…(已截断,全文见群记录)`
        : m.content
    // 附件说明行(2026-10-29):岛主在群里发的文件/文件夹/图片,与单聊同款标记行拼在正文后;
    // 选区引用块(2026-11-02)同机制随后(群转写窗口内持续可见,含被截断的较早消息)
    const note =
      m.sender_type === 'user'
        ? attachmentLines(parseAttachments(m.attachments)) + quoteLines(quoteMetaOf(m)?.quotes)
        : ''
    if (m.sender_type === 'user') {
      context.push({ role: 'user', content: `岛主: ${body}${note}` })
    } else if (m.bot_id === bot.id) {
      context.push({ role: 'assistant', content: body })
    } else {
      context.push({ role: 'user', content: `「${(m.bot_id && names.get(m.bot_id)) ?? '居民'}」:${body}` })
    }
    prev = m
  }
  context.push({ role: 'user', content: currentTimeLine() })
  return context
}

/** 本轮岛主消息里的图片内联进群上下文:替换最后一条带该消息 id 说明行的「岛主: …」条目为多模态分段 */
function inlineGroupImages(
  context: LlmMessage[],
  current: GroupMessage
): LlmMessage[] {
  const images = (current.attachments ?? []).filter((a) => a.kind === 'image')
  if (images.length === 0 || context.length === 0) return context
  // 从后往前找最后一条以「岛主: 」开头的 user 条目(本轮消息是窗口里最后一条 user 转写,
  // currentTimeLine 也是 user 行但内容是时间标记,跳过)
  for (let i = context.length - 1; i >= 0; i--) {
    const m = context[i]!
    if (m.role !== 'user' || typeof m.content !== 'string' || !m.content.startsWith('岛主: ')) continue
    const parts: LlmContentPart[] = [{ type: 'text', text: m.content }]
    for (const img of images) {
      const part = readImageDataUrl(img)
      if (part) parts.push(part)
    }
    if (parts.length === 1) return context
    const next = context.slice()
    next[i] = { ...m, content: parts }
    return next
  }
  return context
}

async function runGroupTurn(
  bot: Bot,
  group: GroupInfo,
  sender: WebContents,
  current?: GroupMessage,
  queue = 0
): Promise<void> {
  const key = `${group.id}:${bot.id}`
  if (groupActive.has(key)) return
  // 左下角思考指示(2026-10-30):回合一开跑就亮「X 正在想」——群聊用户消息到首段正文之间
  // 原本零事件(排队/思考/工具执行全静默);正文流出后指示让位给实时气泡,结束随 Done/Error 清场。
  // 无 Key 早退路径紧随 GroupError,指示一闪即灭,无害
  sender.send(EV.GroupTurnStart, {
    groupId: group.id,
    botId: bot.id,
    botName: bot.name,
    queue
  } satisfies GroupTurnStartEvent)

  const provider = getProvider(bot.providerId)
  const creds = llmCredentials(bot.providerId)
  if (!provider || !creds.apiKey) {
    const error =
      bot.providerId === 'archipelago' ? `${bot.name} 登录已失效,请退出后重新登录` : `${bot.name} 尚未配置模型 API Key`
    sender.send(EV.GroupError, { groupId: group.id, error } satisfies GroupErrorEvent)
    return
  }
  // 群岛通道端点随 SEA 环境走(同单聊);带 x-island-uid 便于运营按岛对账
  const effectiveProvider = { ...provider, baseUrl: creds.baseUrl }
  const apiKey = creds.apiKey // 判空收窄提为 const,供下方 runLoop 闭包使用
  const islandUid = bot.providerId === 'archipelago' ? currentIslandUid() : null

  const space = getSpace()
  const roster = listBots().map((b) => ({ name: b.name, role: b.role, archetype: archetypeName(b.archetype), isMain: b.isMain }))

  // 转写群聊记录:岛主与其他居民对 Bot 来说都是"对方",自己的发言是 assistant
  const controller = new AbortController()
  groupActive.set(key, controller)
  broadcastTurnChanged()
  // MCP 连接器暖连接(与单聊 chat.ts 同款):toolsFor 是同步读缓存,冷启动后直接进群聊,
  // 居民的连接器工具要等到某次单聊碰巧建连才会出现——回合开始前先暖一次
  await warmMcpToolsForBot(bot.id)
  const runLoop = (ctx: LlmMessage[]) =>
    runToolLoop(bot, {
      provider: effectiveProvider,
      apiKey,
      headers: islandUid ? { 'x-island-uid': islandUid } : undefined,
      context: ctx,
      tools: toolsFor(bot, 0, 'group'),
      depth: 0,
      signal: controller.signal,
      // 群聊场景标识(2026-10-29 定时任务):群里交代的任务登记时记来源群,执行仍在单聊
      chat: `group:${group.id}`,
      emit: {
        onDelta: (chunk) =>
          sender.send(EV.GroupDelta, { groupId: group.id, botId: bot.id, botName: bot.name, text: chunk } satisfies GroupDeltaEvent),
        // 步界(2026-10-28 拍板修订):群聊只发最后结论,中间步文字界面清空,过程反馈交还左下角思考指示
        onStep: () =>
          sender.send(EV.GroupStep, { groupId: group.id, botId: bot.id, botName: bot.name } satisfies GroupStepEvent)
      },
      onUsage: (chars, u) => recordPromptUsage(`group:${group.id}`, chars, u.promptTokens)
    })
  const baseContext = buildGroupTurnContext(bot, group, roster, space)
  // 图片内联(2026-10-29):本轮岛主消息里的图附在群转写的最后一条「岛主: …」条目上;
  // 模型不认图时撤掉内联只留 [图片] 路径说明行重试一次(与单聊同款降级)
  const contextWithImages = current ? inlineGroupImages(baseContext, current) : baseContext
  let result = await runLoop(contextWithImages)
  if (
    contextWithImages !== baseContext &&
    !result.ok &&
    !result.text.trim() &&
    result.error &&
    isImageUnsupportedError(String(result.error.message))
  ) {
    result = await runLoop(baseContext)
  }
  // 超长兜底(B3):强制群压缩(压不动就算了)后降到降窗条数重试一次
  if (!result.ok && !result.text.trim() && result.error instanceof ContextTooLongError) {
    await forceCompactGroup(bot, group.id).catch(() => false)
    result = await runLoop(buildGroupTurnContext(bot, group, roster, space, GROUP_RETRY_WINDOW))
  }
  groupActive.delete(key)
  broadcastTurnChanged()
  // 「本回合不再问」的免问表按回合生效:单聊在 chat.ts 收尾清,群聊回合同样要清——
  // 否则群聊里点过一次的免问会泄漏到该居民后续所有回合(群聊与单聊共用 botId 键)
  clearTurnApprovals(bot.id)

  // 回合进行中群可能被解散(半自动档经审批、全自动档直接):落库前核验群还在
  if (!getGroup(group.id)) {
    groupActive.delete(key)
    return
  }

  if ((result.ok || result.text.trim()) && result.text.trim()) {
    const saved = insertGroupMessage(group.id, 'bot', bot.id, result.text.trim())
    sender.send(EV.GroupDone, { groupId: group.id, botId: bot.id, message: saved } satisfies GroupDoneEvent)
    notifyIfBlurred(sender, `${group.name} · ${bot.name}`, result.text.trim().slice(0, 60))
    // 记忆被动整理(群聊版):与本轮发言一并过一遍记忆管家,只记岛主在群里亲口说的
    const transcript = listGroupMessages(group.id)
      .slice(-12)
      .map((m) => (m.senderType === 'user' ? `岛主: ${m.content}` : `「${m.botName ?? '居民'}」:${m.content}`))
      .join('\n')
    void reviewGroupTurn(bot, transcript).catch(() => undefined)
    // 群聊压缩检查点(A1):条数超窗后异步把早期群聊压成每群一份的摘要
    void compactGroupIfNeeded(bot, group.id).catch((err) => {
      console.error('[steward] 群聊压缩失败:', err)
    })
  } else if (result.ok) {
    sender.send(EV.GroupDone, { groupId: group.id, botId: bot.id, message: null } satisfies GroupDoneEvent)
  } else {
    // 解散自身的回合被停止属正常路径(dissolve_group 先停群再删),群已不在就不再报「已停止」
    if (result.aborted && !getGroup(group.id)) return
    sender.send(EV.GroupError, {
      groupId: group.id,
      error: result.aborted
        ? `已停止 ${bot.name}`
        : result.error instanceof ContextTooLongError
          ? '这段群聊太长了，让居民把之前的内容总结一下，或者开个新话题吧'
          : `${bot.name} 没有回应,请重试`,
      // RelayError.code 随行透传:群聊上游故障不再一律折叠成「没有回应」(渲染端映射人话,2026-11-03)
      code: !result.aborted && result.error instanceof RelayError ? result.error.code : undefined
    } satisfies GroupErrorEvent)
  }
}
