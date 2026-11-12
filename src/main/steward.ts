import type { Bot, ChatMessage, QuoteMeta, SpaceInfo } from '@shared/types'
import { findModel } from '@shared/providers'
import { quoteLines } from '@shared/quote-core'
import type { LlmMessage } from './llm'
import { chatOnce, llmContentChars, llmCredentials } from './llm'
import { cloudModelWindow } from './auth'
import { listBots } from './bots'
import { archetypeName } from '@shared/archetypes'
import { memoryNote } from './memory'
import { getDb, nowIso } from './store'
import { getSpace } from './space'
import { listMessages, type SessionRow } from './sessions'
import { attachmentLines } from './attachments'
import { STEWARD_SYSTEM_PROMPT, buildStewardUserPrompt, buildSystemPrompt, type RosterEntry } from './prompts'

// 上下文管家(§7.1 + 2026-10-28 时间感知/群聊压缩/超长兜底三需求):
// - 估算上下文 token,超过水位线(0.8 × 可用窗口)时把早期对话压缩成检查点摘要
// - 摘要与截断点存进 sessions 表,下次组装上下文时注入
// - 单聊历史按 created_at 插时间锚(跨自然日或隔超阈值)、尾部带当前时间行(件 1/2)
// - 群聊压缩检查点(A1):groups 表存每群一份的摘要与截断点,条数超窗触发
// - 超长兜底(B3):forceCompact/forceCompactGroup 供模型侧拒了超长请求后同步压缩重试
// - 全量消息(含 Bot 间私信)仍留在库里,UI 始终呈现一条连续聊天(M3.2)

const KEEP_TAIL_BUDGET = 4000 // 压缩时末尾按字符预算保留的逐字消息(P2:替代固定 8 条,长消息不致留太少)
const FORCE_KEEP_BUDGET = 1200 // 强制压缩(B3)用更小的尾部预算:超长恢复要压得更狠
const REPLY_RESERVE = 4096 // 回复预留(可用窗口 = 窗口 − 预留)
const CHARS_PER_TOKEN = 1.4 // 中文为主的保守估算(真实 usage 校准后按会话比率覆盖)
const FAMILIAR_MESSAGE_COUNT = 40 // 熟络档位(0.8 L2):累计对话消息(约 20 个回合)达标即升温;换性格不清零
const GAP_MIN_MS = 30 * 60 * 1000 // 历史时间锚阈值:相邻消息隔 30 分钟以上(或跨自然日)插一行
const GROUP_WINDOW = 120 // 群聊转写窗口(条数,现状保留):截断点后的消息取最近这么多条
const GROUP_COMPACT_KEEP = 80 // 群聊压缩后逐字保留的条数(触发线 = 截断点后条数 > GROUP_WINDOW)
const GROUP_FALLBACK_WINDOW = 60 // 群聊超长重试(B3)的降窗条数
const GROUP_FULL_RECENT = 20 // 群转写字符预算(件 5):窗口内最近这么多条注入全文
const GROUP_CLIP_CHARS = 300 // 群转写字符预算(件 5):更早的每条截到这么多字符——落库原文不截,仅组装上下文时截

export type { SessionRow }

// ---- 时间锚(2026-10-28 单聊时间感知):组装时按 created_at 动态计算,不落库 ----
// 零迁移,存量历史全量受益;标记内容只依赖两条消息的 created_at,同一历史每次组装逐字一致,
// 不打散 provider prompt cache 前缀;当前时间行在数组尾部,变化只发生在最后几十 token

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 绝对时间锚:10-27(周一) 09:15(本地时区) */
export function timeAnchor(iso: string): string {
  const d = new Date(iso)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}(${WEEKDAY_NAMES[d.getDay()]}) ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 摘要 transcript 用的短时间前缀:[10-26 09:15] */
