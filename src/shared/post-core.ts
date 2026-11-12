// 邮局纯逻辑(2026-10-29,doc/需求 - 邮局 - 2026-10-29.md):DDL + 行映射 + 状态文案,
// 无 electron 依赖,冒烟脚本同源验证。网络与轮询在 post.ts。

import type { PostLetter, PostLetterStatus } from '@shared/types'

/** 群岛联络站虚拟岛 UID(2026-11-02 拍板,doc/需求 - 群岛联络站):每岛默认自带的官方好友,
 *  与云端 from_island='system' 同源;'officer'=首席联络官(可回信)、'system'=系统通知(不可回信)。 */
export const STATION_ISLAND_UID = 'system'

export const POST_DDL = `
CREATE TABLE IF NOT EXISTS post_letters (
  id TEXT PRIMARY KEY,
  remote_id INTEGER UNIQUE,
  direction TEXT NOT NULL,
  peer_island TEXT NOT NULL,
  peer_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_remote_id INTEGER,
  subject TEXT,
  body TEXT,
  sender_kind TEXT NOT NULL DEFAULT 'owner',
  attachments TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_post_letters_created ON post_letters(created_at);

CREATE TABLE IF NOT EXISTS post_contacts (
  island_uid TEXT PRIMARY KEY,
  island_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

export interface PostLetterRow {
  id: string
  remote_id: number | null
  direction: 'in' | 'out'
  peer_island: string
  peer_name: string
  kind: PostLetter['kind']
  ref_remote_id: number | null
  subject: string | null
  body: string | null
  sender_kind: 'owner' | 'resident' | 'system' | 'officer'
  attachments: string | null
  status: PostLetterStatus
  error: string | null
  created_at: number
  read_at: number | null
}

export function toPostLetter(row: PostLetterRow): PostLetter {
  let attachments: PostLetter['attachments'] = []
  if (row.attachments) {
    try {
      const parsed = JSON.parse(row.attachments) as PostLetter['attachments']
      if (Array.isArray(parsed)) attachments = parsed
    } catch {
      // 损坏 JSON 视为无附件
    }
  }
  return {
    id: row.id,
    remoteId: row.remote_id,
    direction: row.direction,
    peerIsland: row.peer_island,
    peerName: row.peer_name,
    kind: row.kind,
    refRemoteId: row.ref_remote_id,
    subject: row.subject,
    body: row.body,
    senderKind: row.sender_kind,
    attachments,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    readAt: row.read_at
  }
}

/** 计入未读的来信:正文信与申请卡(系统行 friend_accept 不计;回执不落行) */
export function countsUnread(kind: PostLetter['kind'], direction: 'in' | 'out'): boolean {
  return direction === 'in' && (kind === 'letter' || kind === 'friend_request')
}

/** 去信状态小字(邮戳语义:已寄出→已送达→已读) */
export function outboundStatusText(status: PostLetterStatus, en = false): string {
  switch (status) {
    case 'sending':
      return en ? 'Sending' : '寄出中'
    case 'sent':
      return en ? 'Sent' : '已寄出'
    case 'delivered':
      return en ? 'Delivered' : '已送达'
    case 'read':
      return en ? 'Read' : '已读'
    case 'failed':
      return en ? 'Failed' : '寄送失败'
    default:
      return ''
  }
}

/** 拆「岛主名 · 岛名」(存库格式;无分隔线时岛名落空) */
export function splitPeerName(peerName: string): { owner: string; island: string } {
  const i = peerName.indexOf(' · ')
  if (i === -1) return { owner: peerName, island: '' }
  return { owner: peerName.slice(0, i), island: peerName.slice(i + 3) }
}

/** 寄信人显示名(2026-10-30 评审):「小周 · 灯塔岛」→「小周(灯塔岛)」——点号不伦不类,改括号 */
export function peerDisplay(peerName: string): string {
  const { owner, island } = splitPeerName(peerName)
  return island ? `${owner}(${island})` : owner
}

/** 邮票底色:每座友岛固定一款(hidef 岛 uid 哈希到 8 款色),多岛混排一眼可辨 */
const STAMP_PALETTE = [
  '#E2725B', // 陶土
  '#4E7E75', // 海玻璃
  '#C99A3C', // 落日金
  '#7B6CA8', // 睡莲
  '#B0578D', // 珊瑚粉
  '#5B7DB1', // 晴空
  '#8A9A5B', // 苔原
  '#A65E4E' // 红岩
]

export function stampColorOf(peerIsland: string): string {
  let hash = 0
  for (let i = 0; i < peerIsland.length; i++) hash = (hash * 31 + peerIsland.charCodeAt(i)) >>> 0
  return STAMP_PALETTE[hash % STAMP_PALETTE.length]!
}

/** 邀请码字母表(与服务端 INVITE_CODE_ALPHABET 同源:31 字符,已剔除 0/1/I/O/L 易混字符) */
export const INVITE_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/

/** 从粘贴/扫码文本里提取邀请凭证(2026-11-03 起):六位码直通;整段链接(新 /i/<code> 或旧 /isle/<token>)取末段;其余原样透传(裸 token 兼容) */
export function extractInviteCredential(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (INVITE_CODE_RE.test(trimmed)) return trimmed
  const part = trimmed.includes('/isle/')
    ? trimmed.split('/isle/')[1]
    : trimmed.includes('/i/')
      ? trimmed.split('/i/')[1]
      : null
  if (part !== undefined && part !== null) return part.trim().replace(/^\/+|\/+$/g, '') || null
  return trimmed
}

/** 从粘贴文本里提取邀请函 token:整段链接(qundao.app/isle/<token>)或裸 token 都收 */
export function extractInviteToken(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.includes('/isle/')) {
    const part = trimmed.split('/isle/')[1] ?? ''
    return part.trim() || null
  }
  return trimmed
}
