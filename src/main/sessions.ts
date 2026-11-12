import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type {
  ChatMessage,
  ChatRole,
  ExchangeDetail,
  ExchangeRound,
  MessageAttachment,
  RelationMeta,
  ToolEventMeta
} from '@shared/types'
import { EV } from '@shared/ipc-channels'
import { getDb, nowIso } from './store'
import { getBot, listBots } from './bots'
import { parseAttachments } from '@shared/attachments-core'
import { sanitizeQuotes } from '@shared/quote-core'

// 会话与消息持久化,供 chat / steward / tools 三个模块共用
// 居民间私信以 kind='relation' 的消息行落库:进 Bot 上下文(带 [发给/来自/回复 X] 前缀),
// 同时在双方的聊天窗口里以事件行内联展示(DS Bot 式,铁律 1:永远可见)
// 一次 send_message 的各行共用 exchange_id:上下文/检索仍逐行,界面按交流折叠为单气泡
// 工具动作以 kind='tool' 落库:只进界面不进上下文(工具结果已经以 tool 消息进过模型)
// 思考过程以 kind='reasoning' 落库(方案 C):每步一行、正文放 reasoning 列(content 留空不进 FTS),
// 与工具行按 id 序穿插;回合内全部行共用 turn_id,界面按回合折叠过程
// 中间步正文旁白以 kind='note' 落库(2026-10-28 拍板修订):带工具调用的步骤产出的过渡性文字,
// 待遇同思考行(文字放 reasoning 列、不进 FTS/上下文),折进回合时间线,最终回复只留末步正文

export interface SessionRow {
  id: string
  botId: string
  kind: string
  /** 任务会话(2026-11-06「新建任务」):kind='task' 时 ref=task_threads.id;普通会话恒 null */
  ref: string | null
  summary: string | null
  cutoffId: number | null
  createdAt: string
  updatedAt: string
}

interface MessageRow {
  id: number
  session_id: string
  role: string
  content: string
  reasoning: string | null
  created_at: string
  hidden: number
  kind: string
  meta: string | null
  exchange_id: string | null
  turn_id: string | null
  attachments: string | null
}

type MessageKind = NonNullable<ChatMessage['kind']>
type MessageMeta = NonNullable<ChatMessage['meta']>

function kindFromRow(kind: string): MessageKind {
  return kind === 'relation' || kind === 'approval' || kind === 'tool' || kind === 'reasoning' || kind === 'note' ? kind : 'chat'
}

