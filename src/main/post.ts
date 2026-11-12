// 邮局主进程侧(2026-10-29,doc/需求 - 邮局 - 2026-10-29.md):
// 海域 API 调用(信箱/好友/邀请函) + 120s 轮询收信(含启动首拉/登录即拉/进页补拉,#28) + 附件下载 + 岛主寄信三段上传 + 通知。
// 定位:云端是邮局不是仓库,信拉走即 ack,历史全在本地 post_letters 表。
// ⚠️ 新网络代码一律 net.fetch(裸 fetch 不认系统代理是踩过的线上事故)。

import { randomUUID } from 'node:crypto'
import { getSpace } from './space'
import { postalImageMime, postalImageThumb, postalImageThumbAt } from './post-images'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, BrowserWindow, net, powerMonitor } from 'electron'
import type { PostAttachmentMeta, PostContact, PostInviteInfo, PostInviteParsed, PostLetter, PostOverview } from '@shared/types'
import { EV } from '@shared/ipc-channels'
import { getDb } from './store'
import { requireDataRoot } from './paths'
import { currentIslandUid, currentIslandArtworkId, currentSeaToken, SEA_BASE_URL } from './auth'
import { notifyIfBlurred } from './chat'
import { countsUnread, extractInviteCredential, STATION_ISLAND_UID, toPostLetter, type PostLetterRow } from '@shared/post-core'

export { POST_DDL } from '@shared/post-core'

const POLL_INTERVAL_MS = 120_000 // 轮询节奏(用户容忍 1-2 分钟投递延迟)
const FOCUS_PULL_MIN_GAP_MS = 30_000 // 聚焦/进页补拉最小间隔(防频繁切窗打爆云端)
const KICKOFF_RETRY_MS = 3_000 // 首拉守卫未就绪(登录/绑岛进行中)时的重试间隔(#28)
const KICKOFF_MAX_TRIES = 40 // 首拉重试上限(约 2 分钟;超限交给 120s 定时器兜底)
const WELCOME_REPULL_MS = 3_000 // 首拉空箱后的一次短延迟补拉(服务端欢迎信生成可能滞后于建岛,#28)
const CURSOR_KEY = 'post.cursor'
const LETTER_BODY_MAX = 64 * 1024
const ATTACH_SIZE_MAX = 50 * 1024 * 1024
const ATTACH_COUNT_MAX = 10

let pollTimer: NodeJS.Timeout | null = null
let polling = false
let lastPullAt = 0
let kickoffDone = false
let kickoffTries = 0
let kickoffTimer: NodeJS.Timeout | null = null

// ---------- 海域请求 ----------

class PostError extends Error {}

/** 邮局专用 sea 请求:Bearer + x-island-uid;未登录/未绑定岛返回 null 让调用方静默 */
function postSea<T>(
  path: string,
  init?: { method?: string; body?: unknown; raw?: Uint8Array; contentType?: string }
): Promise<T> {
  const token = currentSeaToken()
  const islandUid = currentIslandUid()
  if (!token || !islandUid) return Promise.reject(new PostError('邮局需要先登录群岛账号并完成设备绑定'))
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'x-island-uid': islandUid
  }
  let body: string | Uint8Array | undefined
  if (init?.raw !== undefined) {
    headers['content-type'] = init.contentType ?? 'application/octet-stream'
    headers['content-length'] = String(init.raw.byteLength)
    body = init.raw
  } else if (init?.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.body)
  }
  return net
    .fetch(`${SEA_BASE_URL}${path}`, {
      method: init?.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: AbortSignal.timeout(20_000)
    })
    .then(async (resp) => {
      const payload = (await resp.json().catch(() => null)) as
        | { ok?: boolean; data?: T; error?: { code?: string; message?: string } }
        | null
      if (!resp.ok || !payload?.ok) {
        throw new PostError(payload?.error?.message || `邮局服务请求失败(${resp.status})`)
      }
      return payload.data as T
    })
    .catch((err) => {
      if (err instanceof PostError) throw err
      throw new PostError('连不上群岛邮局服务,请检查网络后重试')
    })
}

/** 附件下载(流式落盘;Bearer+岛头) */
async function downloadAttachment(attId: string, filename: string): Promise<{ localPath: string; bytes: Buffer }> {
  const token = currentSeaToken()
  const islandUid = currentIslandUid()
  if (!token || !islandUid) throw new PostError('邮局需要先登录群岛账号')
  const resp = await net.fetch(`${SEA_BASE_URL}/post/attachments/${attId}/content`, {
    headers: { authorization: `Bearer ${token}`, 'x-island-uid': islandUid },
    signal: AbortSignal.timeout(120_000)
  })
  if (!resp.ok) throw new PostError(`附件下载失败(${resp.status})`)
  const buf = Buffer.from(await resp.arrayBuffer())
  const dir = postDir()
  mkdirSync(dir, { recursive: true })
  const safe = filename.replace(/[\\/]/g, '_') || 'attachment'
  const localPath = join(dir, `${attId}-${safe}`)
  writeFileSync(localPath, buf)
  return { localPath, bytes: buf }
}

