import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { BotTask, BotTaskRun, ScheduleKind, TaskSchedule, TaskScheduleDetail, TaskStatus } from '@shared/types'
import { EV } from '@shared/ipc-channels'
import { getDb, nowIso } from './store'
import { getBot } from './bots'
import { runTurn, isTurnActive } from './chat'
import { audit } from './audit'
import {
  advanceFrom,
  CATCHUP_WINDOW_MS,
  scheduleTextOf,
  statusTextOf,
  TASK_ACTIVE_LIMIT,
  validateTaskDraft,
  type TaskScheduleDetailCore
} from './tasks-core'

// 定时任务(2026-10-29,需求 - 居民定时任务与提醒):岛主口头交代、居民用工具落库、
// 调度器到点唤醒、居民在单聊里跑一个「岛主不在场」的回合。
// 心智:任务清单——登记(公约强制,不许口头答应)→ 到点照办 → 办没办得成如实汇报。
// 边界:群岛没开着任务不跑(启动补扫:一次性 10 分钟窗口内补触发,超窗诚实标「已错过」;
// 周期错过不补,前滚到下个周期);做事型仅全自动档;进行中上限 10 件、每小时型最多 2 件。
// 纯逻辑(DDL/时间计算/校验)在 tasks-core.ts——无 electron 依赖,冒烟同源验证

export { TASKS_DDL, TASK_ACTIVE_LIMIT, HOURLY_ACTIVE_LIMIT } from './tasks-core'

const SCAN_INTERVAL_MS = 60_000 // 调度粒度:分钟级,不做秒级
const DEFER_LIMIT = 5 // 忙时顺延上限(每次 1 分钟):岛主正与 TA 长聊时,超过即让位

const ACTIVE_STATUSES: TaskStatus[] = ['pending', 'active']

interface TaskRow {
  id: string
  bot_id: string
  kind: string
  schedule: string
  fire_at: number | null
  schedule_detail: string | null
  title: string
  source_quote: string
  source_chat: string
  status: string
  fail_reason: string | null
  defer_count: number
  next_fire_at: number | null
  created_at: string
  updated_at: string
}

function parseDetail(json: string | null): TaskScheduleDetail | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as TaskScheduleDetail
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function detailOf(task: TaskRow): TaskScheduleDetailCore {
  return parseDetail(task.schedule_detail) ?? {}
}

function runsOf(taskId: string, limit = 10): BotTaskRun[] {
  const rows = getDb()
    .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?')
    .all(taskId, limit) as { id: number; scheduled_at: number; ran_at: number | null; status: string; note: string | null }[]
  return rows.map((r) => ({ id: r.id, scheduledAt: r.scheduled_at, ranAt: r.ran_at, status: r.status as BotTaskRun['status'], note: r.note }))
}

function toBotTask(row: TaskRow): BotTask {
  const detail = detailOf(row)
  return {
    id: row.id,
    botId: row.bot_id,
    kind: row.kind as ScheduleKind,
    schedule: row.schedule as TaskSchedule,
    fireAt: row.fire_at,
    scheduleDetail: detail,
    title: row.title,
    sourceQuote: row.source_quote,
    sourceChat: row.source_chat,
    status: row.status as TaskStatus,
    failReason: row.fail_reason,
    nextFireAt: row.next_fire_at,
    createdAt: row.created_at,
    scheduleText: scheduleTextOf(row.schedule, row.fire_at, detail),
    statusText: statusTextOf(row.status, row.fail_reason),
    runs: runsOf(row.id)
  }
}

function broadcastTasks(botId: string): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EV.TasksChanged, { botId } satisfies { botId: string })
}

// ---- 登记 / 修改 / 取消 / 查(工具层调用;校验在 tasks-core,人话拒绝文案直接回给模型) ----

export interface SetTaskInput {
  kind: ScheduleKind
  schedule: TaskSchedule
  fireAt?: string
  time?: string
  weekday?: number
  weekdaysOnly?: boolean
  title: string
  sourceQuote: string
  sourceChat: string
}

