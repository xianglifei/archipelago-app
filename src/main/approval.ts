import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, Notification } from 'electron'
import type { ApprovalMeta, Bot } from '@shared/types'
import { EV } from '@shared/ipc-channels'
import { getDb } from './store'
import { audit } from './audit'
import { getOrCreateSession, getOrCreateTaskSession, insertMessage } from './sessions'
import { getBot, updateBot } from './bots'
import { uiStr } from './ui-strings'

// 审批管线(§6.2/§6.9,语义借 dsh):审批即输入——pending 卡把居民单聊的输入区替换成决策面板,
// 岛主三档决策(允许/拒绝/本回合不再问)后放行,消息流里只留等待小签与回执小签
// - allowed-once:每次批准只覆盖当次调用;批准的就是执行的,参数不得改写(默认档)
// - turn-allowed:「本回合不再问」——本回合内同工具直接放行(不落卡),回合结束失效
// - fail-closed:没有任何窗口可问时直接拒绝;回合被停止时待审卡置为 aborted
// - 无自动超时:卡一直挂着,直到岛主处理或停止
//
// 权限两档(2026-10-27 重构):半自动=原应弹卡的操作走 askApproval;全自动=自动审批——
// 直接放行但照落 kind='approval' 留痕行(status='auto-approved'),展示复用回合时间线回执签,
// 岛主想回查随时可见「有过这么一次审批,只是没拦」。触发矩阵统一走 requestApproval 一处分叉。

export type ApprovalDecision = 'approved' | 'denied' | 'aborted'

/** 岛主在面板上可点的四档 */
export type ApprovalChoice = 'allow' | 'deny' | 'turn' | 'always'

export interface ApprovalRequest {
  toolName: string
  title: string
  detail: string
  reason: string
  /** 不提供「以后全自动」档(2026-11-10 工作目录绑定卡):目录授权是任务级语义,
   *  居民级升全自动的误触代价过大;true 时卡面与快捷键都不出 always */
  noAlways?: boolean
}

/**
 * 审批落点上下文(2026-11-06「新建任务」):工具在自己模块内部调 requestApproval 时
 * (fs-tools 的写围栏、shell 的危险命令闸)透传发起回合的定位——卡/留痕落发起回合的会话
 * (任务会话回合落任务里);留痕行随回合 id 折进时间线
 */
export interface ApprovalScope {
  /** 发起回合 id:自动审批留痕随回合折叠展示 */
  turnId?: string
  /** 任务会话回合的线程 id:卡/留痕落任务会话,缺省落居民单聊 */
  threadId?: string
}

interface Pending {
  botId: string
  /** 任务会话回合挂起的卡(2026-11-06「新建任务」):审批行落在任务会话里,计数也记到任务行 */
  threadId?: string
  messageId: number
  resolve: (cardStatus: ApprovalMeta['status']) => void
}

const pending = new Map<string, Pending>()

// 本回合免问表:键=回合所属线程(botId 或 task:<threadId>,与 chat.ts active 注册表同款口径)
// → 已点过「本回合不再问」的工具名;回合收尾由 chat.ts 清空。
// 2026-11-06 线程键化:同居民单聊与多个任务会话并行各跑各的回合——「本回合」的边界就是线程,
// 按 botId 记会把任务 A 的免问泄漏给并行的任务 B/单聊(跨回合放行),别的线程收尾还会误清它
const turnAllowed = new Map<string, Set<string>>()

/** 免问表键:任务会话回合=task:<threadId>,普通回合(单聊/私信/定时任务)=botId */
function turnAllowedKey(botId: string, threadId?: string): string {
  return threadId ? `task:${threadId}` : botId
}

/** 本回合内该工具已免问(岛主点过「本回合不再问」) */
function isTurnAllowed(key: string, toolName: string): boolean {
  return turnAllowed.get(key)?.has(toolName) ?? false
}

/** 回合收尾清空该线程的本回合免问表(chat.ts 调用,传 active 同款线程键) */
export function clearTurnApprovals(key: string): void {
  turnAllowed.delete(key)
}

/** Dock 角标:全局待审数(macOS) */
function syncDockBadge(): void {
  try {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(pending.size > 0 ? String(pending.size) : '')
    }
  } catch {
    // Dock 不可用时静默
  }
}

/** 各居民当前挂起的审批数(侧栏角标与预览用);任务会话里挂起的记到线程,不计入居民单聊行 */
export function pendingApprovalsByBot(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const p of pending.values()) {
    if (p.threadId) continue
    counts.set(p.botId, (counts.get(p.botId) ?? 0) + 1)
  }
  return counts
}