function postDir(): string {
  // 附件归档目录挂账号 dataRoot 下(与 attachments/ 平级)
  return join(requireDataRoot(), 'post')
}

// ---------- 本地表 ----------

function rowById(id: string): PostLetterRow | undefined {
  return getDb().prepare('SELECT * FROM post_letters WHERE id = ?').get(id) as PostLetterRow | undefined
}

function rowByRemoteId(remoteId: number): PostLetterRow | undefined {
  return getDb().prepare('SELECT * FROM post_letters WHERE remote_id = ?').get(remoteId) as PostLetterRow | undefined
}

function insertLetter(row: PostLetterRow): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO post_letters
       (id, remote_id, direction, peer_island, peer_name, kind, ref_remote_id, subject, body, sender_kind, attachments, status, error, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.remote_id,
      row.direction,
      row.peer_island,
      row.peer_name,
      row.kind,
      row.ref_remote_id,
      row.subject,
      row.body,
      row.sender_kind,
      row.attachments,
      row.status,
      row.error,
      row.created_at,
      row.read_at
    )
}

function updateStatus(id: string, status: PostLetter['status'], error: string | null = null): void {
  getDb().prepare('UPDATE post_letters SET status = ?, error = ? WHERE id = ?').run(status, error, id)
}

function metaGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function metaSet(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EV.PostChanged, {})
}

// ---------- 轮询收信 ----------

interface InboxLetter {
  id: number
  kind: PostLetter['kind']
  refId: number | null
  fromArtworkId?: string | null
  fromIsland: string
  subject: string | null
  body: string | null
  senderKind: 'owner' | 'resident' | 'system' | 'officer'
  senderName: string
  status: string
  createdAt: number
  attachments: { id: string; filename: string; size: number; mime: string | null }[]
}

let stationNoticeFixDone = false

/** 存量订正(幂等):v1.2.1 前落库的联络站转告信署名「群岛联络站」对齐云端迁移 0011 改
 *  「系统通知（群岛联络站）」。必须延迟到登录守卫之后执行——v1.2.2 曾放在 initPostPoller 里,
 *  启动早期账号数据未挂载时 getDb 抛「尚未登录」,弹「群岛启动遇到问题」框(1.2.3 热修线上事故)。 */
function fixStationNoticeNamesOnce(): void {
  if (stationNoticeFixDone) return
  stationNoticeFixDone = true
  try {
    getDb()
      .prepare(`UPDATE post_letters SET peer_name = '系统通知（群岛联络站）' WHERE peer_island = ? AND peer_name = '群岛联络站'`)
      .run(STATION_ISLAND_UID)
  } catch (err) {
    stationNoticeFixDone = false // 库暂不可用(登出边界等):下轮轮询再试
    console.error('[post] station notice fix failed:', err)
  }
}

let inflightPull: Promise<void> | null = null

export function pullInbox(
  trigger?: 'focus' | 'resume' | 'sent' | 'kickoff' | 'login' | 'open'
): Promise<void> {
  void trigger
  // 已有拉取在途:等它而不是空手返回——进页补拉(postPullNow)拿这个当「本次拉取完成」信号(#28 加载态)
  if (polling) return inflightPull ?? Promise.resolve()
  if (!currentSeaToken() || !currentIslandUid()) return Promise.resolve()
  inflightPull = runPull()
  return inflightPull
}

