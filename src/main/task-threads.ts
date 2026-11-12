import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import { EV } from '@shared/ipc-channels'
import { sanitizeManualTitle, sanitizeTaskTitle, TASK_TITLE_MAX } from '@shared/task-title-core'
import type { TaskThreadInfo } from '@shared/types'
import { getBot } from './bots'
import { chatOnce, llmCredentials } from './llm'
import { getDb, nowIso } from './store'
import { getOrCreateTaskSession } from './sessions'
import { directBrief, worktreeBrief, type TaskExecBase } from './task-workdir-core'

export type { TaskExecBase }

// 任务会话(2026-11-06「新建任务」,方案=doc/需求 - 新建任务(上下文隔离的居民专属会话) - 2026-11-06.md):
// 岛主给某居民开一个上下文隔离的专属工作会话——继承人设/性格/技能/持久记忆与全部能力,
// 但上下文与单聊完全隔离、从零开始;消息列表里独立成行(居民头像+任务签,标题初始「新任务」)。
// 与 tasks.ts(定时任务)是两个概念:这里是岛主主动开的、人在场的会话;TurnKind 也不新增值
// (定时任务已占 'task'),本模块对外一律用 taskThread/task_threads/task: 前缀避免撞名。
//
// 2026-11-10 任务会话并行开发第一批:线程获得工作目录绑定与 git 隔离执行能力——
// workdir_path NULL=legacy(零回归);绑定后回合的执行基点切到工作树/直连目录(编排见 task-workdir.ts)。

/** 整表新增幂等 CREATE(store.migrate 执行;单测同源验证);2026-11-10 起含工作目录绑定列族 */
export const TASK_THREADS_DDL = `
  CREATE TABLE IF NOT EXISTS task_threads (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    workdir_path TEXT,
    binding_source TEXT,
    binding_generation INTEGER NOT NULL DEFAULT 0,
    wt_state TEXT NOT NULL DEFAULT 'none',
    wt_path TEXT,
    wt_branch TEXT,
    wt_base TEXT,
    wt_base_commit TEXT,
    wt_error TEXT,
    leftover_seq INTEGER NOT NULL DEFAULT 0,
    merged_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_task_threads_bot ON task_threads(bot_id, status);
`

/**
 * 存量库增量迁移(2026-11-10 第一批):task_threads 补工作目录绑定列族(守卫式 ALTER,
 * 与 messages 列族同款 pragma 探测)。旧库补列全 NULL/默认值 = legacy,绑定列恒 NULL 的
 * 线程任何回合不自动解析、行为与旧版完全一致(P8-a 零回归)。
 */
export function migrateTaskThreadsWorkdirColumns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(task_threads)').all() as { name: string }[]
  const has = (n: string): boolean => cols.some((c) => c.name === n)
  if (!has('workdir_path')) db.exec('ALTER TABLE task_threads ADD COLUMN workdir_path TEXT')
  if (!has('binding_source')) db.exec('ALTER TABLE task_threads ADD COLUMN binding_source TEXT')
  if (!has('binding_generation')) db.exec('ALTER TABLE task_threads ADD COLUMN binding_generation INTEGER NOT NULL DEFAULT 0')
  if (!has('wt_state')) db.exec("ALTER TABLE task_threads ADD COLUMN wt_state TEXT NOT NULL DEFAULT 'none'")
  if (!has('wt_path')) db.exec('ALTER TABLE task_threads ADD COLUMN wt_path TEXT')
  if (!has('wt_branch')) db.exec('ALTER TABLE task_threads ADD COLUMN wt_branch TEXT')
  if (!has('wt_base')) db.exec('ALTER TABLE task_threads ADD COLUMN wt_base TEXT')
  if (!has('wt_base_commit')) db.exec('ALTER TABLE task_threads ADD COLUMN wt_base_commit TEXT')
  if (!has('wt_error')) db.exec('ALTER TABLE task_threads ADD COLUMN wt_error TEXT')
  if (!has('leftover_seq')) db.exec('ALTER TABLE task_threads ADD COLUMN leftover_seq INTEGER NOT NULL DEFAULT 0')
  if (!has('merged_at')) db.exec('ALTER TABLE task_threads ADD COLUMN merged_at TEXT')
}

/**
 * 任务框定行(挂上下文最尾、当前时间行之后,同定时任务 brief 的注入位):
 * 声明这是独立工作空间——单聊历史不在这里,但性格/记忆/技能照旧,居民以执行者身份开口。
 */