function messageFromRow(row: MessageRow): ChatMessage {
  let meta: MessageMeta | undefined
  if (row.meta) {
    try {
      const parsed = JSON.parse(row.meta) as MessageMeta
      if (row.kind === 'relation' && 'dir' in parsed && ['out', 'in', 'reply', 'reply-in'].includes(parsed.dir)) {
        meta = parsed
      } else if (row.kind === 'approval' && 'approvalId' in parsed && parsed.status) {
        meta = parsed
      } else if (row.kind === 'tool' && 'toolName' in parsed && parsed.status) {
        meta = parsed
      } else if (row.kind === 'reasoning' && 'durationMs' in parsed) {
        meta = parsed
      } else if (row.kind === 'chat' && 'taskId' in parsed && typeof parsed.taskId === 'string') {
        meta = parsed
      } else if (row.kind === 'chat' && 'stopped' in parsed) {
        meta = parsed
      } else if (row.kind === 'chat' && 'quotes' in parsed && Array.isArray(parsed.quotes)) {
        // 选区引用(2026-11-02):落库时已 sanitize,读侧再过一遍闸(库文件可能被手改)
        const quotes = sanitizeQuotes(parsed.quotes)
        if (quotes.length > 0) meta = { quotes }
      } else if (row.kind === 'chat' && 'relay' in parsed && parsed.relay && typeof parsed.relay.peer === 'string') {
        // 唤醒转述(回复唤醒,2026-11-06 codex 审查修复补读侧):转述消息的「收到回信」小签
        // 依赖 relay 元数据,此前读侧白名单漏了它(写侧一直在落,读出来全丢)
        meta = {
          relay: {
            peer: parsed.relay.peer,
            ...(typeof parsed.relay.exchangeId === 'string' ? { exchangeId: parsed.relay.exchangeId } : {})
          }
        }
      }
    } catch {
      // meta 损坏时按无 meta 处理
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    reasoning: row.reasoning,
    createdAt: row.created_at,
    hidden: row.hidden === 1,
    kind: kindFromRow(row.kind),
    meta,
    exchangeId: row.exchange_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    attachments: parseAttachments(row.attachments)
  }
}

interface SessionDbRow {
  id: string
  bot_id: string
  kind: string
  ref: string | null
  summary: string | null
  cutoff_id: number | null
  created_at: string
  updated_at: string
}

function sessionFromRow(existing: SessionDbRow): SessionRow {
  return {
    id: existing.id,
    botId: existing.bot_id,
    kind: existing.kind,
    ref: existing.ref ?? null,
    summary: existing.summary,
    cutoffId: existing.cutoff_id,
    createdAt: existing.created_at,
    updatedAt: existing.updated_at
  }
}

export function getOrCreateSession(botId: string, kind = 'dm'): SessionRow {
  const db = getDb()
  const existing = db
    .prepare('SELECT * FROM sessions WHERE bot_id = ? AND kind = ?')
    .get(botId, kind) as SessionDbRow | undefined
  if (existing) {
    return sessionFromRow(existing)
  }
  const session: SessionRow = {
    id: randomUUID(),
    botId,
    kind,
    ref: null,
    summary: null,
    cutoffId: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
  db.prepare(
    'INSERT INTO sessions (id, bot_id, kind, ref, summary, cutoff_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(session.id, botId, kind, null, null, null, session.createdAt, session.updatedAt)
  return session
}

/**
 * 任务会话(2026-11-06「新建任务」):kind='task' 且 ref=线程 id——一线程一会话,
 * 与居民单聊(kind='dm')互不干扰;上下文组装/落库/审批都指到这个会话。
 * 同款守卫式查建(按 ref 查,不存在则插),消息表完全复用。
 */
export function getOrCreateTaskSession(botId: string, threadId: string): SessionRow {
  const db = getDb()
  const existing = db
    .prepare("SELECT * FROM sessions WHERE kind = 'task' AND ref = ?")
    .get(threadId) as SessionDbRow | undefined
  if (existing) {
    return sessionFromRow(existing)
  }
  const session: SessionRow = {
    id: randomUUID(),
    botId,
    kind: 'task',
    ref: threadId,
    summary: null,
    cutoffId: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
  db.prepare(
    'INSERT INTO sessions (id, bot_id, kind, ref, summary, cutoff_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(session.id, botId, 'task', threadId, null, null, session.createdAt, session.updatedAt)
  return session
}

export function listMessages(sessionId: string, includeHidden = true): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
    .all(sessionId) as MessageRow[]
  const messages = rows.map(messageFromRow)
  return includeHidden ? messages : messages.filter((m) => !m.hidden)
}

export function insertMessage(
  sessionId: string,
  role: ChatRole,
  content: string,
  reasoning: string | null = null,
  hidden = false,
  kind: MessageKind = 'chat',
  meta?: MessageMeta,
  exchangeId?: string,
  turnId?: string,
  attachments?: MessageAttachment[]
): ChatMessage {
  const db = getDb()
  const info = db
    .prepare(
      'INSERT INTO messages (session_id, role, content, reasoning, created_at, hidden, kind, meta, exchange_id, turn_id, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      sessionId,
      role,
      content,
      reasoning,
      nowIso(),
      hidden ? 1 : 0,
      kind,
      meta ? JSON.stringify(meta) : null,
      exchangeId ?? null,
      turnId ?? null,
      attachments && attachments.length > 0 ? JSON.stringify(attachments) : null
    )
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nowIso(), sessionId)
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid)) as MessageRow
  // 私信事件行 / 审批卡 / 工具事件行落库即通知对应窗口静默刷新
  if (kind !== 'chat') syncSession(sessionId)
  return messageFromRow(row)
}

/** 工具事件行收尾:执行中 → 完成/失败,补上收尾摘要;界面同步刷新(双语:outcomeK 随摘要落库) */
export function finishToolEvent(
  messageId: number,
  status: 'done' | 'failed',
  outcome?: string,
  outcomeK?: { k: string; p?: Record<string, string | number> }
): void {
  try {
    const db = getDb()
    const row = db.prepare('SELECT session_id, meta FROM messages WHERE id = ?').get(messageId) as
      | { session_id: string; meta: string | null }
      | undefined
    if (!row?.meta) return
    const meta = JSON.parse(row.meta) as ToolEventMeta
    meta.status = status
    if (outcome) meta.outcome = outcome
    if (outcomeK) meta.outcomeK = outcomeK
    db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), messageId)
    syncSession(row.session_id)
  } catch (err) {
    console.error('[sessions] 更新工具事件行失败:', err)
  }
}