async function runPull(): Promise<void> {
  fixStationNoticeNamesOnce()
  polling = true
  lastPullAt = Date.now()
  try {
    const cursor = parseInt(metaGet(CURSOR_KEY) ?? '0', 10) || 0
    const data = await postSea<{ cursor: number; hasMore: boolean; artworkId?: string | null; letters: InboxLetter[] }>(
      `/post/inbox?after=${cursor}&limit=50`
    )
    if (data.artworkId) metaSet(`post:artwork:${currentIslandUid()}`, data.artworkId)
    // #28:无新信不再提前 return——通讯录(对方改名/建联变化)随每轮轮询追平;是否打扰界面由 changed 决定
    let changed = false
    const ackIds: number[] = []
    let newInLetters = 0
    let lastNewIn: InboxLetter | null = null
    let peerNameFresh: Record<string, string> = {}
    for (const item of data.letters) {
      // 幂等:remote_id 已存在跳过(resync 重装场景整段重拉也安全)
      if (rowByRemoteId(item.id)) continue
      if (item.fromArtworkId) metaSet(`post:artwork:${item.fromIsland}`, item.fromArtworkId)
      peerNameFresh = { ...peerNameFresh, [item.fromIsland]: item.senderName }
      if (item.kind === 'deliver_receipt' || item.kind === 'read_receipt') {
        // 回执:不落新行,只推进对应去信状态(单调只前进)
        const target = item.refId !== null ? rowByRemoteId(item.refId) : undefined
        if (target && target.direction === 'out' && target.status !== 'read' && target.status !== 'failed') {
          updateStatus(target.id, item.kind === 'read_receipt' ? 'read' : 'delivered')
          changed = true // 去信邮戳推进(sent→delivered/read),列表要刷新
        }
        ackIds.push(item.id)
        continue
      }
      // 申请卡 / 正文信 / friend_accept 系统信:落行,附件下载
      const attachments: PostAttachmentMeta[] = []
      let downloadError: string | null = null
      for (const att of item.attachments) {
        try {
          const { localPath } = await downloadAttachment(att.id, att.filename)
          attachments.push({ ...att, localPath, thumb: postalImageThumbAt(localPath, att.filename) })
        } catch (err) {
          downloadError = err instanceof Error ? err.message : String(err)
          attachments.push({ ...att, localPath: null })
        }
      }
      const localId = randomUUID()
      insertLetter({
        id: localId,
        remote_id: item.id,
        direction: 'in',
        peer_island: item.fromIsland,
        peer_name: item.senderName,
        kind: item.kind,
        ref_remote_id: item.refId,
        subject: item.subject,
        body: item.body,
        sender_kind: item.senderKind,
        attachments: JSON.stringify(attachments),
        status: 'received',
        error: downloadError,
        created_at: item.createdAt,
        read_at: null
      })
      changed = true // 落了新行(正文信/申请卡/系统信)
      if (downloadError) console.error('[post] attachment download failed:', downloadError)
      ackIds.push(item.id)
      if (countsUnread(item.kind, 'in')) {
        newInLetters++
        lastNewIn = item
      }
    }
    // 顺带刷新 peer_name(对方岛换了署名/居民寄信);联络站除外——它名下有多个角色
    // (首席联络官可回信/系统通知不可回信),刷平会让角色署名互相覆盖,须保留每封信到达时的署名
    for (const [island, name] of Object.entries(peerNameFresh)) {
      if (island === STATION_ISLAND_UID) continue
      const res = getDb()
        .prepare('UPDATE post_letters SET peer_name = ? WHERE peer_island = ? AND peer_name != ?')
        .run(name, island, name)
      if (res.changes > 0) changed = true
    }
    if (ackIds.length) await postSea('/post/letters/ack', { method: 'POST', body: { ids: ackIds } }).catch((err) => console.error('[post] ack failed', err))
    if (data.cursor > cursor) metaSet(CURSOR_KEY, String(data.cursor))
    // 附件曾下载失败的来信(error 非空):信已 ACK、游标已过,云端不会再下发,靠 dedup 永远补不上——
    // 每轮主动按本地存档的附件 id 重下,成功即回填;仍失败留待下轮(云端留存期内自然补齐)
    if (await retryFailedLetterAttachments()) changed = true
    // 通讯录随轮询同步(friend_accept 到达、对方侧变化都会在这里追平);对比前后快照,
    // 有变化才算 changed(#28:此前 letters 为空时提前 return,通讯录永不追平)
    const contactsBefore = JSON.stringify(localContacts())
    await refreshContacts().catch(() => {})
    if (JSON.stringify(localContacts()) !== contactsBefore) changed = true
    if (newInLetters > 0 && lastNewIn) notifyNewLetter(lastNewIn.senderName)
    // 有变化才广播(#27(e)):回执推进/通讯录变化这类「拉到了东西」必广播,红点不等下一轮;
    // 无变化不打扰——每轮无条件广播会让渲染层高频全量重取,还会反复触发已读 effect 重排
    if (changed) broadcastChanged()
  } catch (err) {
    // 断网/服务不可达:静默,下轮再试
    if (!(err instanceof PostError && err.message.includes('登录'))) console.error('[post] pull failed', err)
  } finally {
    polling = false
    inflightPull = null
  }
}

function notifyNewLetter(senderName: string): void {
  const wins = BrowserWindow.getAllWindows()
  if (!wins.length) return
  notifyIfBlurred(wins[0]!.webContents, uiStr('postNotifyTitle'), uiStr('postNotifyBody', { name: senderName.split(' · ')[0]! }))
}

/** 补拉历史失败附件(见 runPull 内注释):按行里存档的附件元数据重下,成功回填 localPath/缩略并按
 *  是否还有失败清/留 error。返回 true=有回填(要广播刷新)。库未挂载等异常安静吞掉,下轮再来 */
