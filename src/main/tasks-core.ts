// 定时任务纯逻辑(2026-10-29):DDL、时间模板计算、校验与展示文案——无 electron 依赖,冒烟同源验证;
// CRUD 与调度器(electron 依赖)在 tasks.ts

export const TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    schedule TEXT NOT NULL,
    fire_at INTEGER,
    schedule_detail TEXT,
    title TEXT NOT NULL,
    source_quote TEXT NOT NULL,
    source_chat TEXT NOT NULL DEFAULT 'dm',
    status TEXT NOT NULL,
    fail_reason TEXT,
    defer_count INTEGER NOT NULL DEFAULT 0,
    next_fire_at INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(next_fire_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_bot ON tasks(bot_id, status);

  CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    ran_at INTEGER,
    status TEXT NOT NULL,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_task_runs ON task_runs(task_id, id);
`

export const TASK_ACTIVE_LIMIT = 10 // 进行中任务上限(已完成/已取消不占坑)
export const HOURLY_ACTIVE_LIMIT = 2 // 每小时型并发上限(积分保护:10 件全是 hourly = 一天 240 回合)
export const CATCHUP_WINDOW_MS = 10 * 60_000 // 一次性任务错过补触发窗口;周期错过不补直接前滚
export const MAX_FUTURE_MS = 90 * 24 * 3600 * 1000 // 一次性最远登记 90 天
export const MIN_LEAD_MS = 60_000 // 一次性最早触发时刻:至少 1 分钟后(「现在就做」不是任务,是本回合的事)

export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export interface TaskScheduleDetailCore {
  /** 触发时刻 HH:MM(24 小时制,本地时区) */
  time?: string
  /** weekly:周几(0=周日 … 6=周六) */
  weekday?: number
  /** daily:仅工作日(周一至周五) */
  weekdaysOnly?: boolean
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function hm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 展示时刻:M月D日 HH:MM(本地时区) */
export function dateMinute(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm(d)}`
}

/** 人话时刻:今天/明天/本周周X/更远则月日 */
export function humanWhen(ms: number, now = new Date()): string {
  const d = new Date(ms)
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000)
  if (days === 0) return `今天 ${hm(d)}`
  if (days === 1) return `明天 ${hm(d)}`
  if (days > 1 && days <= 7) return `${WEEKDAY_NAMES[d.getDay()]} ${hm(d)}`
  return dateMinute(ms)
}

/** 相对时长:一次性任务卡上的「约 N 小时后」(超过 48 小时不标) */
export function humanIn(ms: number, now = Date.now()): string | null {
  const diff = ms - now
  if (diff <= 0 || diff > 48 * 3600_000) return null
  const minutes = Math.round(diff / 60000)
  if (minutes < 60) return `约 ${minutes} 分钟后`
  return `约 ${Math.round(minutes / 60)} 小时后`
}

export function parseTimeOfDay(text: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return { h, m: min }
}

/** 下一个 daily 触发时刻:今天的 time 没过就今天,否则往后滚(工作日型跳过周末) */
export function nextDaily(time: string, weekdaysOnly: boolean, from = Date.now()): number | null {
  const t = parseTimeOfDay(time)
  if (!t) return null
  const d = new Date(from)
  d.setHours(t.h, t.m, 0, 0)
  while (d.getTime() <= from || (weekdaysOnly && (d.getDay() === 0 || d.getDay() === 6))) {
    d.setDate(d.getDate() + 1)
    d.setHours(t.h, t.m, 0, 0)
  }
  return d.getTime()
}

/** 下一个 weekly 触发时刻:下一个指定星期几的 time。weekday 必须是 0–6 的整数——
 *  非整数(1.5 等)永远不等于 getDay(),while 会把主进程整个挂死 */