/** 某会话的消息列表有非对话类变动,通知所有窗口按 botId 静默重载 */
function syncSession(sessionId: string): void {
  const session = getDb().prepare('SELECT bot_id FROM sessions WHERE id = ?').get(sessionId) as
    | { bot_id: string }
    | undefined
  if (!session) return
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EV.ChatSync, { botId: session.bot_id })
  }
}

// ---- 私信交流详情 ----

function relationMetaOf(row: { meta: string | null }): RelationMeta | null {
  if (!row.meta) return null
  try {
    const parsed = JSON.parse(row.meta) as RelationMeta
    return parsed && typeof parsed.dir === 'string' && typeof parsed.peer === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 私信交流详情:一次 send_message 的 relation 行重建为逻辑往返日志。
 * 同一句话在双方会话里各有一行投影(A 的「发给 B」与 B 的「来自 A」内容相同),
 * 直接全查会每句显示两遍——只取发起方会话(dir='out' 所在)的行,它天然是完整往返。
 */
export function getExchangeDetail(exchangeId: string): ExchangeDetail | null {
  const rows = getDb()
    .prepare(
      `SELECT m.*, s.bot_id FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE m.exchange_id = ? AND m.kind = 'relation' ORDER BY m.id ASC`
    )
    .all(exchangeId) as (MessageRow & { bot_id: string })[]
  if (rows.length === 0) return null

  const initiatorRow = rows.find((r) => relationMetaOf(r)?.dir === 'out')
  if (!initiatorRow) return null
  const initiatorMeta = relationMetaOf(initiatorRow)!

  const colorOf = (name: string): string | null => listBots().find((b) => b.name === name)?.color ?? null
  const initiator = getBot(initiatorRow.bot_id)?.name ?? '已离岛的居民'
  const peer = initiatorMeta.peer
  const strip = (text: string): string => text.replace(/^\[[^\]]*\]\s*/, '')

  const rounds: ExchangeRound[] = []
  let replied = false
  for (const r of rows) {
    if (r.session_id !== initiatorRow.session_id) continue
    const meta = relationMetaOf(r)
    if (!meta) continue
    if (meta.dir === 'out') {
      rounds.push({ from: initiator, to: peer, color: colorOf(initiator), content: strip(r.content), createdAt: r.created_at })
    } else if (meta.dir === 'reply-in') {
      // 发起方投影的「无回复」标记行(回复唤醒,2026-11-05):不进轮次、不算已回复——
      // 尾部「处理过但没回上来」的未获回应逻辑接管
      if (meta.noReply) continue
      replied = true
      rounds.push({ from: peer, to: initiator, color: colorOf(peer), content: strip(r.content), createdAt: r.created_at })
    }
  }

  // 回信方的处理过程(方案 C):B 侧静默回复这封私信的思考/工具/已决审批回执行,按回复行的 turn_id 挂入。
  // 旧私信无 turn_id → 无过程区,浮窗保持原样
  const peerReply = rows.find((r) => r.session_id !== initiatorRow.session_id && relationMetaOf(r)?.dir === 'reply')
  let peerProcess: ChatMessage[] | undefined
  let peerNoReply = false
  if (peerReply) {
    const replyMeta = relationMetaOf(peerReply)!
    peerNoReply = replyMeta.noReply === true
    // 中途被停但已写出部分回复:发起方会话没有 reply-in 投影,这段正文今天不可见,补成一轮
    if (!replied && !peerNoReply && peerReply.content.trim()) {
      replied = true
      rounds.push({ from: peer, to: initiator, color: colorOf(peer), content: strip(peerReply.content), createdAt: peerReply.created_at })
    }
    if (peerReply.turn_id) {
      // 已决审批回执同收(2026-11-06 修复):静默回信里的全自动放行签主流程已折签,
      // 浮窗再不收就 UI 全程不可见——审批留痕(全自动档问责链)在这里闭环
      const processRows = getDb()
        .prepare(
          `SELECT * FROM messages WHERE session_id = ? AND turn_id = ? AND kind IN ('reasoning', 'tool', 'note', 'approval') AND id < ?
            ORDER BY id ASC`
        )
        .all(peerReply.session_id, peerReply.turn_id, peerReply.id) as MessageRow[]
      if (processRows.length > 0) peerProcess = processRows.map(messageFromRow)
    }
  }
  return { exchangeId, initiator, peer, rounds, replied, createdAt: rows[0]!.created_at, peerProcess, peerNoReply }
}
