// 看板卡片(2026-11-19 需求 - 看板:卡片与任务会话联动):CRUD + 执行链 + 回合落定推进 + 启动清理。
// 核心立场:卡片不是第三套任务执行系统——执行体永远是任务会话。「执行」= 建线程(首次)+
// 手改线程标题钉住(手动改名口径永不覆盖,恰好抢在首轮自动起名之前)+ 可选绑定工作目录 +
// 卡片正文作为首条消息开跑;四列归属读时推导(kanban-core statusOf),不落库。
// 回合落定经 chat.ts 的注册制监听回调进本模块(setThreadSettleListener,防 chat↔kanban
// 循环依赖——本模块要用 sendTaskThreadMessage/activeTurnKinds,反向 import 会成环);
// 回调自身全兜异常:看板故障不许影响回合本身(需求 §13-1)。
import { BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { EV } from '@shared/ipc-channels'
import type { BoardCard, CardActionResult, CardInput, CardsPrefs } from '@shared/types'
import { getDb, metaGet, metaSet, nowIso } from './store'
import { getBot } from './bots'
import { getOrCreateTaskSession, insertMessage } from './sessions'
import { createTaskThread, getTaskThread, renameTaskThread } from './task-threads'
import { bindTaskWorkdir } from './task-workdir'
import { activeTurnKinds, sendTaskThreadMessage, setThreadSettleListener } from './chat'
import { pendingApprovalsByThread } from './approval'
import { uiStr } from './ui-strings'
import { bodyFirstLine, displayTitleOf, statusOf, type CardRow } from './kanban-core'

function broadcastCards(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EV.CardsChanged)
}

function rowOf(id: string): CardRow | null {
  return (getDb().prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined) ?? null
}

/** 短号分配:max+1(单进程 SQLite 事务内,无并发问题;需求 §13-5 记了多窗口时的改法) */
function nextSeq(): number {
  const row = getDb().prepare('SELECT MAX(seq) AS m FROM cards').get() as { m: number | null }
  return (row.m ?? 0) + 1
}

/** 读时聚合:持久行 + 内存快照(回合注册表/挂起审批)+ 线程摘要 → BoardCard */
function toBoardCard(row: CardRow): BoardCard {
  const activeKeys = activeTurnKinds()
  const pending = pendingApprovalsByThread()
  const thread = row.thread_id ? getTaskThread(row.thread_id) : null
  const threadActive = !!row.thread_id && activeKeys.has(`task:${row.thread_id}`)
  const pendingCount = row.thread_id ? (pending.get(row.thread_id) ?? 0) : 0
  return {
    id: row.id,
    seq: row.seq,
    title: row.title,
    displayTitle: displayTitleOf(row.title, row.body),
    body: row.body,
    botId: row.bot_id,
    threadId: row.thread_id,
    workdirPath: row.workdir_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunStartedAt: row.last_run_started_at,
    lastRunEndedAt: row.last_run_ended_at,
    doneAt: row.done_at,
    error: row.error,
    status: statusOf(row, { threadActive, pendingApprovals: pendingCount }),
    preparing: !!row.thread_id && !row.last_run_started_at && !row.done_at && !row.error,
    finishing: !!row.finishing_since && !row.done_at,
    awaiting: pendingCount > 0 && !row.done_at,
    threadTitle: thread?.title ? thread.title : null,
    threadArchived: thread ? thread.status !== 'open' : false
  }
}

function boardCardOf(id: string): BoardCard {
  const row = rowOf(id)
  if (!row) throw new Error('卡片不存在')
  return toBoardCard(row)
}

// ---- CRUD ----

export function listCards(): BoardCard[] {
  const rows = getDb().prepare('SELECT * FROM cards ORDER BY seq DESC').all() as CardRow[]
  return rows.map(toBoardCard)
}

