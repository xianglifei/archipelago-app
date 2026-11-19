// 看板卡片纯逻辑(2026-11-19 需求 - 看板:卡片与任务会话联动):DDL 单点 + 状态读时推导。
// 卡片 = 未开跑的任务会话预约 + 进度投影:执行体永远是任务会话(task_threads),
// 本模块不含 electron 依赖,单测同源验证(惯例同 skills-core/tasks-core)。
// 设计立场(需求 §5.1/§7.1):四列归属不落列——持久层只存事实(时间戳),
// 归属读时推导,重启即自洽;dsh-kanban 的 30s reconcile 兜底因此整个不需要。
import type { CardStatus } from '@shared/types'

/** cards 表 DDL(store.ts migrate 挂载;幂等 CREATE,存量库零风险) */
export const CARDS_DDL = `
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,              -- uuid
    seq INTEGER NOT NULL,             -- 展示短号(卡-N),建卡分配,单调递增不复用
    title TEXT NOT NULL DEFAULT '',   -- 手写标题;''=展示取正文首行
    body TEXT NOT NULL DEFAULT '',    -- 正文;执行时作为任务会话首条消息
    bot_id TEXT,                      -- 指派居民;NULL=未指派(执行前必须指派)
    thread_id TEXT,                   -- 执行体任务会话;NULL=尚未执行
    workdir_path TEXT,                -- 建卡时预选的工作目录(执行时才绑定到线程);NULL=无
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_run_started_at TEXT,         -- 最近一次执行/重跑时刻(running 的持久锚之一)
    last_run_ended_at TEXT,           -- 最近一次回合落定时刻
    finishing_since TEXT,             -- 两段式完成:收尾提示词已发、等回合正常结束
    done_at TEXT,                     -- 完成时刻;撤销完成置 NULL
    error TEXT                        -- 最近执行失败的人话原因(角标展示,非状态列)
  );
  CREATE INDEX IF NOT EXISTS idx_cards_thread ON cards(thread_id);
`

/** cards 表行形状(持久事实;派生态不落库) */
export interface CardRow {
  id: string
  seq: number
  title: string
  body: string
  bot_id: string | null
  thread_id: string | null
  workdir_path: string | null
  created_at: string
  updated_at: string
  last_run_started_at: string | null
  last_run_ended_at: string | null
  finishing_since: string | null
  done_at: string | null
  error: string | null
}

/** 状态推导的运行时快照(内存态,读时取):线程回合是否在跑 / 线程挂起审批数 */
export interface CardRuntimeSnapshot {
  threadActive: boolean
  pendingApprovals: number
}

/**
 * 四列归属(读时推导,优先级自上而下):
 * done > 无线程 todo > 从未跑起来的失败(准备链断:绑定被拒/目录异常/中途退出,回待过目) >
 * 准备中(线程已建、首条消息未发,典型=绑定授权卡等待批准) > 收尾中 > 回合在跑 > 待审阅。
 */
export function statusOf(
  card: Pick<CardRow, 'done_at' | 'thread_id' | 'last_run_started_at' | 'finishing_since' | 'error'>,
  rt: CardRuntimeSnapshot
): CardStatus {
  if (card.done_at) return 'done'
  if (!card.thread_id) return 'todo'
  // 从未跑起来的失败不当「准备中」吊着:回待过目,角标讲原因,岛主重新执行即是出路
  if (card.error && !card.last_run_started_at) return 'review'
  if (!card.last_run_started_at) return 'running'
  if (card.finishing_since) return 'running'
  if (rt.threadActive) return 'running'
  return 'review'
}

/** 正文首行(标题为空时的展示兜底);长度截断留给渲染端,这里只取行 */
export function bodyFirstLine(body: string): string {
  return body.split('\n')[0]?.trim() ?? ''
}

/** 列表展示标题:手写标题 > 正文首行 > ''(全空由渲染端显示「未命名卡片」) */
export function displayTitleOf(title: string, body: string): string {
  const t = title.trim()
  if (t) return t
  return bodyFirstLine(body)
}