async function retryFailedLetterAttachments(): Promise<boolean> {
  let rows: PostLetterRow[]
  try {
    rows = getDb()
      .prepare("SELECT * FROM post_letters WHERE direction = 'in' AND error IS NOT NULL")
      .all() as PostLetterRow[]
  } catch {
    return false
  }
  let refilled = false
  for (const row of rows) {
    let atts: PostAttachmentMeta[]
    try {
      atts = JSON.parse(row.attachments ?? '[]') as PostAttachmentMeta[]
    } catch {
      continue
    }
    if (!Array.isArray(atts) || !atts.some((a) => a && typeof a.id === 'string' && a.id && !a.localPath)) continue
    let stillFailed = false
    let touched = false
    for (const att of atts) {
      if (!att || !att.id || att.localPath) continue
      try {
        const { localPath } = await downloadAttachment(att.id, att.filename)
        att.localPath = localPath
        att.thumb = postalImageThumbAt(localPath, att.filename)
        touched = true
      } catch {
        stillFailed = true
      }
    }
    if (!touched) continue
    getDb()
      .prepare('UPDATE post_letters SET attachments = ?, error = ? WHERE id = ?')
      .run(JSON.stringify(atts), stillFailed ? row.error : null, row.id)
    refilled = true
  }
  return refilled
}

/** 轮询器(挂主进程启动):120s 一轮 + 唤醒/聚焦(≥30s 节流)补拉 + 启动首拉(#28)。
 *  init 只挂定时器不直接碰库(登录门前数据未挂载,约定同 initTaskScheduler「未登录静默」);
 *  一切库访问都在 pullInbox 的登录守卫之后、且 pullInbox 全程吞错(v1.2.2 曾在此提前访问库炸启动,1.2.3 热修);
 *  首拉同理——kickoffPull 守卫未就绪时只排定时器,就绪后的网络与落库全走 pullInbox。 */
export function initPostPoller(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    pullInbox().catch(() => {})
  }, POLL_INTERVAL_MS)
  pollTimer.unref?.()
  powerMonitor.on('resume', () => {
    pullInbox().catch(() => {})
  })
  app.on('browser-window-focus', () => {
    if (Date.now() - lastPullAt < FOCUS_PULL_MIN_GAP_MS) return
    pullInbox().catch(() => {})
  })
  kickoffPull() // #28:启动即收一次,新岛的欢迎信不再等 120s 轮询
}

// ---------- 首拉与登录联动(#28:新用户首进邮局空页,欢迎信要等 120s 轮询) ----------

function hasAnyInboundLetter(): boolean {
  try {
    return !!getDb().prepare("SELECT 1 FROM post_letters WHERE direction = 'in' LIMIT 1").get()
  } catch {
    return true // 库暂不可用(挂载竞态)视作已有,不补拉;120s 定时器兜底
  }
}

/** 业务库是否已挂载。开机解锁的 mount 发生在渲染层 boot IPC(resolveBoot),晚于 initPostPoller——
 *  只看令牌就开拉会把首拉吞在「尚未登录」的库错误里,须连库一起就绪(探针在 try 里,失败=未挂载)。 */
function accountDbMounted(): boolean {
  try {
    getDb().prepare('SELECT 1 FROM meta LIMIT 1').get()
    return true
  } catch {
    return false
  }
}

/** 启动首拉:未登录/未绑岛/库未挂载时 3s 一试(限次,防登出态空转);就绪即拉。
 *  首拉后仍一封来信都没有(全新岛),再延迟 3s 补一次——服务端欢迎信生成可能滞后于建岛。 */
function kickoffPull(): void {
  if (kickoffTimer) {
    clearTimeout(kickoffTimer)
    kickoffTimer = null
  }
  if (kickoffDone) return
  if (!currentSeaToken() || !currentIslandUid() || !accountDbMounted()) {
    kickoffTries += 1
    if (kickoffTries > KICKOFF_MAX_TRIES) return
    kickoffTimer = setTimeout(kickoffPull, KICKOFF_RETRY_MS)
    kickoffTimer.unref?.()
    return
  }
  kickoffDone = true
  pullInbox('kickoff')
    .then(() => {
      if (!hasAnyInboundLetter()) {
        const retry = setTimeout(() => {
          pullInbox('kickoff').catch(() => {})
        }, WELCOME_REPULL_MS)
        retry.unref?.()
      }
    })
    .catch(() => {})
}

/** 登录会话变化钩子(ipc.ts 在登录各出口与登出后调用):就绪→立即收信;登出→复位首拉与节流
 *  (换号重登不等 30s 节流,新账号立刻首拉,不吃上一个账号的 lastPullAt)。 */
export function postOnAuthChanged(ready: boolean): void {
  if (ready) {
    if (kickoffDone) {
      if (Date.now() - lastPullAt < FOCUS_PULL_MIN_GAP_MS) return
      pullInbox('login').catch(() => {})
    } else {
      kickoffTries = 0 // 登录出口触发:重置重试预算(输验证码/走向导可能超过启动后的 2 分钟预算)
      kickoffPull()
    }
  } else {
    kickoffDone = false
    kickoffTries = 0
    lastPullAt = 0
  }
}