export function nextWeekly(weekday: number, time: string, from = Date.now()): number | null {
  const t = parseTimeOfDay(time)
  if (!t || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null
  const d = new Date(from)
  d.setHours(t.h, t.m, 0, 0)
  while (d.getTime() <= from || d.getDay() !== weekday) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** 一次性时刻解析:ISO(带时区)或本地 'YYYY-MM-DDTHH:mm' */
export function parseOnceAt(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  const ms = new Date(text).getTime()
  return Number.isNaN(ms) ? null : ms
}

/** 周期任务触发后的前滚:从 from 起算下个周期点(一定在未来) */
export function advanceFrom(
  schedule: 'once' | 'daily' | 'weekly' | 'hourly',
  detail: TaskScheduleDetailCore,
  from = Date.now()
): number | null {
  if (schedule === 'hourly') return from + 3600_000
  if (schedule === 'daily') return nextDaily(detail.time ?? '08:00', detail.weekdaysOnly === true, from)
  if (schedule === 'weekly') return nextWeekly(detail.weekday ?? 1, detail.time ?? '08:00', from)
  return null
}

/** 周期人话:每天 08:00(周一至周五)/ 每周三 09:00 / 每小时一次 */
export function scheduleTextOf(
  schedule: string,
  fireAt: number | null,
  detail: TaskScheduleDetailCore
): string {
  if (schedule === 'once') {
    const when = fireAt ? humanWhen(fireAt) : ''
    const rel = fireAt ? humanIn(fireAt) : null
    return rel ? `${when} · ${rel}` : when
  }
  if (schedule === 'daily') return `每天 ${detail.time ?? ''}${detail.weekdaysOnly ? '(周一至周五)' : ''}`
  if (schedule === 'weekly') return `每周${WEEKDAY_NAMES[detail.weekday ?? 1]} ${detail.time ?? ''}`
  return '每小时一次'
}

export function statusTextOf(status: string, failReason: string | null): string {
  switch (status) {
    case 'pending':
      return '待办'
    case 'active':
      return '进行中'
    case 'done':
      return '已完成'
    case 'missed':
      return '已错过'
    case 'canceled':
      return '已取消'
    case 'failed':
      // 2026-10-30 评审:「未执行」必须带原因,裸状态不交代等于让岛主猜
      if (failReason === 'credits') return '未执行·积分不足'
      if (failReason === 'context') return '未执行·对话太长'
      if (failReason === 'aborted') return '未执行·被停止'
      return '未执行·执行出错'
    default:
      return status
  }
}

// ---- 登记校验(纯函数):档位门/上限门/时间门的人话拒绝文案 ----

export interface TaskDraftCore {
  kind: string
  schedule: string
  fireAt?: string
  time?: string
  weekday?: number
  weekdaysOnly?: boolean
}

export interface ValidateCounts {
  active: number
  hourlyActive: number
}

/** 返回 { error } = 拒绝文案;返回 { fireAt, nextFireAt, detail } = 通过(时间已算好) */
export function validateTaskDraft(
  draft: TaskDraftCore,
  permission: string,
  counts: ValidateCounts,
  now = Date.now()
): { error: string } | { fireAt: number | null; nextFireAt: number; detail: TaskScheduleDetailCore | null } {
  // 拍板①:做事型仅全自动档;半自动接到做事请求要说清能力边界并指路转档,不硬登记
  if (draft.kind === 'act' && permission !== 'auto') {
    return {
      error:
        '这件任务到点要我自动办事(写文件、执行命令这类),需要「全自动」权限档位;你现在是半自动档。请如实跟岛主说:到点提醒没问题;要自动办事,得岛主先在 TA 的档案页把权限调成全自动,调好后再说一声,我马上登记——不要含糊答应。'
    }
  }
  let fireAt: number | null = null
  let nextFireAt: number | null
  let detail: TaskScheduleDetailCore | null = null
  if (draft.schedule === 'once') {
    fireAt = draft.fireAt ? parseOnceAt(draft.fireAt) : null
    if (!fireAt) return { error: '一次性任务需要 fire_at(触发时刻,如 2026-10-29T20:00),这个格式我读不出来。' }
    if (fireAt <= now + MIN_LEAD_MS) {
      return {
        error: `这个时刻(${humanWhen(fireAt, new Date(now))})已经到了或马上就到——现在就能做的事不用登记任务,直接办;要登记的请给我一个至少一分钟以后的时刻。`
      }
    }
    if (fireAt > now + MAX_FUTURE_MS) return { error: '超过 90 天的任务我记不牢,到时候再跟我说一声。' }
    nextFireAt = fireAt
  } else if (draft.schedule === 'daily') {
    if (!draft.time) return { error: '每天型任务需要 time(触发时刻 HH:MM)。' }
    detail = { time: draft.time, weekdaysOnly: draft.weekdaysOnly === true }
    nextFireAt = nextDaily(draft.time, draft.weekdaysOnly === true, now)
  } else if (draft.schedule === 'weekly') {
    if (draft.weekday === undefined || draft.time === undefined) {
      return { error: '每周型任务需要 weekday(0=周日…6=周六)和 time(HH:MM)。' }
    }
    detail = { weekday: draft.weekday, time: draft.time }
    nextFireAt = nextWeekly(draft.weekday, draft.time, now)
  } else if (draft.schedule === 'hourly') {
    if (counts.hourlyActive >= HOURLY_ACTIVE_LIMIT) {
      return {
        error: `每小时一次的任务同时最多 ${HOURLY_ACTIVE_LIMIT} 件(真跑一次真花一次积分),已经满了。先取消一件旧的,或跟岛主商量改成每天固定时刻。`
      }
    }
    nextFireAt = now + 3600_000
  } else {
    return { error: 'schedule 只能是 once(一次性)、daily(每天)、weekly(每周)或 hourly(每小时)。' }
  }
  if (nextFireAt === null) return { error: '时间参数无效,登记不上。' }
  if (counts.active >= TASK_ACTIVE_LIMIT) {
    return { error: `我的任务清单满了(最多同时 ${TASK_ACTIVE_LIMIT} 件进行中)。先取消一件旧的再登记。` }
  }
  return { fireAt, nextFireAt, detail }
}
