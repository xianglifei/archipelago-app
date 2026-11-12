import { dialog } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ChatExportInput, ChatExportResult, MessageAttachment } from '@shared/types'
import { sanitizeQuotes } from '@shared/quote-core'
import { EXPORT_MAX_CHARS, buildExportMarkdown, type ExportMessageRow } from '@shared/export-core'
import { getDb } from './store'
import { getBot } from './bots'
import { getGroup } from './groups'
import { getTaskThread } from './task-threads'
import { getSpace } from './space'
import { requireDataRoot } from './paths'
import { uiStr } from './ui-strings'

// 对话导出 Markdown(2026-11-02 多选消息导出):主进程是数据权威——渲染层只传会话标识与消息 id,
// 查库、归一化、读图内联、拼装、保存全部在这里完成;md 拼装纯逻辑在 shared/export-core.ts。
// 导出的是「对话内容」:kind='chat' 且非 hidden 的行;过程类(思考/工具/审批/私信)不导。

interface ChatExportRow {
  id: number
  role: string
  content: string
  created_at: string
  meta: string | null
  attachments: string | null
}

interface GroupExportRow {
  id: number
  sender_type: string
  bot_id: string | null
  content: string
  created_at: string
  meta: string | null
  attachments: string | null
}

/** IPC 载荷不可信:id 逐个校验为正整数,再内联进 IN 子句(数字字面量无注入面,也绕开绑定参数上限) */
function safeIds(input: unknown): number[] {
  if (!Array.isArray(input)) return []
  const ids = input.filter((v): v is number => Number.isInteger(v) && v > 0)
  return [...new Set(ids)]
}

function parseAttachments(raw: string | null): MessageAttachment[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as MessageAttachment[]
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 图片附件读原件转 dataURL:仅岛数据目录 attachments/ 下的落盘副本放行(防路径注入读任意文件) */
function readImageDataUrl(filePath: string): string | null {
  const allowedDir = path.join(requireDataRoot(), 'attachments') + path.sep
  if (!filePath.startsWith(allowedDir)) return null
  try {
    const buf = readFileSync(filePath)
    if (buf.length === 0) return null
    const ext = path.extname(filePath).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/** 文件名清洗:会话名/居民名里可能混着文件系统非法字符 */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, ' ').trim() || '对话'
}

function defaultFileName(conversationName: string): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `群岛对话-${safeFileName(conversationName)}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.md`
}