/** 进邮局页补拉(IPC,PostView 挂载时调用):≥30s 节流;已有拉取在途则等它落库(不空手而回,
 *  否则启动后 1-2s 窗口内进页会在加载态与空态间闪);渲染层以「返回且本地仍空」区分真空态与正在收取。 */
export async function postPullNow(): Promise<void> {
  if (!currentSeaToken() || !currentIslandUid()) return
  if (polling) {
    await pullInbox('open') // pullInbox 对在途拉取直接返回其 promise
  } else if (Date.now() - lastPullAt >= FOCUS_PULL_MIN_GAP_MS) {
    await pullInbox('open')
  }
}

// ---------- 通讯录(云端为准,本地镜像) ----------

async function refreshContacts(): Promise<PostContact[]> {
  const data = await postSea<{ contacts: { islandUid: string; islandName: string; ownerName: string; artworkId?: string | null; since: number }[] }>(
    '/post/contacts'
  )
  if (!Array.isArray(data.contacts)) return localContacts() // 响应畸形不覆写本地镜像(#28:每轮轮询都会走到这里)
  const db = getDb()
  db.prepare('DELETE FROM post_contacts').run()
  for (const c of data.contacts ?? []) {
    if (c.artworkId) metaSet(`post:artwork:${c.islandUid}`, c.artworkId)
    db.prepare(
      'INSERT OR REPLACE INTO post_contacts (island_uid, island_name, owner_name, created_at) VALUES (?, ?, ?, ?)'
    ).run(c.islandUid, c.islandName, c.ownerName, c.since)
  }
  return data.contacts ?? []
}

export function localContacts(): PostContact[] {
  const rows = getDb()
    .prepare('SELECT island_uid, island_name, owner_name, created_at FROM post_contacts ORDER BY created_at')
    .all() as { island_uid: string; island_name: string; owner_name: string; created_at: number }[]
  return rows.map((r) => ({ islandUid: r.island_uid, islandName: r.island_name, ownerName: r.owner_name, artworkId: metaGet(`post:artwork:${r.island_uid}`), since: r.created_at }))
}

// ---------- 概览(IPC) ----------

export function postOverview(): PostOverview {
  // 窗口取「最近 500 封」再翻回旧→新展示(F8 修复:原 ASC LIMIT 500 取的是最早 500 封,第 501 封起
  // 永远不进概览,新信收到通知却在列表找不到);未读数独立查全库,不随窗口截断漏计
  const rows = getDb()
    .prepare('SELECT * FROM post_letters ORDER BY created_at DESC, remote_id DESC LIMIT 500')
    .all() as PostLetterRow[]
  rows.reverse()
  // 操作结果章(2026-10-30 评审:婉拒/拉黑/建立联系/删通道都落卡置灰,卡片不消失)——存 meta 表,信表零迁移
  const outcomes = new Map<string, string>()
  for (const r of getDb()
    .prepare("SELECT key, value FROM meta WHERE key LIKE 'post:outcome:%'")
    .all() as { key: string; value: string }[]) {
    outcomes.set(r.key.slice('post:outcome:'.length), r.value)
  }
  const letters = rows.map((row) => {
    const l = toPostLetter(row)
    l.peerArtworkId = metaGet(`post:artwork:${l.peerIsland}`)
    for (const attachment of l.attachments) {
      if (!attachment.thumb && attachment.localPath) attachment.thumb = postalImageThumbAt(attachment.localPath, attachment.filename)
    }
    const v = outcomes.get(l.id)
    l.outcome = v === 'accepted' || v === 'declined' || v === 'blocked' || v === 'channel_deleted' ? v : null
    return l
  })
  // 未读口径与 shared/post-core countsUnread 同源(direction='in' 且 kind ∈ letter/friend_request),改口径两处同步
  const unread = (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM post_letters WHERE direction = 'in' AND kind IN ('letter', 'friend_request') AND read_at IS NULL"
      )
      .get() as { c: number }
  ).c
  return { letters, contacts: localContacts(), unread, islandUid: currentIslandUid(), artworkId: metaGet(`post:artwork:${currentIslandUid()}`) ?? currentIslandArtworkId() }
}

// ---------- 寄信(岛主;居民工具复用同一条管道) ----------

export interface SendLetterArgs {
  toIsland: string
  subject?: string
  body: string
  /** 原始文件路径(寄信=原样字节复制,不缩放不引用);居民代寄无附件 */
  attachmentPaths?: string[]
  senderKind?: 'owner' | 'resident'
  senderNameResident?: string
}