export const TASK_THREAD_BRIEF =
  '[任务会话] 岛主为一件具体的事把你叫到了这个专属工作会话。这是你们之间的独立空间:这里没有平时单聊的历史,你带着自己的性格、记忆与技能从零开始;岛主交代什么就专注做什么,这里的对话只有你们俩可见。跨居民私信与群聊工具照常可用。这个会话的标题默认叫「新任务」,系统会在首轮对话后自动起一个短标题,无需你操心。'

interface TaskThreadRow {
  id: string
  bot_id: string
  title: string
  status: string
  created_at: string
  updated_at: string
  workdir_path: string | null
  binding_source: string | null
  binding_generation: number | null
  wt_state: string | null
  wt_path: string | null
  wt_branch: string | null
  wt_base: string | null
  wt_base_commit: string | null
  wt_error: string | null
  leftover_seq: number | null
  merged_at: string | null
}

function fromRow(row: TaskThreadRow): TaskThreadInfo {
  return {
    id: row.id,
    botId: row.bot_id,
    title: row.title,
    status: row.status === 'archived' ? 'archived' : 'open',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workdirPath: row.workdir_path ?? null,
    bindingSource:
      row.binding_source === 'explicit' || row.binding_source === 'detected' || row.binding_source === 'inherited'
        ? row.binding_source
        : null,
    bindingGeneration: row.binding_generation ?? 0,
    wtState: row.wt_state ?? 'none',
    wtPath: row.wt_path ?? null,
    wtBranch: row.wt_branch ?? null,
    wtBase: row.wt_base ?? null,
    wtBaseCommit: row.wt_base_commit ?? null,
    leftoverSeq: row.leftover_seq ?? 0,
    wtError: row.wt_error ?? null
  }
}

// ---- 工作目录绑定:执行基点与 brief 推导(2026-11-10 第一批)----
// TaskExecBase 形状定义在 task-workdir-core(纯逻辑层),本文件 re-export 保持两侧 import 路径可用

/**
 * 线程当前执行基点:worktree 就绪 → 工作树(硬围栏);直连 → 绑定目录(软围栏);
 * legacy/未就绪/error → null(回合在入口就被拦,工具层拿不到基点=不可能带着旧基点跑)。
 */
export function taskExecBaseOf(thread: TaskThreadInfo): TaskExecBase | null {
  if (!thread.workdirPath) return null
  if (thread.wtBranch && thread.wtPath) {
    return thread.wtState === 'ready' ? { root: thread.wtPath, mode: 'worktree', hardFence: true } : null
  }
  // 无分支 = 直连绑定(P4-a:非 git 目录或岛主显式改选)
  return { root: thread.workdirPath, mode: 'direct', hardFence: false }
}

/**
 * 工作目录段的 brief(worktree=分支契约,直连=无隔离声明);与基点同源判定。
 * 正常组装与上下文压缩重建两条路径统一走这里(chat.ts 不自行拼文案)。
 */
export function taskWorkdirBriefOf(thread: TaskThreadInfo): string | null {
  if (!thread.workdirPath) return null
  if (thread.wtBranch && thread.wtPath) {
    if (thread.wtState !== 'ready' || !thread.wtBaseCommit) return null
    return worktreeBrief(thread.wtBranch, thread.wtBaseCommit, thread.wtPath)
  }
  return directBrief(thread.workdirPath)
}

/** 线程列表有变动(新建/改名/结束/标题生成/工作目录绑定状态)时广播,渲染端重拉清单与消息列表预览 */
export function broadcastThreads(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EV.ThreadsChanged)
}