function shortTime(iso: string): string {
  const d = new Date(iso)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 人性化间隔:约 40 分钟 / 约 3 小时 / 约 1 天 / 约 1 天 3 小时 */
function humanGap(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)} 小时`
  const days = Math.floor(hours / 24)
  const remHours = Math.round(hours - days * 24)
  return remHours >= 1 ? `${days} 天 ${remHours} 小时` : `${days} 天`
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 相邻两条消息之间的时间标记行(件 1);间隔不足且未跨自然日时返回 null(不插)
 *  单聊以 system 行插入,群聊以 user 行插入(群转写里岛主与其他居民本就都是 user) */
export function gapMarker(prevIso: string, nextIso: string): string | null {
  const prev = new Date(prevIso)
  const next = new Date(nextIso)
  if (Number.isNaN(prev.getTime()) || Number.isNaN(next.getTime())) return null
  const diff = next.getTime() - prev.getTime()
  if (diff <= 0) return null // 时钟回拨/同刻消息不插,防出负数时长
  if (diff < GAP_MIN_MS && isSameLocalDay(prev, next)) return null
  return `[—— 已过约 ${humanGap(diff)} · 以下是 ${timeAnchor(nextIso)} 起的对话 ——]`
}

/** 当前时间行(件 2):让模型知道"现在"是几点,才能把历史时间锚换算成远近 */
export function currentTimeLine(now = new Date()): string {
  return `[当前时间:${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}(${WEEKDAY_NAMES[now.getDay()]}) ${pad2(now.getHours())}:${pad2(now.getMinutes())}]`
}

// ---- token 估算与真实用量校准(B2) ----
// 用模型返回的 prompt usage 反推 chars/token 比率,内存级缓存不落库,只影响水位线估算;
// 无样本时按 1.4 兜底(pi 同款思路;比率是语言构成属性,内容变化不需要作废)

const charsPerTokenByKey = new Map<string, number>()

export function recordPromptUsage(key: string, promptChars: number, promptTokens: number): void {
  if (promptTokens < 200 || promptChars <= 0) return // 样本太小不稳定
  const ratio = promptChars / promptTokens
  if (ratio > 0.3 && ratio < 6) charsPerTokenByKey.set(key, ratio) // 明显异常的值丢弃
}

export function estimateTokensFor(key: string, text: string): number {
  return Math.ceil(text.length / (charsPerTokenByKey.get(key) ?? CHARS_PER_TOKEN))
}

let watermarkForTests: number | null = null

/** 冒烟测试专用:压低水位线触发压缩路径;传 null 恢复 */
export function setWatermarkForTests(v: number | null): void {
  watermarkForTests = v
}

/** 组装发给模型的上下文:系统提示 + 记忆 + 检查点摘要 + 截断点之后的逐字消息(带时间锚) */
export function buildContextMessages(
  bot: Bot,
  space: SpaceInfo | null,
  roster: RosterEntry[],
  session: SessionRow,
  history: ChatMessage[]
): LlmMessage[] {
  // 熟络档位(0.8 L2):按累计对话量判定,不落库不评分;history 来自全量消息表,不受压缩影响
  const familiar = history.filter((m) => m.kind === 'chat' || m.kind === 'relation').length >= FAMILIAR_MESSAGE_COUNT
  const messages: LlmMessage[] = [{ role: 'system', content: buildSystemPrompt(bot, space, roster, familiar) }]
  const memory = memoryNote(bot.id)
  if (memory) messages.push({ role: 'system', content: memory })
  const cutoff = session.cutoffId ?? 0
  if (session.summary && cutoff > 0) {
    messages.push({
      role: 'system',
      content: `[上下文检查点 · 此前对话的摘要,仅供参考,不要主动复述]\n${session.summary}`
    })
  }
  let prev: ChatMessage | null = null
  for (const m of history) {
    // 审批卡与工具事件行是 UI 事件:工具结果已通过 tool 消息进入上下文,这里不重复注入
    if (m.id > cutoff && (m.kind === 'chat' || m.kind === 'relation')) {
      if (prev) {
        const marker = gapMarker(prev.createdAt, m.createdAt)
        if (marker) messages.push({ role: 'system', content: marker })
      }
      // 附件说明行(2026-10-29 输入框升级):岛主随消息发的文件/文件夹/图片,以「[附件]/[图片] 路径」
      // 行拼在正文后——模型按需用 read_file/list_dir 读,图片当轮由 runTurnInner 内联成多模态分段
      // 选区引用块(2026-11-02)同机制随后:历史轮次持续可见,压缩时随消息进摘要语境
      const note = m.role === 'user' ? attachmentLines(m.attachments) + quoteLines((m.meta as QuoteMeta | undefined)?.quotes) : ''
      messages.push({ role: m.role, content: `${m.content}${note}` })
      prev = m
    }
  }
  // 当前时间行(件 2):最后一条消息之后——模型据此把上面的时间锚换算成"刚才/昨天/前天"
  messages.push({ role: 'system', content: currentTimeLine() })
  return messages
}

function currentRoster(): RosterEntry[] {
  return listBots().map((b) => ({ name: b.name, role: b.role, archetype: archetypeName(b.archetype), isMain: b.isMain }))
}

function contextTokens(key: string, bot: Bot, space: SpaceInfo | null, session: SessionRow, tail: ChatMessage[]): number {
  const messages = buildContextMessages(bot, space, currentRoster(), session, tail)
  // 与 estimateTokensFor 同式,但正文可能是多模态分段(图片按 0 字符计,视觉 token 由真实用量回传校准)
  const charsPerToken = charsPerTokenByKey.get(key) ?? CHARS_PER_TOKEN
  return messages.reduce((sum, m) => sum + Math.ceil(llmContentChars(m.content) / charsPerToken) + 8, 0)
}

/** 模型上下文窗口(B1,2026-10-28):云端目录优先(窗口跟运营配置下发,挂载/登录时刷新缓存),
 *  未拉到或未配窗口回落本地目录(遗留兜底),再回落 128k(findModel 的保守默认) */
export function contextWindowOf(bot: Bot): number {
  return cloudModelWindow(bot.modelId) ?? findModel(bot.providerId, bot.modelId).contextWindow
}

function dmTail(session: SessionRow): ChatMessage[] {
  const cutoff = session.cutoffId ?? 0
  return listMessages(session.id).filter((m) => m.id > cutoff && (m.kind === 'chat' || m.kind === 'relation'))
}

/** 末尾按字符预算保留的逐字起点下标(P2:替代固定 8 条):
 *  至少保住最后一问一答,再按预算往前扩;预算小到装不下两条时仍保两条(转写不能只剩半截) */
function keepTailFrom<T extends { content: string }>(items: T[], budget: number): number {
  let acc = 0
  let i = items.length
  while (i > 0) {
    const len = items[i - 1]!.content.length
    if (items.length - i >= 2 && acc + len > budget) break
    acc += len
    i--
  }
  return i
}

/** 单聊压缩核心:transcript 行带短时间前缀(件 3),摘要要求首行时间范围;
 *  finish_reason=length 的半截摘要拒绝落盘(P2-1),下回合重试 */
async function summarizeDm(bot: Bot, session: SessionRow, tail: ChatMessage[], keepFrom: number): Promise<boolean> {
  const toSummarize = tail.slice(0, keepFrom)
  if (toSummarize.length < 4) return false // 太少不值得压缩
  const creds = llmCredentials(bot.providerId)
  if (!creds.apiKey) return false

  const space = getSpace()
  const owner = space?.ownerName?.trim() || '岛主'
  const transcript = toSummarize
    .map((m) => `[${shortTime(m.createdAt)}] ${m.role === 'user' ? owner : bot.name}: ${m.content}`)
    .join('\n')

  const messages: LlmMessage[] = [
    { role: 'system', content: STEWARD_SYSTEM_PROMPT },
    { role: 'user', content: buildStewardUserPrompt(session.summary, transcript) }
  ]
  const result = await chatOnce({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    model: bot.modelId,
    maxTokens: 600,
    temperature: 0.3,
    messages
  })
  // 压缩调用也是校准样本:管家 prompt 与主对话语言构成接近
  const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0)
  if (result.usage) recordPromptUsage(session.id, promptChars, result.usage.promptTokens)
  if (result.finishReason === 'length') {
    console.error('[steward] 摘要被截断(finish_reason=length),本次放弃,下回合重试')
    return false
  }
  const summary = result.content.trim()
  if (!summary) return false

  const newCutoff = toSummarize[toSummarize.length - 1]!.id
  // 条件写回(2026-11-06 codex 审查修复):压缩调用是长 await,期间同会话可能已完成更新的
  // 一轮压缩(如上回合异步 compactIfNeeded 与本回合超长兜底 forceCompact 并发)——无条件
  // 写回会让晚归的旧摘要把 cutoff 拉回、覆盖新摘要。快照 cutoff 未变才落盘,被推进过就放弃
  // (放弃无损:下回合仍超水位会重试)
  const written = getDb()
    .prepare('UPDATE sessions SET summary = ?, cutoff_id = ?, updated_at = ? WHERE id = ? AND cutoff_id IS ?')
    .run(summary, newCutoff, nowIso(), session.id, session.cutoffId)
  if (written.changes === 0) {
    console.warn('[steward] 摘要写回跳过:cutoff 已被并发压缩推进,保留较新的结果')
    return false
  }
  getDb()
    .prepare('INSERT INTO context_events (session_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(
      session.id,
      'compact',
      JSON.stringify({ summarized: toSummarize.length, cutoff: newCutoff, tokensEstimated: true }),
      nowIso()
    )
  return true
}

/** 一轮结束后调用;超水位线则压缩,返回是否发生了压缩 */
export async function compactIfNeeded(bot: Bot, session: SessionRow): Promise<boolean> {
  const usable = contextWindowOf(bot) - REPLY_RESERVE
  const watermark = watermarkForTests ?? usable * 0.8

  const tail = dmTail(session)
  if (contextTokens(session.id, bot, getSpace(), session, tail) < watermark) return false
  return summarizeDm(bot, session, tail, keepTailFrom(tail, KEEP_TAIL_BUDGET))
}

/** 超长兜底(B3):模型侧拒了超长请求后同步强制压缩(不看水位线,尾部预算更小)。
 *  已无可压缩的早期消息时返回 false,由调用方给用户明确文案 */
export async function forceCompact(bot: Bot, session: SessionRow): Promise<boolean> {
  const tail = dmTail(session)
  return summarizeDm(bot, session, tail, keepTailFrom(tail, FORCE_KEEP_BUDGET))
}

// ---- 群聊压缩检查点(A1):摘要每群一份、全体成员共用,存 groups 表 ----

interface GroupMsgRow {
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

export function groupSummaryRow(groupId: string): { summary: string | null; cutoffId: number | null } {
  const row = getDb().prepare('SELECT summary, cutoff_id FROM groups WHERE id = ?').get(groupId) as
    | { summary: string | null; cutoff_id: number | null }
    | undefined
  return { summary: row?.summary ?? null, cutoffId: row?.cutoff_id ?? null }
}

/** 群聊转写素材:截断点之后的群消息(升序);转写与压缩共用 */
export function groupTailMessages(groupId: string): GroupMsgRow[] {
  const cutoff = groupSummaryRow(groupId).cutoffId ?? 0
  const rows = getDb()
    .prepare('SELECT * FROM group_messages WHERE group_id = ? ORDER BY id ASC')
    .all(groupId) as GroupMsgRow[]
  return rows.filter((r) => r.id > cutoff)
}

function groupSenderName(row: GroupMsgRow, names: Map<string, string>): string {
  if (row.sender_type === 'user') return '岛主'
  return (row.bot_id && names.get(row.bot_id)) ?? '居民'
}

async function summarizeGroup(
  bot: Bot,
  groupId: string,
  tail: GroupMsgRow[],
  keepFrom: number,
  start: { summary: string | null; cutoffId: number | null }
): Promise<boolean> {
  const toSummarize = tail.slice(0, keepFrom)
  if (toSummarize.length < 4) return false
  const creds = llmCredentials(bot.providerId)
  if (!creds.apiKey) return false

  const names = new Map(listBots().map((b) => [b.id, b.name]))
  const transcript = toSummarize
    .map((r) => `[${shortTime(r.created_at)}] ${groupSenderName(r, names)}: ${r.content}`)
    .join('\n')
  const messages: LlmMessage[] = [
    { role: 'system', content: STEWARD_SYSTEM_PROMPT },
    { role: 'user', content: buildStewardUserPrompt(start.summary, transcript) }
  ]
  const result = await chatOnce({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    model: bot.modelId,
    maxTokens: 600,
    temperature: 0.3,
    messages
  })
  if (result.finishReason === 'length') {
    console.error('[steward] 群聊摘要被截断(finish_reason=length),本次放弃')
    return false
  }
  const summary = result.content.trim()
  if (!summary) return false

  const newCutoff = toSummarize[toSummarize.length - 1]!.id
  // 条件写回(与单聊同款守卫):快照 cutoff 未变才落盘,并发压缩推进过就放弃、下轮重试
  const written = getDb()
    .prepare('UPDATE groups SET summary = ?, cutoff_id = ? WHERE id = ? AND cutoff_id IS ?')
    .run(summary, newCutoff, groupId, start.cutoffId)
  if (written.changes === 0) {
    console.warn('[steward] 群摘要写回跳过:cutoff 已被并发压缩推进,保留较新的结果')
    return false
  }
  getDb()
    .prepare("INSERT INTO context_events (session_id, kind, detail, created_at) VALUES (?, 'group-compact', ?, ?)")
    .run(groupId, JSON.stringify({ summarized: toSummarize.length, cutoff: newCutoff }), nowIso())
  return true
}

/** 群聊成员回合结束后异步压缩:条数超过窗口余量触发(主),token 水位兜底(次) */
export async function compactGroupIfNeeded(bot: Bot, groupId: string): Promise<boolean> {
  const start = groupSummaryRow(groupId) // 快照 cutoff,作条件写回的守卫
  const tail = groupTailMessages(groupId)
  const byCount = tail.length > GROUP_WINDOW
  const byTokens =
    tail.reduce((sum, r) => sum + estimateTokensFor(`group:${groupId}`, r.content) + 8, 0) >
    (watermarkForTests ?? (contextWindowOf(bot) - REPLY_RESERVE) * 0.8)
  if (!byCount && !byTokens) return false
  const keepFrom = byCount ? Math.max(0, tail.length - GROUP_COMPACT_KEEP) : keepTailFrom(tail, KEEP_TAIL_BUDGET)
  return summarizeGroup(bot, groupId, tail, keepFrom, start)
}

/** 群聊超长兜底(B3):压缩后仍超长时,转写再降到降窗条数 */
export async function forceCompactGroup(bot: Bot, groupId: string): Promise<boolean> {
  const start = groupSummaryRow(groupId) // 快照 cutoff,作条件写回的守卫
  const tail = groupTailMessages(groupId)
  return summarizeGroup(bot, groupId, tail, keepTailFrom(tail, FORCE_KEEP_BUDGET), start)
}

export const GROUP_TURN_WINDOW = GROUP_WINDOW
export const GROUP_RETRY_WINDOW = GROUP_FALLBACK_WINDOW
export const GROUP_TURN_RECENT_FULL = GROUP_FULL_RECENT
export const GROUP_TURN_CLIP_CHARS = GROUP_CLIP_CHARS