/** 发信三段:本地落 sending → 附件预登记+上传 → 组装;任一步失败置 failed(可删可重寄) */
export async function sendLetter(args: SendLetterArgs): Promise<PostLetter> {
  const id = randomUUID()
  const now = Date.now()
  const peer = localContacts().find((c) => c.islandUid === args.toIsland)
  const peerName = peer ? `${peer.ownerName} · ${peer.islandName}` : args.toIsland
  const localAtts: PostAttachmentMeta[] = []
  if (args.attachmentPaths?.length) {
    if (args.attachmentPaths.length > ATTACH_COUNT_MAX) throw new PostError('一封信最多带 10 个附件')
    const stagingDir = join(postDir(), 'staging', id)
    mkdirSync(stagingDir, { recursive: true })
    for (const p of args.attachmentPaths) {
      if (!existsSync(p)) throw new PostError(`附件不存在:${p}`)
      const stat = statSync(p)
      if (!stat.isFile()) throw new PostError(`文件夹不能直接寄,请先压缩成 zip:${p}`)
      if (stat.size > ATTACH_SIZE_MAX) throw new PostError(`附件超过 50MB 上限:${p}`)
      const bytes = readFileSync(p)
      const destDir = join(stagingDir, String(localAtts.length))
      mkdirSync(destDir, { recursive: true })
      const dest = join(destDir, basename(p))
      writeFileSync(dest, bytes)
      localAtts.push({ id: '', filename: basename(p), size: stat.size, mime: postalImageMime(p), localPath: dest, thumb: postalImageThumbAt(dest, basename(p)) })
    }
  }
  if (!args.body.trim() && !localAtts.length) throw new PostError('信件内容不能为空')
  if (args.body.length > LETTER_BODY_MAX) throw new PostError('正文超过 64KB 上限')

  insertLetter({
    id,
    remote_id: null,
    direction: 'out',
    peer_island: args.toIsland,
    peer_name: peerName,
    kind: 'letter',
    ref_remote_id: null,
    subject: args.subject?.trim() || null,
    body: args.body,
    sender_kind: args.senderKind ?? 'owner',
    attachments: JSON.stringify(localAtts),
    status: 'sending',
    error: null,
    created_at: now,
    read_at: null
  })
  broadcastChanged()

  try {
    // ① 预登记
    let attachmentIds: string[] = []
    if (localAtts.length) {
      const reg = await postSea<{ attachments: { id: string; uploadPath: string }[] }>('/post/attachments', {
        body: {
          attachments: localAtts.map((a) => ({
            filename: a.filename,
            size: a.size,
            mime: a.mime,
            sha256: null
          }))
        }
      })
      attachmentIds = (reg.attachments ?? []).map((a) => a.id)
      if (attachmentIds.length !== localAtts.length) throw new PostError('附件预登记失败')
      // ② 原样字节上传(Content-Length=文件大小,服务端校验)
      for (let i = 0; i < localAtts.length; i++) {
        const att = localAtts[i]!
        const bytes = new Uint8Array(readFileSync(att.localPath!))
        await postSea(`/post/attachments/${attachmentIds[i]}`, {
          method: 'PUT',
          raw: bytes,
          contentType: 'application/octet-stream'
        })
      }
    }
    // ③ 组装原子可见
    const sent = await postSea<{ sent: boolean; letterId: number | null }>('/post/letters', {
      body: {
        to_island: args.toIsland,
        kind: 'letter',
        subject: args.subject?.trim() || undefined,
        body: args.body,
        attachment_ids: attachmentIds,
        sender_kind: args.senderKind ?? 'owner',
        sender_name: args.senderKind === 'resident' ? args.senderNameResident : undefined
      }
    })
    getDb()
      .prepare('UPDATE post_letters SET status = ?, remote_id = ? WHERE id = ?')
      .run('sent', sent.letterId ?? null, id)
    broadcastChanged()
    // 寄出后立即补拉(可能马上有回执/对方在线)
    pullInbox('sent').catch(() => {})
    return toPostLetter(rowById(id)!)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    updateStatus(id, 'failed', message)
    broadcastChanged()
    throw new PostError(message)
  }
}

// ---------- 寄信附件 intake(原样字节;与聊天的 attachments.ts 分道:不缩图、拒目录、复制副本) ----------

import type { AttachmentIntakeItem, MessageAttachment } from '@shared/types'
import { dialog } from 'electron'
import { uiStr } from './ui-strings'

const STAGING_INTAKE_DIR = 'staging-intake'