/** 各任务会话当前挂起的审批数(任务行角标用,2026-11-06「新建任务」) */
export function pendingApprovalsByThread(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const p of pending.values()) {
    if (!p.threadId) continue
    counts.set(p.threadId, (counts.get(p.threadId) ?? 0) + 1)
  }
  return counts
}

function broadcast(botId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EV.ChatSync, { botId })
  }
}

export function askApproval(
  bot: Bot,
  req: ApprovalRequest,
  signal?: AbortSignal,
  threadId?: string
): Promise<ApprovalDecision> {
  audit(bot.id, 'approval.asked', { toolName: req.toolName, title: req.title, detail: req.detail })
  // fail-closed:没有窗口就没有岛主,问不到就拒绝
  if (BrowserWindow.getAllWindows().length === 0) {
    return Promise.resolve('denied')
  }
  // 回合已停止:abort 监听只收「未来」的事件,进来时已中止的会挂死整张卡——不落卡直接按中止收场
  if (signal?.aborted) {
    return Promise.resolve('aborted')
  }

  // 本回合免问:岛主点过「本回合不再问」的同类工具直接放行,不落卡(键=线程,只对本线程回合生效)
  if (isTurnAllowed(turnAllowedKey(bot.id, threadId), req.toolName)) {
    audit(bot.id, 'approval.turn-allowed', { toolName: req.toolName, title: req.title })
    return Promise.resolve('approved')
  }

  const approvalId = randomUUID()
  // 审批行落「发起回合的会话」(2026-11-06「新建任务」):任务会话回合的卡落在任务会话里,
  // 否则任务里要审批时卡漂回单聊、上下文对不上,隔离感破碎;普通回合照旧落居民单聊
  const session = threadId ? getOrCreateTaskSession(bot.id, threadId) : getOrCreateSession(bot.id)
  const meta: ApprovalMeta = {
    approvalId,
    toolName: req.toolName,
    title: req.title,
    detail: req.detail,
    reason: req.reason,
    status: 'pending',
    ...(req.noAlways ? { noAlways: true } : {})
  }
  const message = insertMessage(session.id, 'assistant', req.title, null, false, 'approval', meta)
  // 落卡即广播:输入区当场切换成决策面板,侧栏角标/横条同步(否则停在该会话里根本看不见)
  broadcast(bot.id)
  syncDockBadge()
  notifyApproval(bot, req, threadId)

  return new Promise((resolve) => {
    // 卡片状态与回给 harness 的决策:turn-allowed 对 harness 也是放行(approved)
    const settle = (cardStatus: ApprovalMeta['status']): void => {
      if (!pending.has(approvalId)) return
      pending.delete(approvalId)
      signal?.removeEventListener('abort', onAbort)
      updateCardStatus(message.id, cardStatus)
      syncDockBadge()
      audit(bot.id, 'approval.decided', { approvalId, toolName: req.toolName, decision: cardStatus })
      // 回给 harness 的只有三种;turn-allowed(卡面状态)对 harness 是放行
      const decision: ApprovalDecision =
        cardStatus === 'turn-allowed' || cardStatus === 'approved'
          ? 'approved'
          : cardStatus === 'denied'
            ? 'denied'
            : 'aborted'
      resolve(decision)
    }
    const onAbort = (): void => settle('aborted')
    pending.set(approvalId, { botId: bot.id, threadId, messageId: message.id, resolve: settle })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 全自动档的「自动审批」:不拦人(不进 pending、不弹面板、不发通知),
 *  但照落一条 kind='approval' 留痕行——展示复用回合时间线回执签+浮窗,岛主想回查随时可见。
 *  留痕行同样落「发起回合的会话」(任务会话回合的留痕在任务里,2026-11-06)。 */
export function autoApprove(bot: Bot, req: ApprovalRequest, turnId?: string, threadId?: string): void {
  audit(bot.id, 'approval.auto-approved', { toolName: req.toolName, title: req.title, detail: req.detail })
  const session = threadId ? getOrCreateTaskSession(bot.id, threadId) : getOrCreateSession(bot.id)
  const meta: ApprovalMeta = {
    approvalId: randomUUID(),
    toolName: req.toolName,
    title: req.title,
    detail: req.detail,
    reason: req.reason,
    status: 'auto-approved',
    decidedAt: new Date().toISOString(),
    ...(req.noAlways ? { noAlways: true } : {})
  }
  insertMessage(session.id, 'assistant', req.title, null, false, 'approval', meta, undefined, turnId)
  // 静默重载让时间线当场出现回执签(与 askApproval 落卡即广播同一条通道)
  broadcast(bot.id)
}

/** 触发矩阵统一入口:半自动走 askApproval(岛主决策),全自动走 autoApprove(留痕放行)。 */
export function requestApproval(
  bot: Bot,
  req: ApprovalRequest,
  signal?: AbortSignal,
  turnId?: string,
  threadId?: string
): Promise<ApprovalDecision> {
  // 档位实时读库,不信调用方传来的 bot 快照:runTurn 在回合开始时 getBot 一次、闭包捕获,
  // 回合内岛主点「以后全自动」只更新了库,快照还是 semi——同回合后续工具会再弹卡(2026-10-28 用户报告)。
  // 现改为每次审批判定时重读,转档立即生效;反向(全自动改回半自动)同样即时生效。
  const live = getBot(bot.id) ?? bot
  if (live.permission === 'auto') {
    autoApprove(live, req, turnId, threadId)
    return Promise.resolve('approved')
  }
  return askApproval(live, req, signal, threadId)
}

/** 岛主在决策面板上点了四档之一;返回是否生效(卡可能已被处理或中止) */
export function resolveApproval(approvalId: string, choice: ApprovalChoice): boolean {
  const entry = pending.get(approvalId)
  if (!entry) return false
  if (choice === 'always') {
    // 「以后全自动」:该居民转为全自动档(档案/侧栏同步)+ 本卡按已允许放行
    try {
      updateBot(entry.botId, { permission: 'auto' })
      audit(entry.botId, 'approval.auto-escalated', { approvalId })
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EV.BotsChanged)
    } catch (err) {
      console.error('[approval] 转全自动失败,本卡仍按允许处理:', err)
    }
    // 给本卡盖「已转全自动」章(settle 会重读 meta 写状态,先盖再放行可保留)
    try {
      const db = getDb()
      const row = db.prepare('SELECT meta FROM messages WHERE id = ?').get(entry.messageId) as {
        meta: string | null
      } | undefined
      if (row?.meta) {
        const meta = JSON.parse(row.meta) as ApprovalMeta
        meta.escalatedTo = 'auto'
        db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), entry.messageId)
      }
    } catch (err) {
      console.error('[approval] 盖转档章失败:', err)
    }
    entry.resolve('approved')
    return true
  }
  if (choice === 'deny') {
    entry.resolve('denied')
    return true
  }
  if (choice === 'turn') {
    // 本回合内同类免问;当前这张卡按「已允许 · 免询问」落回执
    const row = getDb()
      .prepare('SELECT m.meta FROM messages m WHERE m.id = ?')
      .get(entry.messageId) as { meta: string | null } | undefined
    const toolName = row?.meta ? (JSON.parse(row.meta) as ApprovalMeta).toolName : ''
    if (toolName) {
      const key = turnAllowedKey(entry.botId, entry.threadId)
      const set = turnAllowed.get(key) ?? new Set<string>()
      set.add(toolName)
      turnAllowed.set(key, set)
    }
    entry.resolve('turn-allowed')
    return true
  }
  entry.resolve('approved')
  return true
}

function updateCardStatus(messageId: number, status: ApprovalMeta['status']): void {
  try {
    const db = getDb()
    const row = db
      .prepare('SELECT m.meta, s.bot_id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?')
      .get(messageId) as { meta: string | null; bot_id: string } | undefined
    if (!row?.meta) return
    const meta = JSON.parse(row.meta) as ApprovalMeta
    meta.status = status
    if (status !== 'pending') meta.decidedAt = new Date().toISOString()
    db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), messageId)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(EV.ChatSync, { botId: row.bot_id })
    }
  } catch (err) {
    console.error('[approval] 更新审批卡状态失败:', err)
  }
}

function notifyApproval(bot: Bot, req: ApprovalRequest, threadId?: string): void {
  try {
    if (BrowserWindow.getAllWindows().some((w) => w.isFocused())) return
    const notification = new Notification({
      title: uiStr('approvalNotify', { name: bot.name }),
      body: req.title
    })
    notification.on('click', () => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.show()
        // 切到卡所在的会话(输入区会自动变成决策面板):任务会话的卡切任务视图,普通卡切单聊
        win.webContents.send(EV.FocusBot, { botId: bot.id, threadId })
      }
    })
    notification.show()
  } catch {
    // 通知不可用时静默
  }
}