function countActive(botId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE bot_id = ? AND status IN ('pending','active')")
    .get(botId) as { n: number }
  return row.n
}

function countHourlyActive(botId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE bot_id = ? AND schedule = 'hourly' AND status = 'active'")
    .get(botId) as { n: number }
  return row.n
}

function listTaskRows(botId: string): TaskRow[] {
  return getDb()
    .prepare('SELECT * FROM tasks WHERE bot_id = ? ORDER BY next_fire_at IS NULL, next_fire_at ASC, id DESC')
    .all(botId) as TaskRow[]
}

/** 该居民进行中任务的简短清单(超限拒绝与 list_tasks 用) */
function activeListText(botId: string): string {
  const rows = listTaskRows(botId).filter((t) => ACTIVE_STATUSES.includes(t.status as TaskStatus))
  return rows.length > 0
    ? rows.map((t, i) => `${i + 1}. ${t.title}(${scheduleTextOf(t.schedule, t.fire_at, detailOf(t))})`).join('、')
    : '(现在没有进行中的任务)'
}

export function setTask(botId: string, permission: string, input: SetTaskInput): string {
  const title = input.title.trim()
  const sourceQuote = input.sourceQuote.trim()
  if (!title) return '缺少参数:title(任务一句话,登记后岛主在任务页签看到的就是它)。'
  if (!sourceQuote) return '缺少参数:source_quote(岛主交代时的原话,原样记下)。'

  const checked = validateTaskDraft(
    { kind: input.kind, schedule: input.schedule, fireAt: input.fireAt, time: input.time, weekday: input.weekday, weekdaysOnly: input.weekdaysOnly },
    permission,
    { active: countActive(botId), hourlyActive: countHourlyActive(botId) }
  )
  if ('error' in checked) return checked.error

  const nowIsoStr = nowIso()
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO tasks (id, bot_id, kind, schedule, fire_at, schedule_detail, title, source_quote, source_chat,
        status, fail_reason, defer_count, next_fire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`
    )
    .run(
      id,
      botId,
      input.kind,
      input.schedule,
      checked.fireAt,
      checked.detail ? JSON.stringify(checked.detail) : null,
      title,
      sourceQuote,
      input.sourceChat || 'dm',
      input.schedule === 'once' ? 'pending' : 'active',
      checked.nextFireAt,
      nowIsoStr,
      nowIsoStr
    )
  audit(botId, 'set_task', { id, kind: input.kind, schedule: input.schedule, title })
  broadcastTasks(botId)
  const when = scheduleTextOf(input.schedule, checked.fireAt, checked.detail ?? {})
  const hourlyNote = input.schedule === 'hourly' ? '每小时都会真跑一次、各花一点积分,这句也要说给岛主。' : ''
  return `已登记任务「${title}」:${when}。到点我会${input.kind === 'remind' ? '开口提醒岛主' : '把事办完并向岛主汇报'}。${hourlyNote}记得把登记的时刻复述给岛主确认。`
}

/** 标题解析:精确 → 包含;多命中不猜,列出来指认(与群/技能同一套) */
function resolveTask(botId: string, name: string): { task?: TaskRow; error?: string } {
  const rows = listTaskRows(botId).filter((t) => t.status !== 'canceled')
  const exact = rows.find((t) => t.title === name)
  if (exact) return { task: exact }
  const fuzzy = rows.filter((t) => t.title.includes(name) || name.includes(t.title))
  if (fuzzy.length === 0) return { error: `没有叫「${name}」的任务。${activeListText(botId)}` }
  if (fuzzy.length > 1) {
    return { error: `叫「${name}」的任务不止一件,请说清是哪一件:${fuzzy.map((t) => `「${t.title}」`).join('、')}` }
  }
  return { task: fuzzy[0] }
}

export function updateTask(botId: string, args: Record<string, unknown>): string {
  const name = String(args.task ?? '').trim()
  if (!name) return '缺少参数:task(要改的任务)。'
  const found = resolveTask(botId, name)
  if (found.error) return found.error
  const task = found.task!

  const newTitle = String(args.title ?? '').trim()
  const newFireAtRaw = args.fire_at !== undefined ? String(args.fire_at).trim() : undefined
  const newTime = args.time !== undefined ? String(args.time) : undefined
  const newWeekday = args.weekday !== undefined ? Number(args.weekday) : undefined
  const newWeekdaysOnly = args.weekdays_only !== undefined ? args.weekdays_only === true : undefined

  // 时间改动:一次性换时刻(复活 failed);周期改参数后重算下个周期点
  let nextFireAt = task.next_fire_at
  let fireAt = task.fire_at
  let detail = detailOf(task)
  if (task.schedule === 'once' && newFireAtRaw !== undefined) {
    const parsed = newFireAtRaw ? parseOnceAtLocal(newFireAtRaw) : null
    if (parsed === null) return '新时刻读不出来,请用 2026-10-29T20:00 这样的格式。'
    const now = Date.now()
    if (parsed <= now + 60_000) return '新时刻已经到了或马上就到,请给一个至少一分钟以后的时刻。'
    if (parsed > now + 90 * 24 * 3600_000) return '超过 90 天的任务我记不牢,到时候再跟我说。'
    fireAt = parsed
    nextFireAt = parsed
  } else if (task.schedule !== 'once') {
    const detailChanged =
      (newTime !== undefined && newTime !== detail.time) ||
      (newWeekday !== undefined && newWeekday !== detail.weekday) ||
      (newWeekdaysOnly !== undefined && newWeekdaysOnly !== detail.weekdaysOnly)
    if (detailChanged) {
      detail = {
        ...detail,
        ...(newTime !== undefined ? { time: newTime } : {}),
        ...(newWeekday !== undefined ? { weekday: newWeekday } : {}),
        ...(newWeekdaysOnly !== undefined ? { weekdaysOnly: newWeekdaysOnly } : {})
      }
      nextFireAt = advanceFrom(task.schedule as 'once' | 'daily' | 'weekly' | 'hourly', detail)
      if (nextFireAt === null) return '新的周期参数无效,改不上。'
    }
  }
  const changed = newTitle !== '' || fireAt !== task.fire_at || nextFireAt !== task.next_fire_at
  if (!changed) return '没有要改的东西:要改任务内容(title)或时间(fire_at / time / weekday / weekdays_only)。'

  const newStatus =
    task.status === 'failed' && task.schedule === 'once' && fireAt !== task.fire_at ? 'pending' : task.status
  getDb()
    .prepare(
      `UPDATE tasks SET title = ?, fire_at = ?, schedule_detail = ?, status = ?, fail_reason = NULL,
        defer_count = 0, next_fire_at = ?, updated_at = ? WHERE id = ?`
    )
    .run(newTitle || task.title, fireAt, JSON.stringify(detail), newStatus, nextFireAt, nowIso(), task.id)
  audit(botId, 'update_task', { id: task.id, title: newTitle || task.title })
  broadcastTasks(botId)
  return `已改好:「${newTitle || task.title}」,${scheduleTextOf(task.schedule, fireAt, detail)}。记得把新安排复述给岛主。`
}

function parseOnceAtLocal(raw: string): number | null {
  const ms = new Date(raw).getTime()
  return Number.isNaN(ms) ? null : ms
}

export function cancelTask(botId: string, name: string, byOwner = false): string {
  if (!name.trim()) return '缺少参数:task(要取消的任务)。'
  const found = resolveTask(botId, name.trim())
  if (found.error) return found.error
  const task = found.task!
  if (!ACTIVE_STATUSES.includes(task.status as TaskStatus))
    return `「${task.title}」已经不在进行中了(${statusTextOf(task.status, task.fail_reason)}),不用取消。`
  getDb()
    .prepare("UPDATE tasks SET status = 'canceled', next_fire_at = NULL, updated_at = ? WHERE id = ?")
    .run(nowIso(), task.id)
  audit(botId, 'cancel_task', { id: task.id, title: task.title, by: byOwner ? 'owner' : 'resident' })
  broadcastTasks(botId)
  return `已取消「${task.title}」。`
}

export function listTasksText(botId: string): string {
  const rows = listTaskRows(botId)
  const active = rows.filter((t) => ACTIVE_STATUSES.includes(t.status as TaskStatus))
  const archive = rows.filter((t) => !ACTIVE_STATUSES.includes(t.status as TaskStatus)).slice(0, 5)
  const parts: string[] = []
  parts.push(
    active.length > 0
      ? `进行中的任务(${active.length}/${TASK_ACTIVE_LIMIT}):\n${active
          .map(
            (t, i) =>
              `${i + 1}. ${t.title} · ${scheduleTextOf(t.schedule, t.fire_at, detailOf(t))} · ${t.kind === 'remind' ? '提醒' : '做事'}`
          )
          .join('\n')}`
      : '现在没有进行中的任务。'
  )
  if (archive.length > 0) {
    parts.push(`最近的留档:${archive.map((t) => `「${t.title}」(${statusTextOf(t.status, t.fail_reason)})`).join('、')}`)
  }
  return parts.join('\n')
}

// ---- 调度器:每分钟扫一次;启动后的首轮自然处理错过的(补触发或诚实标错过) ----

let scanTimer: NodeJS.Timeout | null = null
/** 触发中的任务(防同轮重复触发;触发改为不等待后,跨轮扫描的去重也靠它) */
const firing = new Set<string>()
/** 扫描进行中:扫描本体只做同步判断(触发不等待),重入保护防同一快照被并发处理 */
let scanning = false

export function initTaskScheduler(): void {
  if (scanTimer) return
  void scanAndFire()
  scanTimer = setInterval(() => void scanAndFire(), SCAN_INTERVAL_MS)
}

async function scanAndFire(): Promise<void> {
  if (scanning) return
  let due: TaskRow[]
  try {
    due = getDb()
      .prepare("SELECT * FROM tasks WHERE status IN ('pending','active') AND next_fire_at <= ? ORDER BY next_fire_at ASC")
      .all(Date.now()) as TaskRow[]
  } catch {
    // 业务库未挂载(登录门前/登出后)——静默,登录后下一轮自然恢复
    return
  }
  scanning = true
  try {
    for (const task of due) {
      if (firing.has(task.id)) continue
      const scheduledAt = task.next_fire_at ?? Date.now()
      // 错过超窗:一次性诚实标「已错过」;周期不补,前滚到下个周期(那次落 missed 记录)
      if (Date.now() - scheduledAt > CATCHUP_WINDOW_MS) {
        // 快照可能已过期(due 列表读出后任务被取消/改期):推进状态前重读认领,
        // 别把已取消/已改期的任务覆盖成「错过」(与 fireTask 的重读认领同款守卫)
        const fresh = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRow | undefined
        if (!fresh || !ACTIVE_STATUSES.includes(fresh.status as TaskStatus) || fresh.next_fire_at !== scheduledAt) {
          continue
        }
        const note = '群岛当时没开着,这件任务错过了'
        if (fresh.schedule === 'once') {
          markOnce(fresh, 'missed', null)
          insertRun(fresh.id, scheduledAt, 'missed', note)
          audit(fresh.bot_id, 'task_missed', { id: fresh.id, title: fresh.title })
          broadcastTasks(fresh.bot_id)
        } else {
          insertRun(fresh.id, scheduledAt, 'missed', note)
          rollForward(fresh)
          broadcastTasks(fresh.bot_id)
        }
        continue
      }
      // 触发不等待(2026-11-06 codex 审查修复):任务回合可长达数分钟,逐件 await 会把
      // 其他居民同时到期的任务堵出 10 分钟补跑窗(白白标错过)。改为点火即走——
      // 同任务防重复由 firing 集合 + fireTask 内重读认领把守,同居民串行由回合 busy→顺延兜底
      void fireTask(task, scheduledAt).catch((err) => console.error('[tasks] 任务触发失败:', err))
    }
  } finally {
    scanning = false
  }
}

function markOnce(task: TaskRow, status: 'done' | 'missed' | 'failed' | 'canceled', failReason: string | null): void {
  getDb()
    .prepare('UPDATE tasks SET status = ?, fail_reason = ?, next_fire_at = NULL, updated_at = ? WHERE id = ?')
    .run(status, failReason, nowIso(), task.id)
}

/** 周期任务前滚:记 defer 清零,推进 next_fire_at */
function rollForward(task: TaskRow): void {
  const next = advanceFrom(task.schedule as 'once' | 'daily' | 'weekly' | 'hourly', detailOf(task))
  getDb()
    .prepare('UPDATE tasks SET defer_count = 0, next_fire_at = ?, updated_at = ? WHERE id = ?')
    .run(next, nowIso(), task.id)
}

function insertRun(taskId: string, scheduledAt: number, status: 'ok' | 'failed' | 'missed', note: string | null): void {
  getDb()
    .prepare('INSERT INTO task_runs (task_id, scheduled_at, ran_at, status, note) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, scheduledAt, status === 'missed' ? null : Date.now(), status, note)
}

/** 触发回合的框定注入(挂在上下文尾部,当前时间行之后) */
function taskBrief(task: TaskRow): string {
  const lines = [
    '[定时任务] 现在是你答应岛主的任务时刻。',
    `任务:${task.title}`,
    `岛主当时说:「${task.source_quote}」`,
    task.kind === 'remind'
      ? '按任务把该提醒、该转达的话现在说给岛主:一句话说清事由和时刻,不要啰嗦,也不要重新自我介绍。'
      : '按任务把事情办完(需要时用你的工具),然后把结果汇报给岛主;办不成就如实说卡在哪。'
  ]
  if (task.source_chat.startsWith('group:')) {
    lines.push('这件任务是岛主在群里交代的;执行和汇报都在你和岛主的这个单聊里进行,不用回群里说。')
  }
  return lines.join('\n')
}

async function fireTask(task: TaskRow, scheduledAt: number): Promise<void> {
  // 快照可能已过期:due 列表读出后任务可能被取消/改期(等待中的取消不该再跑一遍,
  // 白烧积分)。触发前重读认领——状态不在进行中或触发时刻已变(别轮扫过/已前滚)就放手
  const fresh = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRow | undefined
  if (!fresh || !ACTIVE_STATUSES.includes(fresh.status as TaskStatus) || fresh.next_fire_at !== scheduledAt) {
    return
  }
  task = fresh
  const bot = getBot(task.bot_id)
  if (!bot) {
    markOnce(task, 'canceled', null)
    return
  }
  // 居民正忙(岛主在聊/上一件任务没跑完):顺延 1 分钟,连续 DEFER_LIMIT 次后让位
  if (isTurnActive(task.bot_id)) {
    deferTask(task)
    return
  }
  firing.add(task.id)
  try {
    const win = BrowserWindow.getAllWindows()[0]
    // settled 守卫:runTurn 的成功/失败/异常路径都可能触达回调,只放第一次进状态机
    let settled = false
    await runTurn(bot, {
      depth: 0,
      silent: false,
      sender: win?.webContents,
      task: {
        taskId: task.id,
        brief: taskBrief(task),
        onSettled: (r) => {
          if (settled) return
          settled = true
          settleTask(task.id, scheduledAt, r)
        }
      }
    })
  } catch (err) {
    console.error('[tasks] 任务触发回合异常:', err)
    settleTask(task.id, scheduledAt, { ok: false, code: 'error' })
  } finally {
    firing.delete(task.id)
  }
}

function deferTask(task: TaskRow): void {
  const count = task.defer_count + 1
  if (count > DEFER_LIMIT) {
    if (task.schedule === 'once') {
      markOnce(task, 'missed', null)
      insertRun(task.id, task.next_fire_at ?? Date.now(), 'missed', '那会儿岛主正在和 TA 说话,任务没能插上')
      audit(task.bot_id, 'task_missed', { id: task.id, title: task.title, reason: 'busy' })
    } else {
      insertRun(task.id, task.next_fire_at ?? Date.now(), 'missed', '那会儿岛主正在和 TA 说话,这次跳过')
      rollForward(task)
    }
  } else {
    getDb()
      .prepare('UPDATE tasks SET defer_count = ?, next_fire_at = ?, updated_at = ? WHERE id = ?')
      .run(count, Date.now() + 60_000, nowIso(), task.id)
  }
  broadcastTasks(task.bot_id)
}

/** runTurn 结束回调:落触发历史、推进状态机(积分不足/超长/被停都如实交代) */
function settleTask(taskId: string, scheduledAt: number, result: { ok: boolean; code?: string }): void {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
  if (!row) return
  // 触发期间被岛主/居民取消:状态已终态,不再推进(那次触发的历史也不落)
  if (!ACTIVE_STATUSES.includes(row.status as TaskStatus)) return

  if (result.ok) {
    insertRun(taskId, scheduledAt, 'ok', null)
    audit(row.bot_id, 'task_fired', { id: taskId, title: row.title })
    if (row.schedule === 'once') {
      markOnce(row, 'done', null)
    } else {
      rollForward(row)
    }
    // 触发的消息已随回合落库:广播 ChatSync 让正看别的视图的岛主(与侧栏预览)都能刷到这次「主动开口」
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EV.ChatSync, { botId: row.bot_id } satisfies { botId: string })
    broadcastTasks(row.bot_id)
    return
  }
  switch (result.code) {
    case 'busy':
      deferTask(row)
      return
    case 'credits':
      insertRun(taskId, scheduledAt, 'failed', '积分不足,没能执行')
      if (row.schedule === 'once') markOnce(row, 'failed', 'credits')
      else rollForward(row)
      audit(row.bot_id, 'task_failed', { id: taskId, title: row.title, reason: 'credits' })
      break
    case 'context':
      insertRun(taskId, scheduledAt, 'failed', '对话太长,没能执行')
      if (row.schedule === 'once') markOnce(row, 'failed', 'context')
      else rollForward(row)
      audit(row.bot_id, 'task_failed', { id: taskId, title: row.title, reason: 'context' })
      break
    case 'aborted':
      insertRun(taskId, scheduledAt, 'failed', '那回合被停止')
      if (row.schedule === 'once') markOnce(row, 'failed', 'aborted')
      else rollForward(row)
      break
    default:
      insertRun(taskId, scheduledAt, 'failed', '回合出错,没能执行')
      if (row.schedule === 'once') markOnce(row, 'failed', 'error')
      else rollForward(row)
      audit(row.bot_id, 'task_failed', { id: taskId, title: row.title, reason: 'error' })
      break
  }
  broadcastTasks(row.bot_id)
}

// ---- IPC 出口(档案「任务」页签) ----

export function botTaskEntries(botId: string): BotTask[] {
  return listTaskRows(botId).map(toBotTask).sort((a, b) => {
    const rank = (t: BotTask): number => (ACTIVE_STATUSES.includes(t.status) ? 0 : 1)
    return rank(a) - rank(b)
  })
}

export function cancelTaskByOwner(taskId: string, botId: string): void {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ? AND bot_id = ?').get(taskId, botId) as TaskRow | undefined
  if (!row) throw new Error('任务不存在')
  if (ACTIVE_STATUSES.includes(row.status as TaskStatus)) {
    getDb()
      .prepare("UPDATE tasks SET status = 'canceled', next_fire_at = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), taskId)
    audit(botId, 'cancel_task', { id: taskId, title: row.title, by: 'owner' })
    broadcastTasks(botId)
  }
}