/** 寄信语义的 intake:文件与图片一律原样字节复制进邮局暂存(图片不缩放),文件夹拒收 */
export async function postIntakeAttachments(items: AttachmentIntakeItem[]): Promise<MessageAttachment[]> {
  const dir = join(postDir(), STAGING_INTAKE_DIR)
  mkdirSync(dir, { recursive: true })
  const out: MessageAttachment[] = []
  for (const item of items) {
    if ('path' in item && item.path) {
      let stat
      try {
        stat = statSync(item.path)
      } catch {
        continue
      }
      if (!stat.isFile()) continue // 文件夹拒收(界面在选择器层面已不给选,这里兜底)
      if (stat.size > ATTACH_SIZE_MAX) continue
      const intakeDir = join(dir, randomUUID())
      mkdirSync(intakeDir, { recursive: true })
      const dest = join(intakeDir, basename(item.path))
      writeFileSync(dest, readFileSync(item.path))
      out.push({
        kind: item.path.toLowerCase().match(/\.(png|jpe?g|gif|webp|heic|bmp)$/) ? 'image' : 'file',
        path: dest,
        name: basename(item.path),
        size: stat.size,
        thumb: postalImageThumbAt(dest, basename(item.path))
      })
    } else if ('dataUrl' in item && item.dataUrl?.startsWith('data:')) {
      // 无路径图片(截图等):写原样字节,不缩放
      const base64 = item.dataUrl.split(',')[1] ?? ''
      const bytes = Buffer.from(base64, 'base64')
      if (bytes.byteLength === 0 || bytes.byteLength > ATTACH_SIZE_MAX) continue
      const name = basename(item.name || '截图.png') || '截图.png'
      const intakeDir = join(dir, randomUUID())
      mkdirSync(intakeDir, { recursive: true })
      const dest = join(intakeDir, name)
      writeFileSync(dest, bytes)
      out.push({ kind: 'image', path: dest, name, size: bytes.byteLength, thumb: postalImageThumb(bytes) })
    }
  }
  return out
}

/** 寄信附件选择器:仅文件多选(不带 openDirectory——文件夹不能寄) */
export async function postPickAttachments(): Promise<MessageAttachment[]> {
  const picked = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: '选择要随信寄出的文件'
  })
  if (picked.canceled || picked.filePaths.length === 0) return []
  return postIntakeAttachments(picked.filePaths.map((path) => ({ path })))
}

// ---------- 好友与邀请函(IPC) ----------

export async function postFriendRequest(token: string, note: string): Promise<void> {
  const cleaned = extractInviteCredential(token)
  if (!cleaned) throw new PostError('邀请函内容无效')
  try {
    const res = await postSea<{ sent?: boolean; matched?: boolean; islandUid?: string; islandName?: string; ownerName?: string }>(
      '/post/friend-request',
      { body: { token: cleaned, note } }
    )
    // 本地落一张 out 申请卡:邮局流里直接看得到「已向谁寄出申请/打招呼」(2026-10-30 评审:像寄出一封信)
    if (res.islandUid && res.islandName && res.ownerName) {
      insertLetter({
        id: randomUUID(),
        remote_id: null,
        direction: 'out',
        peer_island: res.islandUid,
        peer_name: `${res.ownerName} · ${res.islandName}`,
        kind: 'friend_request',
        ref_remote_id: null,
        subject: null,
        body: note,
        sender_kind: 'owner',
        attachments: '[]',
        status: 'sent',
        error: null,
        created_at: Date.now(),
        read_at: null
      })
    }
  } finally {
    pullInbox().catch(() => {})
    broadcastChanged()
  }
}

/** 建立联系后自动发出的第一封破冰信(2026-10-30 评审拍板):由同意方寄给申请方,内容固定、署名岛主 */
const GREETING_BODY = '你好呀!咱们的两座岛已经建立联系啦,以后可以互相寄信了,期待你的来信~'

export async function postFriendRespond(fromIsland: string, accept: boolean): Promise<void> {
  const requestRow = latestRequestRowOf(fromIsland)
  try {
    await postSea('/post/friend-respond', { body: { from_island: fromIsland, accept } })
    if (requestRow) metaSet(`post:outcome:${requestRow.id}`, accept ? 'accepted' : 'declined')
    await refreshContacts().catch(() => {})
    if (accept) {
      // 自动破冰:失败不阻断(通道已建立,greeting 只是锦上添花)
      await sendLetter({ toIsland: fromIsland, body: GREETING_BODY, senderKind: 'owner' }).catch((err) =>
        console.error('[post] greeting letter failed:', err)
      )
    }
    pullInbox().catch(() => {})
    broadcastChanged()
  } catch (err) {
    broadcastChanged()
    throw err
  }
}

/** 该岛最近一张申请卡(结果章落在被操作的那张卡上) */
function latestRequestRowOf(islandUid: string): PostLetterRow | undefined {
  return getDb()
    .prepare("SELECT * FROM post_letters WHERE peer_island = ? AND kind = 'friend_request' AND direction = 'in' ORDER BY created_at DESC LIMIT 1")
    .get(islandUid) as PostLetterRow | undefined
}

export async function postBlock(islandUid: string, fromLetterId?: string): Promise<void> {
  await postSea('/post/block', { body: { island_uid: islandUid } })
  if (fromLetterId) metaSet(`post:outcome:${fromLetterId}`, 'blocked')
  broadcastChanged()
}