export async function chatExport(input: ChatExportInput): Promise<ChatExportResult> {
  const ids = safeIds(input.messageIds)
  if (ids.length === 0) throw new Error(uiStr('exportEmpty'))
  const idList = ids.join(',')

  const ownerName = getSpace()?.ownerName?.trim() || '岛主'
  const rows: ExportMessageRow[] = []
  let conversationName: string
  let conversationDesc: string

  // 任务会话(2026-11-06「新建任务」):按线程取会话(kind='task' AND ref),标题=任务名
  if (input.threadId) {
    const thread = getTaskThread(input.threadId)
    if (!thread) throw new Error(uiStr('exportEmpty'))
    const bot = getBot(thread.botId)
    const dbRows = getDb()
      .prepare(
        `SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE s.kind = 'task' AND s.ref = ? AND m.id IN (${idList}) AND m.kind = 'chat' AND m.hidden = 0
          ORDER BY m.id ASC`
      )
      .all(input.threadId) as ChatExportRow[]
    for (const r of dbRows) {
      const meta = parseChatMeta(r.meta, r.role)
      rows.push({
        id: r.id,
        speaker: r.role === 'user' ? ownerName : (bot?.name ?? '已离岛的居民'),
        isOwner: r.role === 'user',
        content: r.content,
        createdAt: r.created_at,
        quotes: meta.quotes,
        attachments: parseAttachments(r.attachments)
      })
    }
    const taskName = thread.title || '新任务'
    conversationName = taskName
    conversationDesc = `任务「${taskName}」· 与 ${bot?.name ?? '已离岛的居民'}`
  } else if (input.botId) {
    const bot = getBot(input.botId)
    if (!bot) throw new Error(uiStr('exportEmpty'))
    const dbRows = getDb()
      .prepare(
        `SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE s.bot_id = ? AND s.kind = 'dm' AND m.id IN (${idList}) AND m.kind = 'chat' AND m.hidden = 0
          ORDER BY m.id ASC`
      )
      .all(input.botId) as ChatExportRow[]
    for (const r of dbRows) {
      const meta = parseChatMeta(r.meta, r.role)
      rows.push({
        id: r.id,
        speaker: r.role === 'user' ? ownerName : bot.name,
        isOwner: r.role === 'user',
        content: r.content,
        createdAt: r.created_at,
        quotes: meta.quotes,
        attachments: parseAttachments(r.attachments),
        fromTask: meta.taskId === true
      })
    }
    conversationName = bot.name
    conversationDesc = `与 ${bot.name} 的单聊`
  } else if (input.groupId) {
    const group = getGroup(input.groupId)
    if (!group) throw new Error(uiStr('exportEmpty'))
    const dbRows = getDb()
      .prepare(`SELECT * FROM group_messages WHERE group_id = ? AND id IN (${idList}) ORDER BY id ASC`)
      .all(input.groupId) as GroupExportRow[]
    for (const r of dbRows) {
      rows.push({
        id: r.id,
        speaker: r.sender_type === 'user' ? ownerName : getBot(r.bot_id ?? '')?.name ?? '已离岛的居民',
        isOwner: r.sender_type === 'user',
        content: r.content,
        createdAt: r.created_at,
        quotes: r.sender_type === 'user' ? parseChatMeta(r.meta, 'user').quotes : undefined,
        attachments: parseAttachments(r.attachments)
      })
    }
    conversationName = group.name
    conversationDesc = `群聊 · ${group.name}`
  } else {
    throw new Error(uiStr('exportEmpty'))
  }

  if (rows.length === 0) throw new Error(uiStr('exportEmpty'))

  // 图片原件内联:只有成功读到的进 map,读不到的降级为文件名标注(export-core 兜底)
  const imageData = new Map<string, string>()
  for (const row of rows) {
    for (const att of row.attachments ?? []) {
      if (att.kind === 'image' && !imageData.has(att.path)) {
        const dataUrl = readImageDataUrl(att.path)
        if (dataUrl) imageData.set(att.path, dataUrl)
      }
    }
  }

  const markdown = buildExportMarkdown(rows, { conversation: conversationDesc, exportedAt: new Date().toISOString() }, imageData)
  if (markdown.length > EXPORT_MAX_CHARS) throw new Error(uiStr('exportTooLarge'))

  if (input.mode === 'copy') return { saved: false, markdown }

  const result = await dialog.showSaveDialog({
    title: uiStr('exportSaveTitle'),
    defaultPath: defaultFileName(conversationName),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (result.canceled || !result.filePath) return { saved: false }
  try {
    writeFileSync(result.filePath, markdown, 'utf8')
  } catch {
    throw new Error(uiStr('exportWriteFailed'))
  }
  return { saved: true, path: result.filePath }
}

/** chat 行 meta 的轻量分型(与 sessions.ts messageFromRow 同规则):user 行取 QuoteMeta,assistant 行取 TaskRunMeta */
function parseChatMeta(raw: string | null, role: string): { quotes?: import('@shared/types').ChatQuote[]; taskId?: boolean } {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (role === 'user' && Array.isArray(parsed.quotes)) {
      const quotes = sanitizeQuotes(parsed.quotes)
      if (quotes.length > 0) return { quotes }
    }
    if (role === 'assistant' && typeof parsed.taskId === 'string') return { taskId: true }
  } catch {
    // meta 损坏时按无 meta 处理
  }
  return {}
}