export function createCard(input: CardInput): BoardCard {
  const now = nowIso()
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO cards (id, seq, title, body, bot_id, thread_id, workdir_path, created_at, updated_at,
        last_run_started_at, last_run_ended_at, finishing_since, done_at, error)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`
    )
    .run(id, nextSeq(), input.title.trim(), input.body, input.botId, input.workdirPath, now, now)
  broadcastCards()
  return boardCardOf(id)
}

export function updateCard(id: string, input: CardInput): BoardCard {
  const row = rowOf(id)
  if (!row) throw new Error('卡片不存在')
  // 护栏(需求 §6.2):执行过的卡禁改正文与工作目录——历史首条消息是正文快照,
  // 绑定是线程资产;标题与指派不受限。换目录走会话头部 chip 既有出口(换绑开新代次)
  if (row.thread_id && (input.body !== row.body || input.workdirPath !== row.workdir_path)) {
    throw new Error('卡片已经执行过,正文与工作目录不能再改;标题与指派不受限。')
  }
  if (input.botId && !getBot(input.botId)) throw new Error('居民不存在')
  getDb()
    .prepare('UPDATE cards SET title = ?, body = ?, bot_id = ?, workdir_path = ?, updated_at = ? WHERE id = ?')
    .run(input.title.trim(), input.body, input.botId, input.workdirPath, nowIso(), id)
  broadcastCards()
  return boardCardOf(id)
}

/** 删卡只删卡(P7):任务会话与聊天记录一律保留,不级联 */
export function deleteCard(id: string): void {
  getDb().prepare('DELETE FROM cards WHERE id = ?').run(id)
  broadcastCards()
}

// ---- 执行链 ----

/** 执行链进行中守卫(防连点/链内重入):链路终态(含失败)必清 */
const runChains = new Set<string>()

/**
 * 执行/再执行:同步段(校验/建线程/钉标题)当场完成并返回;绑定授权(无超时,岛主慢慢看)
 * 与投递正文在后台链推进,进度经 EV.CardsChanged 通知。workdir 卡的绑定授权卡落线程会话,
 * 返回 threadId 供渲染端引导岛主进会话拍板。
 */
export function runCard(id: string, sender: WebContents): CardActionResult {
  const row = rowOf(id)
  if (!row) return { ok: false, message: '卡片不存在' }
  if (row.done_at) return { ok: false, message: '卡片已完成;先撤销完成,再重新执行。' }
  if (runChains.has(id)) return { ok: false, message: '这张卡正在启动,稍候。' }
  if (!row.bot_id || !getBot(row.bot_id)) return { ok: false, message: '先给卡片指派一位居民,才能执行。' }
  let threadId = row.thread_id
  if (!threadId) {
    // 首次执行:建线程 + 手改标题钉住(手动改名永不覆盖,恰好抢在首轮自动起名之前;需求 §6.3)
    const thread = createTaskThread(row.bot_id)
    renameTaskThread(thread.id, displayTitleOf(row.title, row.body) || bodyFirstLine(row.body) || '看板卡片')
    getDb().prepare('UPDATE cards SET thread_id = ?, updated_at = ? WHERE id = ?').run(thread.id, nowIso(), id)
    threadId = thread.id
    broadcastCards()
  } else {
    const thread = getTaskThread(threadId)
    if (!thread || thread.status !== 'open') {
      return { ok: false, message: '这个任务会话已经结束;卡片保留,但不能再执行。' }
    }
    if (activeTurnKinds().has(`task:${threadId}`)) {
      return { ok: false, message: '这一轮还在跑,等它结束再执行。' }
    }
  }
  runChains.add(id)
  void runChain(id, threadId, sender)
  return { ok: true, message: '', threadId }
}

/** 哑 sender:绑定等待期间窗口可能重载销毁——消息照落库、回合照跑,只是没有实时流事件 */
const DUMMY_SENDER = { send: () => undefined } as unknown as WebContents

function safeSender(sender: WebContents): WebContents {
  try {
    return sender.isDestroyed() ? DUMMY_SENDER : sender
  } catch {
    return DUMMY_SENDER
  }
}

function failCard(id: string, message: string): void {
  getDb().prepare('UPDATE cards SET error = ?, updated_at = ? WHERE id = ?').run(message, nowIso(), id)
  broadcastCards()
}

/**
 * 后台链:可选绑定(绑定授权卡等待,M8 期间挡回合)→ 投正文开跑。
 * 任何一步失败:线程里落一条可见回执(同 TaskThreadCreate 口径)+ 卡片标「未成」回待过目。
 */
async function runChain(id: string, threadId: string, sender: WebContents): Promise<void> {
  try {
    const row = rowOf(id)
    if (!row) return
    const bot = row.bot_id ? getBot(row.bot_id) : null
    if (!bot) {
      failCard(id, '居民不存在')
      return
    }
    if (row.workdir_path && !getTaskThread(threadId)?.workdirPath) {
      const outcome = await bindTaskWorkdir(bot, threadId, row.workdir_path, { forceDirect: false })
      if (!outcome.ok) {
        const session = getOrCreateTaskSession(bot.id, threadId)
        insertMessage(
          session.id,
          'assistant',
          '',
          `看板卡的工作目录绑定没有通过:${outcome.message}在卡片上重新执行,或点任务头部的工作目录标签重新绑定。`,
          false,
          'note'
        )
        failCard(id, `工作目录绑定没有通过:${outcome.message}`)
        return
      }
    }
    getDb()
      .prepare('UPDATE cards SET last_run_started_at = ?, error = NULL, updated_at = ? WHERE id = ?')
      .run(nowIso(), nowIso(), id)
    broadcastCards()
    await sendTaskThreadMessage(threadId, row.body, safeSender(sender))
  } catch (err) {
    failCard(id, err instanceof Error ? err.message : String(err))
  } finally {
    runChains.delete(id)
  }
}

// ---- 完成 / 撤销 ----

/**
 * 「完成之后」要发的收尾消息(纯函数,卡档位判定与参数拼装,测试直测):
 * null=直接完成。none 恒 null;prompt=自定义或默认文案;smart=工作树线程(wtBranch/wtPath/
 * workdirPath 齐)拼 dsh mergePrompt 群岛化的合并收尾指令,否则 null。
 */
export function finishMessageOf(
  row: Pick<CardRow, 'title' | 'body'>,
  thread: { status: string; wtBranch: string | null; wtPath: string | null; workdirPath: string | null; wtBase: string | null; wtBaseCommit: string | null } | null,
  prefs: CardsPrefs & { finishPromptDefault: string }
): string | null {
  if (!thread || thread.status !== 'open') return null
  if (prefs.finishMode === 'prompt') return prefs.finishPrompt ?? prefs.finishPromptDefault
  if (prefs.finishMode === 'smart' && thread.wtBranch && thread.wtPath && thread.workdirPath) {
    return uiStr('boardFinishSmartPrompt', {
      title: displayTitleOf(row.title, row.body) || uiStr('boardCardUntitled'),
      repoRoot: thread.workdirPath,
      branch: thread.wtBranch,
      worktree: thread.wtPath,
      base: thread.wtBase ?? '',
      baseCommit: (thread.wtBaseCommit ?? '').slice(0, 12)
    })
  }
  return null
}

// ---- 偏好与设置(2026-11-19 第二批,meta KV;键集中在 kanban.* 命名空间)----

/** 读偏好;finishMode 缺省时按旧版 finishPrompt 推断(''→none/自定义→prompt/未设置→smart 新默认) */
export function cardsPrefsGet(): CardsPrefs & { finishPromptDefault: string } {
  const mode = metaGet<'none' | 'prompt' | 'smart'>('kanban.finishMode')
  const legacyPrompt = metaGet<string>('kanban.finishPrompt')
  return {
    viewMode: metaGet<'board' | 'list'>('kanban.viewMode') === 'list' ? 'list' : 'board',
    doneCollapsed: metaGet<boolean>('kanban.doneCollapsed') !== false,
    finishMode:
      mode === 'none' || mode === 'prompt' || mode === 'smart'
        ? mode
        : legacyPrompt === ''
          ? 'none'
          : legacyPrompt !== null
            ? 'prompt'
            : 'smart',
    // 旧版空串=关闭两段式,已由 finishMode 承接;存储层归一为 null=默认
    finishPrompt: legacyPrompt === '' ? null : legacyPrompt,
    finishPromptDefault: uiStr('boardFinishPromptDefault')
  }
}

/** 改偏好(部分补丁,只动给到的键);finishPrompt 传 null=恢复默认(存 null 与未设置同读) */
export function cardsPrefsSet(patch: Partial<CardsPrefs>): CardsPrefs {
  if (patch.viewMode === 'board' || patch.viewMode === 'list') metaSet('kanban.viewMode', patch.viewMode)
  if (typeof patch.doneCollapsed === 'boolean') metaSet('kanban.doneCollapsed', patch.doneCollapsed)
  if (patch.finishMode === 'none' || patch.finishMode === 'prompt' || patch.finishMode === 'smart') {
    metaSet('kanban.finishMode', patch.finishMode)
  }
  if (patch.finishPrompt !== undefined) metaSet('kanban.finishPrompt', patch.finishPrompt)
  const fresh = cardsPrefsGet()
  return { viewMode: fresh.viewMode, doneCollapsed: fresh.doneCollapsed, finishMode: fresh.finishMode, finishPrompt: fresh.finishPrompt }
}

export async function cardDone(id: string, sender: WebContents): Promise<CardActionResult> {
  const row = rowOf(id)
  if (!row) return { ok: false, message: '卡片不存在' }
  if (row.done_at) return { ok: false, message: '卡片已经是完成状态。' }
  if (runChains.has(id)) return { ok: false, message: '这张卡正在启动,稍候。' }
  const thread = row.thread_id ? getTaskThread(row.thread_id) : null
  // 「完成之后」三档(走查拍板 2026-11-19,对齐 dsh),判定与拼装收口在 finishMessageOf;
  // 无线程/线程已结束/拼不出消息:一律直接完成
  const message = finishMessageOf(row, thread, cardsPrefsGet())
  if (!thread || !message) {
    directDone(id)
    return { ok: true, message: '' }
  }
  if (activeTurnKinds().has(`task:${row.thread_id}`)) {
    return { ok: false, message: '这一轮还在跑,等它结束再完成。' }
  }
  const bot = getBot(thread.botId)
  if (!bot) {
    directDone(id)
    return { ok: true, message: '' }
  }
  getDb().prepare('UPDATE cards SET finishing_since = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id)
  broadcastCards()
  try {
    await sendTaskThreadMessage(thread.id, message, safeSender(sender))
  } catch (err) {
    // 收尾没发出去(任务结束握手中等):回到待过目,不吊在「收尾中」
    const text = err instanceof Error ? err.message : String(err)
    getDb()
      .prepare('UPDATE cards SET finishing_since = NULL, error = ?, updated_at = ? WHERE id = ?')
      .run(text, nowIso(), id)
    broadcastCards()
    return { ok: false, message: text }
  }
  return { ok: true, message: '' }
}

function directDone(id: string): void {
  getDb()
    .prepare('UPDATE cards SET done_at = ?, finishing_since = NULL, updated_at = ? WHERE id = ?')
    .run(nowIso(), nowIso(), id)
  broadcastCards()
}

/** 撤销完成:卡回「待审阅」;线程一律不动(不归档不清工作树,需求 P6) */
export function undoneCard(id: string): BoardCard {
  const row = rowOf(id)
  if (!row) throw new Error('卡片不存在')
  getDb().prepare('UPDATE cards SET done_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id)
  broadcastCards()
  return boardCardOf(id)
}

// ---- 回合落定推进(chat.ts 注册回调) ----

/**
 * 线程回合收口(全路径必经的 finally)时推进卡片:落 last_run_ended_at、清/标 error、
 * 两段式完成在收尾回合正常结束时落 done(被停/失败不落,finishing 清空回待过目,需求 §6.5)。
 * 全兜异常——看板故障不许影响回合本身。
 */
function onThreadTurnSettled(threadId: string, ok: boolean): void {
  try {
    const row = getDb().prepare('SELECT * FROM cards WHERE thread_id = ?').get(threadId) as CardRow | undefined
    if (!row) return
    if (ok && row.finishing_since && !row.done_at) {
      getDb()
        .prepare(
          'UPDATE cards SET done_at = ?, finishing_since = NULL, last_run_ended_at = ?, error = NULL, updated_at = ? WHERE id = ?'
        )
        .run(nowIso(), nowIso(), nowIso(), row.id)
    } else if (ok) {
      getDb()
        .prepare('UPDATE cards SET last_run_ended_at = ?, error = NULL, updated_at = ? WHERE id = ?')
        .run(nowIso(), nowIso(), row.id)
    } else {
      getDb()
        .prepare(
          'UPDATE cards SET last_run_ended_at = ?, error = ?, finishing_since = NULL, updated_at = ? WHERE id = ?'
        )
        .run(nowIso(), uiStr('boardTurnFailed'), nowIso(), row.id)
    }
    broadcastCards()
  } catch (err) {
    console.error('[kanban] 回合落定推进失败:', err)
  }
}

// ---- 初始化(auth.ts 登录挂载后调用) ----

/**
 * 注册回合落定监听 + 启动清理。幂等:重复挂载(重登)只是重注册同款监听与重跑清理。
 * 清理两项(需求 §6.6):孤儿收尾(收尾提示词发出后应用退出,回合等不到结束事件)与
 * 断链准备(线程已建但首条消息从未发出,典型=绑定授权等待期退出)——读时推导下 running
 * 本就随内存注册表消失,这是仅有的两个持久过渡态。
 */
export function initKanban(): void {
  setThreadSettleListener(onThreadTurnSettled)
  getDb().prepare('UPDATE cards SET finishing_since = NULL WHERE finishing_since IS NOT NULL').run()
  getDb()
    .prepare(
      'UPDATE cards SET error = ? WHERE thread_id IS NOT NULL AND last_run_started_at IS NULL AND done_at IS NULL AND error IS NULL'
    )
    .run('上次执行没有跑起来(可能中途退出了应用),重新执行即可。')
  broadcastCards()
}