export async function postDeleteContact(islandUid: string, fromLetterId?: string): Promise<void> {
  await postSea(`/post/contacts/${encodeURIComponent(islandUid)}`, { method: 'DELETE' })
  if (fromLetterId) metaSet(`post:outcome:${fromLetterId}`, 'channel_deleted')
  await refreshContacts().catch(() => {})
  broadcastChanged()
}

/** 删除这一封信(2026-10-30 评审新增:更多菜单里的低频操作)——只删本地行,云端留存不动 */
export function postDeleteLetter(letterId: string): void {
  getDb().prepare('DELETE FROM post_letters WHERE id = ?').run(letterId)
  broadcastChanged()
}

export { postCopyInviteImage, postSaveInviteQr } from './post-save'

export async function postInviteCreate(): Promise<PostInviteInfo> {
  // 显式 POST:postSea 对无 body 的调用会推断成 GET,而 /post/invites 只注册了 POST(漏传即 404 接口不存在)
  const initiatingIsland = currentIslandUid()
  const initiatingRoot = requireDataRoot()
  const info = await postSea<PostInviteInfo>('/post/invites', { method: 'POST', body: {} })
  if (currentIslandUid() !== initiatingIsland || requireDataRoot() !== initiatingRoot) throw new PostError(uiStr('postInviteIslandChanged'))
  return { ...info, ownerName: info.ownerName ?? getSpace()?.ownerName, islandUid: info.islandUid ?? currentIslandUid() ?? undefined }
}

export function postInviteParse(text: string): Promise<PostInviteParsed> {
  const cleaned = extractInviteCredential(text)
  if (!cleaned) return Promise.reject(new PostError('邀请函内容无效,请输入邀请码或载入二维码图片'))
  return postSea<PostInviteParsed>('/post/invites/parse', { body: { token: cleaned } })
}

/** 标记已读(IPC,单封):批量实现的薄壳(保留给单点操作/旧调用方) */
export function postMarkRead(letterId: string): void {
  postMarkReadMany([letterId])
}

/** 批量标记已读(#27):进邮局 1.5s 后整批标。旧实现逐封 postMarkRead=N 次 IPC + N 次全量广播,
 *  广播又触发渲染层已读 effect 重排,「越急越漏」;这里一个事务一次广播,红点即时归零。
 *  云端已读回执接口无批量端点,仍逐封异步发(失败只记日志,本地已读不回滚——对端回执是锦上添花)。 */
export function postMarkReadMany(letterIds: string[]): void {
  const now = Date.now()
  const receiptIds: number[] = []
  let marked = 0
  const markStmt = getDb().prepare(
    "UPDATE post_letters SET read_at = ? WHERE id = ? AND direction = 'in' AND read_at IS NULL"
  )
  getDb().transaction(() => {
    for (const letterId of letterIds) {
      const row = rowById(letterId)
      if (!row || row.direction !== 'in' || row.read_at !== null) continue
      markStmt.run(now, letterId)
      marked += 1
      if (row.remote_id !== null) receiptIds.push(row.remote_id)
    }
  })()
  if (marked === 0) return
  for (const remoteId of receiptIds) {
    postSea(`/post/letters/${remoteId}/read`, { method: 'POST', body: {} }).catch((err) =>
      console.error('[post] read receipt failed', err)
    )
  }
  broadcastChanged()
}

// ---------- 居民工具支撑(tools.ts 调用;不审批在这里,审批归工具层) ----------

export function residentListContacts(): PostContact[] {
  return localContacts()
}

export async function residentReadMailbox(limit = 10): Promise<PostLetter[]> {
  await pullInbox().catch(() => {})
  const rows = getDb()
    .prepare(
      `SELECT * FROM post_letters WHERE direction = 'in' AND kind IN ('letter','friend_request','friend_accept')
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as PostLetterRow[]
  return rows.map(toPostLetter)
}

export async function residentSendLetter(to: string, body: string, residentName: string, subject?: string): Promise<string> {
  const contacts = localContacts()
  const target = contacts.find((c) => c.islandName === to) ?? contacts.find((c) => to.includes(c.islandName) || c.islandName.includes(to))
  if (!target) {
    const list = contacts.map((c) => `「${c.islandName}」(${c.ownerName})`).join('、')
    return contacts.length
      ? `通讯录里没有叫「${to}」的岛。现在可以寄信的岛有:${list}。请岛主确认收件岛。`
      : '通讯录还是空的,这座岛还没有通信好友。岛主可以在邮局导入别的岛的邀请函来建立联系。'
  }
  await sendLetter({ toIsland: target.islandUid, body, subject, senderKind: 'resident', senderNameResident: residentName })
  return `信已寄给「${target.islandName} · ${target.ownerName}」的岛。`
}