/** 给居民开一个新任务会话:落线程行 + 预建会话(空线程即上消息列表,不等第一条消息) */
export function createTaskThread(botId: string): TaskThreadInfo {
  const bot = getBot(botId)
  if (!bot) throw new Error('居民不存在')
  const now = nowIso()
  const thread: TaskThreadInfo = {
    id: randomUUID(),
    botId,
    title: '',
    status: 'open',
    createdAt: now,
    updatedAt: now,
    workdirPath: null,
    bindingSource: null,
    bindingGeneration: 0,
    wtState: 'none',
    wtPath: null,
    wtBranch: null,
    wtBase: null,
    wtBaseCommit: null,
    leftoverSeq: 0,
    wtError: null
  }
  getDb()
    .prepare('INSERT INTO task_threads (id, bot_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(thread.id, thread.botId, '', 'open', thread.createdAt, thread.updatedAt)
  getOrCreateTaskSession(botId, thread.id)
  broadcastThreads()
  return thread
}

/** 进行中的线程清单(归档的不返回;顺序仅供调试,列表排序由渲染端按预览 lastAt 混排) */
export function listTaskThreads(): TaskThreadInfo[] {
  const rows = getDb()
    .prepare("SELECT * FROM task_threads WHERE status = 'open' ORDER BY updated_at DESC")
    .all() as TaskThreadRow[]
  return rows.map(fromRow)
}

export function getTaskThread(id: string): TaskThreadInfo | null {
  const row = getDb().prepare('SELECT * FROM task_threads WHERE id = ?').get(id) as TaskThreadRow | undefined
  return row ? fromRow(row) : null
}

/** 手改任务标题(压空白+截 40,不去引号句读);改过即视为已命名,自动起名永不覆盖 */
export function renameTaskThread(id: string, rawTitle: string): TaskThreadInfo {
  const thread = getTaskThread(id)
  if (!thread) throw new Error('任务不存在')
  // 岛主自己写的标题:只压空白;引号/句读想带就带(与模型起的净化口径区分)。空=回到「新任务」
  const title = sanitizeManualTitle(rawTitle) ?? ''
  const updatedAt = nowIso()
  getDb().prepare('UPDATE task_threads SET title = ?, updated_at = ? WHERE id = ?').run(title, updatedAt, id)
  broadcastThreads()
  return { ...thread, title, updatedAt }
}

/** 结束任务:归档软删(会话与消息全保留,列表不再显示);进行中回合由调用方先停 */
export function closeTaskThread(id: string): void {
  getDb().prepare("UPDATE task_threads SET status = 'archived', updated_at = ? WHERE id = ?").run(nowIso(), id)
  broadcastThreads()
}

/** 标题起名的小模型 system 提示(输出语言随对话,长度与净化上限同源) */
const TITLE_SYSTEM_PROMPT =
  `你给一段对话起个标题。基于对话的内容,概括这个对话的主旨,不超过 ${TASK_TITLE_MAX} 个字,只输出标题本身,不加引号、句号或任何解释。`

/**
 * 首轮对话结束后自动起标题(P3:只在标题还是空串时发生一次;手改过或已生成过永不覆盖)。
 * 后台小调用(同记忆整理 runReview 模式):temperature 0、maxTokens 紧、坏输出丢弃保持「新任务」、
 * 失败静默(下轮结束标题仍为空会再试)。chat.ts 在任务回合 settled 后 fire-and-forget 调这里。
 */
export async function tryGenerateTaskThreadTitle(
  threadId: string,
  userText: string,
  assistantText: string
): Promise<void> {
  const thread = getTaskThread(threadId)
  if (!thread || thread.status !== 'open' || thread.title !== '') return
  const creds = llmCredentials((getBot(thread.botId)?.providerId) ?? 'archipelago')
  if (!creds.apiKey) {
    console.log('[task-threads] 起名跳过:无凭证(未登录?)')
    return
  }
  try {
    const result = await chatOnce({
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      model: getBot(thread.botId)?.modelId ?? 'deepseek-flash',
      // 预算要给足:deepseek 经 relay 是推理模型,非流式下 reasoning_content 先行——
      // 预算太小会全被思考吃光(finish=length 且 content 空,实测 48 即如此),正文永远出不来;
      // 空正文时标题保持空,下一轮自然重试(只在空标题时生成的守卫即重试机制)
      maxTokens: 1024,
      temperature: 0,
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `【岛主说】\n${userText.slice(0, 1500)}\n\n【居民回复(节选)】\n${assistantText.slice(0, 800)}`
        }
      ]
    })
    console.log(`[task-threads] 起名调用返回:finish=${result.finishReason} content=${JSON.stringify(result.content.slice(0, 60))}`)
    const title = sanitizeTaskTitle(result.content)
    if (!title) {
      console.log('[task-threads] 起名净化后为空,保持「新任务」')
      return
    }
    // 落库前再核一次:起名期间岛主可能已手改(手改优先,绝不覆盖)
    const fresh = getTaskThread(threadId)
    if (!fresh || fresh.status !== 'open' || fresh.title !== '') return
    getDb().prepare('UPDATE task_threads SET title = ?, updated_at = ? WHERE id = ?').run(title, nowIso(), threadId)
    console.log(`[task-threads] 已起名:thread=${threadId.slice(0, 8)} title=${JSON.stringify(title)}`)
    broadcastThreads()
  } catch (err) {
    console.error('[task-threads] 自动起标题失败(保持「新任务」):', err)
  }
}
