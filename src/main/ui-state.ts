import { getDb, metaGet, metaSet } from './store'
import { pendingApprovalsByBot, pendingApprovalsByThread } from './approval'
import { activeTurnKinds } from './chat'
import { busyGroupIds } from './groups'
import type { ConversationPreview } from '@shared/types'

// 侧栏「已隐藏的对话」:纯 UI 偏好,存 meta KV;居民被送别后残留的 id 在渲染端按现存居民过滤
const KEY_HIDDEN_DMS = 'sidebar.hiddenDms'

export function getHiddenDms(): string[] {
  return metaGet<string[]>(KEY_HIDDEN_DMS) ?? []
}

export function setHiddenDms(ids: string[]): void {
  metaSet(KEY_HIDDEN_DMS, ids)
}

// 回合过程默认折叠/展开(2026-11-08 设置项):纯 UI 偏好,存 meta KV;无值=false=「工作中」签过程明细收起(新默认)
const KEY_TURN_PROCESS_EXPANDED = 'chat.turnProcessExpanded'

export function getTurnProcessExpanded(): boolean {
  return metaGet<boolean>(KEY_TURN_PROCESS_EXPANDED) ?? false
}

export function setTurnProcessExpanded(v: boolean): void {
  metaSet(KEY_TURN_PROCESS_EXPANDED, v)
}

function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/**
 * 侧栏统一消息列表的预览:每个单聊/群聊的最后一条普通消息(kind='chat',居民私信事件行不计)。
 * 无消息的会话不返回条目,由渲染端回退到角色/人数并按创建时间排序。
 */
export function listConversationPreviews(): ConversationPreview[] {
  const db = getDb()

  // 单聊:按居民取最新一条 chat 消息(会话理论上每居民一条,窗口函数兜底)
  const dmRows = db
    .prepare(
      `SELECT bot_id, content, created_at, attachments FROM (
        SELECT s.bot_id, m.content, m.created_at, m.attachments,
               ROW_NUMBER() OVER (PARTITION BY s.bot_id ORDER BY m.id DESC) AS rn
        FROM sessions s
        JOIN messages m ON m.session_id = s.id AND m.kind = 'chat'
        WHERE s.kind = 'dm'
      ) WHERE rn = 1`
    )
    .all() as { bot_id: string; content: string; created_at: string; attachments: string | null }[]

  // 群聊:每群取最新一条消息,发送者名字从 bots 表关联
  const groupRows = db
    .prepare(
      `SELECT g.id, gm.content, gm.sender_type, gm.attachments, b.name AS bot_name, gm.created_at
       FROM groups g
       JOIN group_messages gm ON gm.id = (
         SELECT id FROM group_messages WHERE group_id = g.id ORDER BY id DESC LIMIT 1
       )
       LEFT JOIN bots b ON b.id = gm.bot_id
       WHERE g.deleted_at IS NULL`
    )
    .all() as {
    id: string
    content: string
    sender_type: 'user' | 'bot'
    bot_name: string | null
    created_at: string
    attachments: string | null
  }[]

  // 任务会话行(2026-11-06「新建任务」):open 线程全量返回——没消息的也出列(创建即上列表,
  // 不等第一条消息),最后一条 chat 消息做预览,空线程 preview 留空由渲染端落引导语;
  // 排序混进单聊/群聊同一套 lastAt 规则(无消息回退线程创建时间)
  const taskRows = db
    .prepare(
      `SELECT t.id, t.created_at, m.content, m.attachments, m.created_at AS last_at
       FROM task_threads t
       LEFT JOIN sessions s ON s.kind = 'task' AND s.ref = t.id
       LEFT JOIN messages m ON m.id = (
         SELECT MAX(id) FROM messages WHERE session_id = s.id AND kind = 'chat'
       )
       WHERE t.status = 'open'`
    )
    .all() as { id: string; created_at: string; content: string | null; attachments: string | null; last_at: string | null }[]

  // 挂起中的审批数(内存态,按居民聚合):侧栏角标与待审横条的数据源;
  // 任务会话里挂起的另按线程聚合(记到任务行上,2026-11-06)
  const pending = pendingApprovalsByBot()
  const pendingThreads = pendingApprovalsByThread()

  // 回合进行中真态(2026-10-30 列表实时状态):单聊按居民取回合类型,群聊聚合群级布尔,
  // 任务会话按 task:<threadId> 取(active 注册表 2026-11-06 线程键化);
  // 每次查询现算快照,与 pending 同源同构——TurnChanged 广播到达即重拉,天然自愈
  const busyKinds = activeTurnKinds()
  const busyGroups = busyGroupIds()

  // 纯附件消息(content 为空)的预览兜底:显示第一个附件名,列表不出现空行(2026-10-29)
  const previewText = (content: string, attachments: string | null): string => {
    if (content.trim()) return clip(content)
    try {
      const atts = attachments ? (JSON.parse(attachments) as { kind: string; name: string }[]) : []
      const first = atts.find(Boolean)
      if (first) return `[${first.kind === 'image' ? '图片' : '附件'}] ${first.name}`
    } catch {
      // 附件 JSON 损坏按空处理
    }
    return clip(content)
  }

  return [
    ...dmRows.map((row): ConversationPreview => {
      return {
        kind: 'dm',
        id: row.bot_id,
        lastAt: row.created_at,
        preview: previewText(row.content, row.attachments),
        pendingApprovals: pending.get(row.bot_id) ?? 0,
        busy: busyKinds.get(row.bot_id)
      }
    }),
    ...groupRows.map((row): ConversationPreview => {
      const who = row.sender_type === 'user' ? '我' : (row.bot_name ?? '居民')
      return {
        kind: 'group',
        id: row.id,
        lastAt: row.created_at,
        preview: `${who}: ${previewText(row.content, row.attachments)}`,
        groupBusy: busyGroups.has(row.id) || undefined
      }
    }),
    ...taskRows.map((row): ConversationPreview => {
      return {
        kind: 'task',
        id: row.id,
        lastAt: row.last_at ?? row.created_at,
        preview: row.content === null ? '' : previewText(row.content, row.attachments),
        pendingApprovals: pendingThreads.get(row.id) ?? 0,
        busy: busyKinds.get(`task:${row.id}`)
      }
    })
  ]
}
