import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Bot, TaskThreadInfo } from '@shared/types'
import { audit } from './audit'
import { getBot } from './bots'
import { requestApproval } from './approval'
import { gitAvailable, gitExec, gitMust } from './git-runner'
import { requireDataRoot } from './paths'
import { getDb, nowIso } from './store'
import { broadcastThreads, getTaskThread, type TaskExecBase } from './task-threads'
import {
  decideFinalize,
  decideMode,
  gitIdentityArgs,
  leftoverRef,
  taskBranchName,
  worktreeDirName,
  type RepoProbeInput
} from './task-workdir-core'

// 任务会话工作目录绑定——编排层(2026-11-10 第一批「安全地基」):
// 显式绑定(授权卡)→ 模式判定持久 → worktree 状态机(prepare/verify 幂等)→ 回合收尾 finalize
// (自动提交/带序号快照)→ 可等待收尾清理 → 启动恢复扫描。
// 隔离口径 = 默认隔离:文件工具硬拒绝工作树外写入;shell 残余面靠审批档位兜底(§1,勿升格)。
// 仓库锁 = 进程内 promise 链,键 = 规范化 git common dir(子目录/符号链接/linked worktree 归并同库)。

const LOCK_WAIT_CAP_MS = 60_000
const GIT_OP_TIMEOUT_MS = 30_000
const WORKTREE_ADD_TIMEOUT_MS = 120_000
const FINALIZE_TIMEOUT_MS = 30_000

// ---- 工作树根(P1-a:~/群岛/任务工作区;根不得位于任何 git 仓库内,校验不过回退应用管理根)----

let workdirRootOverride: string | null = null

/** 仅供冒烟/集成测试隔离主目录;生产不得调用 */
export function setWorkdirRootForTests(p: string | null): void {
  workdirRootOverride = p
}

/** 沿目录链向上找 .git;命中即认为「位于某个 git 仓库内部」(粗判定:仓库边界误判的代价只是回退,安全侧) */
function insideGitRepo(dir: string): boolean {
  let cur = path.resolve(dir)
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return true
    const parent = path.dirname(cur)
    if (parent === cur) return false
    cur = parent
  }
  return false
}

/** 应用管理根(回退位):账号数据目录下(登录后才可能走到创建;未登录抛错兜底 tmp) */
function managedFallbackRoot(): string {
  try {
    return path.join(requireDataRoot(), 'task-worktrees')
  } catch {
    return path.join(os.tmpdir(), 'archipelago-task-worktrees')
  }
}

/** 工作树根目录(创建于首次 prepare;不在此预建) */
export function taskWorkdirRoot(): string {
  if (workdirRootOverride) return workdirRootOverride
  const primary = path.join(os.homedir(), '群岛', '任务工作区')
  try {
    if (insideGitRepo(primary)) {
      console.warn('[task-workdir] 工作树根候选位于 git 仓库内,回退应用管理根:', primary)
      return managedFallbackRoot()
    }
    return primary
  } catch {
    return managedFallbackRoot()
  }
}

// ---- 仓库锁(键 = 规范化 git common dir;等待上限 60s,超时=本回合明确失败)----

export class RepoBusyError extends Error {
  constructor() {
    super('仓库正忙(另一任务正在收尾),请稍后重试')
  }
}

const repoLocks = new Map<string, Promise<void>>()

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 取仓库锁:等前驱完成(等待上限 60s);返回释放函数。超时抛 RepoBusyError。
 * 串行不变量(codex 评审 M1):超时的等待者**不释放占位**——占位只在前驱真正结束(或自己
 * 持锁后释放)时结算。若超时即 resolve 占位,后继只等占位便可在前驱仍在运行时取得锁,
 * worktree add 这类长操作期间仓库串行被打破。
 */
async function acquireRepoLock(commonDir: string): Promise<() => void> {
  const prev = repoLocks.get(commonDir) ?? Promise.resolve()
  let release!: () => void
  const entry = new Promise<void>((r) => (release = r))
  repoLocks.set(commonDir, entry)
  try {
    await Promise.race([prev.then(() => undefined), delay(LOCK_WAIT_CAP_MS).then(() => Promise.reject(new RepoBusyError()))])
  } catch (err) {
    // 等锁失败:自己从未持锁,占位改挂到「前驱结束」时结算——后继仍按完整队列排队
    void prev.then(
      () => release(),
      () => release()
    )
    throw err
  }
  let released = false
  return () => {
    if (!released) {
      released = true
      release()
    }
  }
}

// ---- git 身份(§6.1:零共享配置改动——参数注入,不写任何配置文件;纯函数在 core,这里按 bot 取参) ----

function identityArgsOf(bot: Bot): string[] {
  return gitIdentityArgs(bot.name, bot.id)
}

// ---- 仓库探测 ----

export interface RepoProbe {
  dirExists: boolean
  isGitRepo: boolean
  gitAvailable: boolean
  repoHealthy: boolean
  healthReason?: string
  dirty: boolean
  dirtyCount: number
  commonDir: string | null
  baseBranch: string | null
  baseCommit: string | null
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** realpath 规范化(绑定卡与落库口径);失败返回 null(=目录不存在) */
export function normalizeDir(raw: string): string | null {
  try {
    const st = fs.statSync(expandHome(raw.trim()))
    if (!st.isDirectory()) return null
    return fs.realpathSync(expandHome(raw.trim()))
  } catch {
    return null
  }
}

/** 仓库健康与状态探测(fail-closed:git 期望但不可用在这里被 decideMode 翻成阻断) */
export async function probeRepo(dir: string): Promise<RepoProbe> {
  const probe: RepoProbe = {
    dirExists: true,
    isGitRepo: false,
    gitAvailable: gitAvailable(),
    repoHealthy: false,
    dirty: false,
    dirtyCount: 0,
    commonDir: null,
    baseBranch: null,
    baseCommit: null
  }
  if (!probe.gitAvailable) {
    // git 不可用:凭目录链上的 .git 判定「是不是仓库」(含选到仓库子目录的情形,codex 评审 M9);
    // 是仓库 → 阻断(健康/脏不可知);链上全无 .git 才是非 git 目录(直连)
    probe.isGitRepo = insideGitRepo(dir)
    if (probe.isGitRepo) probe.healthReason = '本机 git 不可用'
    return probe
  }
  const gitDir = await gitExec(['rev-parse', '--git-dir'], { cwd: dir, timeoutMs: GIT_OP_TIMEOUT_MS })
  if (!gitDir.ok) {
    // rev-parse 失败要分家(codex 评审 M9):目录或祖先有 .git 却探测失败(dubious ownership/
    // 仓库损坏/权限)是「无法确认仓库状态」→ 按仓库阻断,绝不静默当非 git 直连
    if (insideGitRepo(dir)) {
      probe.isGitRepo = true
      const why = gitDir.stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''
      probe.healthReason = `仓库状态无法确认(${why.slice(0, 120) || 'git 探测失败'})`
      return probe
    }
    probe.isGitRepo = false
    return probe
  }
  probe.isGitRepo = true
  // common dir 归一(worktree/子目录共享对象库的仓库锁键);realpath 相对 git-dir 输出
  const common = await gitExec(['rev-parse', '--git-common-dir'], { cwd: dir, timeoutMs: GIT_OP_TIMEOUT_MS })
  if (common.ok && common.stdout.trim()) {
    probe.commonDir = path.resolve(dir, common.stdout.trim())
  }

  // ---- 健康五查(任一不过即不健康,原因给人话) ----
  const bare = await gitExec(['rev-parse', '--is-bare-repository'], { cwd: dir, timeoutMs: GIT_OP_TIMEOUT_MS })
  if (bare.ok && bare.stdout.trim() === 'true') {
    probe.healthReason = '这是裸仓库(没有检出文件)'
    return probe
  }
  const head = await gitExec(['rev-parse', '--verify', 'HEAD'], { cwd: dir, timeoutMs: GIT_OP_TIMEOUT_MS })
  if (!head.ok) {
    probe.healthReason = '仓库还没有任何提交'
    return probe
  }
  probe.baseCommit = head.stdout.trim()
  const symRef = await gitExec(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: dir, timeoutMs: GIT_OP_TIMEOUT_MS })
  if (!symRef.ok || !symRef.stdout.trim()) {
    probe.healthReason = 'HEAD 处于分离状态(不在任何分支上)'
    return probe
  }
  probe.baseBranch = symRef.stdout.trim()
  // 进行中操作:merge/rebase/cherry-pick(探测 git dir 下的标记文件,common dir 与本 worktree 都查)
  const gitDirAbs = path.resolve(dir, gitDir.stdout.trim())
  const inProgress = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
    .map((m) => path.join(gitDirAbs, m))
    .find((p) => fs.existsSync(p))
  if (inProgress) {
    probe.healthReason = '有未完成的 merge/rebase/cherry-pick 操作'
    return probe
  }
  // 子模块仓库:.git 是文件且指向 modules/ → 阻断(linked worktree 指向 worktrees/,不在此列)
  const dotGit = path.join(dir, '.git')
  try {
    if (fs.statSync(dotGit).isFile()) {
      const content = fs.readFileSync(dotGit, 'utf8').trim()
      if (content.includes('modules/')) {
        probe.healthReason = '这是一个子模块仓库'
        return probe
      }
    }
  } catch {
    // .git 形态特殊(GIT_DIR 环境变量等):跳过子模块判定,后续操作自行成败
  }
  probe.repoHealthy = true

  const status = await gitExec(['status', '--porcelain'], { cwd: dir, timeoutMs: GIT_OP_TIMEOUT_MS })
  if (status.ok) {
    const lines = status.stdout.split('\n').filter(Boolean)
    probe.dirty = lines.length > 0
    probe.dirtyCount = lines.length
  } else {
    // status 失败视为不可判定:按脏处理(fail-closed)
    probe.dirty = true
    probe.dirtyCount = -1
  }
  return probe
}

// ---- 线程行更新小件 ----

function updateThread(id: string, sets: Record<string, unknown>, touch = true): TaskThreadInfo {
  const keys = Object.keys(sets)
  if (keys.length > 0) {
    const sql = `UPDATE task_threads SET ${keys.map((k) => `${k} = ?`).join(', ')}${touch ? ', updated_at = ?' : ''} WHERE id = ?`
    getDb()
      .prepare(sql)
      .run(...keys.map((k) => sets[k]), ...(touch ? [nowIso()] : []), id)
  }
  const fresh = getTaskThread(id)!
  broadcastThreads()
  return fresh
}

// ---- 绑定(三触点共用入口) ----

/** 绑定授权卡等待中的线程(codex 评审 M8):卡的决策落地前,新回合一律挡住——
 *  否则创建任务后趁卡未决先发消息,回合会按 legacy 基点(居民工作区)跑,与岛主选目录的意图相悖 */
const bindingPending = new Set<string>()

export interface BindOutcome {
  ok: boolean
  /** 人话结果(工具回执 / IPC 错误共用;成功也带模式说明) */
  message: string
  mode?: 'worktree' | 'direct'
}

export interface BindOptions {
  /** 岛主显式要求直连(git 异常/脏仓库时的逃生口,须在授权卡上明示) */
  forceDirect?: boolean
  /** approval='merged'=调用方(open_task)已把绑定信息并进自己的卡,这里不再单独弹卡 */
  approval?: 'card' | 'merged'
  /**
   * 已批准的绑定计划(H2,approval='merged' 时必传):卡上批准的是这份计划,绑定时须复核
   * 当前探测结果与之一致(目录与模式都不许变)——审批等待期间仓库状态变化(.git 被移走等)
   * 会把隔离静默降成直连,这里拒绝执行、请岛主重新确认。
   */
  approvedPlan?: { dir: string; mode: 'worktree' | 'direct' }
  signal?: AbortSignal
  turnId?: string
}

/** 绑定授权卡文案(卡面:规范化目录 + 执行模式 + 写入范围;open_task 合卡时线程未建,
 *  branch 传 null=诚实显示「开任务时生成」,不拿预览近似名冒充) */
export function bindCardDetail(dir: string, mode: 'worktree' | 'direct', branch: string | null): string {
  const modeLine =
    mode === 'worktree'
      ? `隔离模式:独立工作树 + ${branch ? `分支 ${branch}` : '专属任务分支(开任务时生成)'},任务改动不落你的原目录`
      : '直连模式:改动直接落在目录里,无隔离'
  return `目录:${dir}\n${modeLine}\n写入范围:任务内文件工具与命令默认在该${mode === 'worktree' ? '工作树' : '目录'}内;${mode === 'worktree' ? '工作树外写入将被拒绝' : '目录外写入需审批'}`
}

/**
 * 绑定预览(不弹卡不落库):open_task 带目录时先把模式与卡面段算出来并进开任务的卡;
 * 真绑定时 bindTaskWorkdir 会再探一次,竞态以绑定结果为准。
 */
export async function previewBind(
  rawDir: string,
  forceDirect: boolean
): Promise<
  | { ok: true; dir: string; mode: 'worktree' | 'direct'; branch: string | null; detail: string }
  | { ok: false; message: string }
> {
  const dir = normalizeDir(rawDir)
  if (!dir) return { ok: false, message: '目录不存在或无法访问。' }
  const probe = await probeRepo(dir)
  const decision = decideMode({
    dirExists: probe.dirExists,
    isGitRepo: probe.isGitRepo,
    gitAvailable: probe.gitAvailable,
    repoHealthy: probe.repoHealthy,
    healthReason: probe.healthReason,
    dirty: probe.dirty,
    dirtyCount: probe.dirtyCount,
    forceDirect
  })
  if (decision.mode === 'block') return { ok: false, message: decision.message }
  // 预览阶段线程未建,不算具体分支名(卡面诚实显示「开任务时生成」)
  const directNote = decision.mode === 'direct' && decision.reason === 'forced' ? '\n说明:岛主显式改选直连' : ''
  return { ok: true, dir, mode: decision.mode, branch: null, detail: bindCardDetail(dir, decision.mode, null) + directNote }
}

/**
 * 显式绑定(创建时选目录 / 头部 chip / set_task_workdir / open_task directory 共用):
 * realpath 规范化 → 探测 + 模式判定(fail-closed)→ 绑定授权卡(无 always)→ 落库持久。
 * 换绑 = 先保护旧现场(快照残留)再新开代次;旧分支保留。
 */
export async function bindTaskWorkdir(bot: Bot, threadId: string, rawDir: string, opts: BindOptions = {}): Promise<BindOutcome> {
  const thread = getTaskThread(threadId)
  if (!thread || thread.status !== 'open') return { ok: false, message: '任务不存在或已结束,绑定没有执行。' }
  const botLive = getBot(bot.id) ?? bot
  // M8:卡的决策落地前挡住该线程的新回合(ensureWorkdirReady 查 bindingPending)
  bindingPending.add(threadId)
  try {
    return await bindTaskWorkdirInner(botLive, thread, rawDir, opts)
  } finally {
    bindingPending.delete(threadId)
  }
}

async function bindTaskWorkdirInner(
  botLive: Bot,
  thread: TaskThreadInfo,
  rawDir: string,
  opts: BindOptions
): Promise<BindOutcome> {
  const threadId = thread.id
  const dir = normalizeDir(rawDir)
  if (!dir) return { ok: false, message: '目录不存在或无法访问,请核对路径后再试。' }
  const probe = await probeRepo(dir)
  const input: RepoProbeInput = {
    dirExists: probe.dirExists,
    isGitRepo: probe.isGitRepo,
    gitAvailable: probe.gitAvailable,
    repoHealthy: probe.repoHealthy,
    healthReason: probe.healthReason,
    dirty: probe.dirty,
    dirtyCount: probe.dirtyCount,
    forceDirect: opts.forceDirect === true
  }
  const decision = decideMode(input)
  if (decision.mode === 'block') return { ok: false, message: decision.message }

  const isWorktree = decision.mode === 'worktree'
  const branch = isWorktree ? taskBranchName(botLive.name, threadId) : null
  const directReason = decision.mode === 'direct' && decision.reason === 'forced' ? '(岛主显式改选直连)' : ''

  // H2:合卡口径必须复核「批准的计划」——审批等待期间目录状态变化(模式降级/换目录)拒绝执行
  if (opts.approvedPlan && (opts.approvedPlan.dir !== dir || opts.approvedPlan.mode !== (isWorktree ? 'worktree' : 'direct'))) {
    return {
      ok: false,
      message: `审批期间目录状态发生了变化(卡上批准的是${opts.approvedPlan.mode === 'worktree' ? '隔离模式' : '直连模式'} ${opts.approvedPlan.dir},现在探测为${isWorktree ? '隔离模式' : '直连模式'} ${dir}),绑定没有执行;请重新发起,岛主在新卡上重新确认。`
    }
  }

  if (opts.approval !== 'merged') {
    const decision2 = await requestApproval(
      botLive,
      {
        toolName: 'bind_task_workdir',
        title: '绑定工作目录',
        detail: bindCardDetail(dir, isWorktree ? 'worktree' : 'direct', branch) + (directReason ? `\n说明:${directReason}` : ''),
        reason: '任务将获得该目录的读写能力,授权一次、任务内生效',
        noAlways: true
      },
      opts.signal,
      opts.turnId,
      threadId
    )
    if (decision2 === 'aborted') return { ok: false, message: '本次回合已停止,工作目录没有绑定。' }
    if (decision2 === 'denied') return { ok: false, message: '岛主没有同意绑定这个工作目录。请与岛主确认目录与模式后再试,不要原样重试。' }
  }

  // 换绑:先保护旧现场(有工作树且就绪 → 快照残留)再新开代次;旧分支保留即记录。
  // M7:幂等早退只对**健康**绑定生效——error 态(如绑定后仓库变脏被拦)同目录重绑是恢复
  // 出口,要走完整流程(保护旧现场 + 新代次),不能一句「无需重复绑定」把岛主堵死
  if (thread.workdirPath) {
    const sameDirSameMode = thread.workdirPath === dir && (isWorktree === Boolean(thread.wtBranch))
    const bindingHealthy = thread.wtBranch ? thread.wtState === 'ready' : true
    if (sameDirSameMode && bindingHealthy) {
      return { ok: true, message: `任务已绑定该目录(${dir}),无需重复绑定。`, mode: isWorktree ? 'worktree' : 'direct' }
    }
    if (thread.wtBranch && thread.wtPath && thread.wtState === 'ready') {
      await protectAndRetireWorktree(botLive, thread)
    }
  }

  const generation = thread.bindingGeneration > 0 || thread.workdirPath ? thread.bindingGeneration + 1 : 0
  updateThread(threadId, {
    workdir_path: dir,
    binding_source: 'explicit',
    binding_generation: generation,
    wt_state: 'none',
    wt_path: null,
    wt_branch: branch,
    wt_base: isWorktree ? probe.baseBranch : null,
    wt_base_commit: isWorktree ? probe.baseCommit : null,
    wt_error: null
  })
  audit(botLive.id, 'task_workdir.bind', { threadId, dir, mode: isWorktree ? 'worktree' : 'direct', branch, base: probe.baseBranch })
  const modeText = isWorktree
    ? `已绑定工作目录:${dir}(隔离模式,分支 ${branch};首个回合开始时创建独立工作树)`
    : `已绑定工作目录:${dir}(直连模式,改动直接落在目录里)${directReason}`
  return { ok: true, message: modeText, mode: isWorktree ? 'worktree' : 'direct' }
}

/** 换绑/收尾共用的「保护旧现场」:残留快照(校验通过)后置 closed;分支与工作树保留 */
async function protectAndRetireWorktree(bot: Bot, thread: TaskThreadInfo): Promise<void> {
  try {
    await runFinalize(bot, thread.id, { quiet: true })
  } catch (err) {
    console.error('[task-workdir] 换绑前保护旧现场失败(分支保留,可手动恢复):', err)
  }
  updateThread(thread.id, { wt_state: 'closed' })
}

// ---- worktree 状态机:prepare / verify ----

function markError(threadId: string, message: string): void {
  updateThread(threadId, { wt_state: 'error', wt_error: message })
  console.error(`[task-workdir] 线程 ${threadId.slice(0, 8)} 执行资源 error: ${message}`)
}

/** 工作树目录候选:<根>/<threadId12>;磁盘已存在即加随机后缀防覆盖(创建时碰撞检测) */
function pickWorktreePath(threadId: string): string {
  const root = taskWorkdirRoot()
  const base = worktreeDirName(threadId)
  let candidate = path.join(root, base)
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `${base}-${randomBytes(2).toString('hex')}`)
  }
  return candidate
}

/**
 * 分支名可用性(P2 查重 + M10 ref 合法性):已存在或 check-ref-format 不合法都换随机后缀
 * 重试一次;再不行放弃(调用方按 error 落库)。合法性校验兜住清洗规则的遗漏形态。
 */
async function freeBranchName(wtRoot: string, wanted: string): Promise<string | null> {
  const unusable = async (b: string): Promise<boolean> => {
    const taken = await gitExec(['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { cwd: wtRoot, timeoutMs: GIT_OP_TIMEOUT_MS })
    if (taken.ok) return true
    const legal = await gitExec(['check-ref-format', `refs/heads/${b}`], { cwd: wtRoot, timeoutMs: GIT_OP_TIMEOUT_MS })
    return !legal.ok
  }
  if (!(await unusable(wanted))) return wanted
  const retry = `${wanted}-${randomBytes(2).toString('hex')}`
  return (await unusable(retry)) ? null : retry
}

/**
 * 首回合 prepare(幂等锚:wt_state=none 才创建):仓库锁内重验健康+干净 → worktree add -b 分支。
 * 分支/目录已存在即状态机异常,按 error 落库不覆盖。
 */
async function prepareWorktree(bot: Bot, thread: TaskThreadInfo): Promise<{ ok: true } | { ok: false; message: string }> {
  const botLive = getBot(bot.id) ?? bot
  updateThread(thread.id, { wt_state: 'preparing', wt_error: null })
  const dir = thread.workdirPath!
  const probe = await probeRepo(dir)
  if (!probe.gitAvailable || !probe.isGitRepo || !probe.repoHealthy || !probe.commonDir) {
    const msg = probe.healthReason ?? '仓库状态异常,暂时无法创建隔离工作树'
    markError(thread.id, `任务无法开始:${msg}。可结束任务,或让岛主换绑工作目录(可改选直连)。`)
    return { ok: false, message: msg }
  }
  if (probe.dirty) {
    const msg = `仓库有 ${probe.dirtyCount} 个未提交改动(绑定后新出现的),请岛主先提交或暂存;这之后我再开始工作。`
    markError(thread.id, `${msg}(工作目录:${dir})`)
    return { ok: false, message: msg }
  }
  let release: () => void
  try {
    release = await acquireRepoLock(probe.commonDir)
  } catch {
    updateThread(thread.id, { wt_state: 'none' })
    return { ok: false, message: '仓库正忙(另一任务正在收尾),请稍后重试。' }
  }
  try {
    const baseCommit = thread.wtBaseCommit ?? probe.baseCommit
    if (!baseCommit || !thread.wtBase) {
      const msg = '基点分支信息缺失,无法创建工作树;请让岛主重新绑定工作目录。'
      markError(thread.id, msg)
      return { ok: false, message: msg }
    }
    const branch = await freeBranchName(dir, thread.wtBranch ?? taskBranchName(botLive.name, thread.id))
    if (!branch) {
      const msg = `任务分支名 ${thread.wtBranch} 已被占用且无法避开,请让岛主重新绑定工作目录。`
      markError(thread.id, msg)
      return { ok: false, message: msg }
    }
    const wtPath = pickWorktreePath(thread.id)
    fs.mkdirSync(path.dirname(wtPath), { recursive: true })
    try {
      await gitMust(['worktree', 'add', '-b', branch, wtPath, baseCommit], {
        cwd: dir,
        timeoutMs: WORKTREE_ADD_TIMEOUT_MS
      })
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      markError(thread.id, `创建独立工作树失败:${why}。可结束任务,或让岛主重新绑定工作目录。`)
      return { ok: false, message: `创建独立工作树失败:${why}` }
    }
    // M5 完成守卫:worktree add 最长 120s,期间线程可能被归档/停止等待超时后清理/换绑——
    // 落 ready 前复核线程仍是本轮 prepare 认领的那个(open+preparing+同代次),不是就回收刚建的现场
    const current = getTaskThread(thread.id)
    if (!current || current.status !== 'open' || current.wtState !== 'preparing' || current.bindingGeneration !== thread.bindingGeneration) {
      console.warn('[task-workdir] prepare 完成时线程已变化,回收刚创建的工作树:', wtPath)
      await gitExec(['worktree', 'remove', '--force', wtPath], { cwd: dir, timeoutMs: WORKTREE_ADD_TIMEOUT_MS }).catch(() => undefined)
      await gitExec(['branch', '-D', branch], { cwd: dir, timeoutMs: GIT_OP_TIMEOUT_MS }).catch(() => undefined)
      return { ok: false, message: '任务状态在创建工作树期间发生了变化,本次没有开始;请重新发送。' }
    }
    updateThread(thread.id, { wt_state: 'ready', wt_path: wtPath, wt_branch: branch, wt_error: null })
    audit(botLive.id, 'task_workdir.prepare', { threadId: thread.id, wtPath, branch, base: thread.wtBase, baseCommit })
    return { ok: true }
  } finally {
    release()
  }
}

/** 就绪态每回合 verify:工作树存在 + 分支存在 + HEAD 在分支上 + 包含基点 commit */
async function verifyWorktree(thread: TaskThreadInfo): Promise<{ ok: true } | { ok: false; message: string }> {
  const wtPath = thread.wtPath
  const branch = thread.wtBranch
  if (!wtPath || !branch) {
    // 执行资源信息缺行(崩溃残留/手改库):如实按坏现场处理,不让 undefined 落进 fs 调用
    return { ok: false, message: '任务工作树信息缺失(路径或分支为空)。可让岛主重新绑定工作目录。' }
  }
  if (!fs.existsSync(wtPath)) {
    const msg = `任务工作树目录已不存在(${wtPath});分支 ${branch} 与其提交仍在仓库里。可让岛主重新绑定工作目录恢复。`
    markError(thread.id, msg)
    return { ok: false, message: msg }
  }
  const head = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wtPath, timeoutMs: GIT_OP_TIMEOUT_MS })
  if (!head.ok || head.stdout.trim() !== branch) {
    const msg = `交付受阻:工作不在任务分支上(HEAD 在 ${head.stdout.trim() || '未知位置'},应在 ${branch})。我不会动这些改动;请如实向岛主汇报,等待岛主处理。`
    markError(thread.id, msg)
    return { ok: false, message: msg }
  }
  const refCheck = await gitExec(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: wtPath, timeoutMs: GIT_OP_TIMEOUT_MS })
  if (!refCheck.ok) {
    const msg = `任务分支 ${branch} 不见了(可能被手动删除);工作树文件仍在 ${wtPath}。请如实向岛主汇报。`
    markError(thread.id, msg)
    return { ok: false, message: msg }
  }
  if (thread.wtBaseCommit) {
    const anc = await gitExec(['merge-base', '--is-ancestor', thread.wtBaseCommit, 'HEAD'], { cwd: wtPath, timeoutMs: GIT_OP_TIMEOUT_MS })
    if (!anc.ok) {
      const msg = '交付受阻:分支历史已越过/丢失起点 commit(发生过 reset/rebase)。我不会动这些改动;请如实向岛主汇报,等待岛主处理。'
      markError(thread.id, msg)
      return { ok: false, message: msg }
    }
  }
  return { ok: true }
}

// ---- 回合收尾 finalize(决策树见 core.decideFinalize) ----

/** 待收尾恢复队列:finalize 超时/中断不重跑模型回合,下次发送或启动时恢复收尾 */
const pendingFinalize = new Set<string>()

interface FinalizeFacts {
  headOnBranch: boolean
  containsBase: boolean
  dirty: boolean
  hasCommits: boolean
}

async function collectFacts(thread: TaskThreadInfo): Promise<FinalizeFacts> {
  const wtPath = thread.wtPath!
  const branch = thread.wtBranch!
  const head = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wtPath, timeoutMs: GIT_OP_TIMEOUT_MS })
  const headOnBranch = head.ok && head.stdout.trim() === branch
  let containsBase = true
  if (thread.wtBaseCommit) {
    const anc = await gitExec(['merge-base', '--is-ancestor', thread.wtBaseCommit, 'HEAD'], { cwd: wtPath, timeoutMs: GIT_OP_TIMEOUT_MS })
    containsBase = anc.ok
  }
  const status = await gitExec(['status', '--porcelain'], { cwd: wtPath, timeoutMs: GIT_OP_TIMEOUT_MS })
  const dirty = !status.ok || status.stdout.trim().length > 0
  const count = await gitExec(['rev-list', '--count', `${thread.wtBaseCommit ?? 'HEAD'}..HEAD`], {
    cwd: wtPath,
    timeoutMs: GIT_OP_TIMEOUT_MS
  })
  const hasCommits = count.ok && Number(count.stdout.trim()) > 0
  return { headOnBranch, containsBase, dirty, hasCommits }
}

/**
 * 用独立临时 index 构造工作树当前全量状态的 tree 对象(不碰真 index;含 untracked 文件)。
 * 快照落 ref 与「残留是否变化」的去重判定共用这同一个事实源(git diff 不看 untracked,不能用它判)。
 */
async function buildWorktreeTree(wtPath: string): Promise<string> {
  const tmpIndex = path.join(os.tmpdir(), `qd-wt-index-${randomUUID()}`)
  try {
    const env = { GIT_INDEX_FILE: tmpIndex }
    await gitMust(['read-tree', 'HEAD'], { cwd: wtPath, env, timeoutMs: GIT_OP_TIMEOUT_MS })
    await gitMust(['add', '-A', '--', '.'], { cwd: wtPath, env, timeoutMs: GIT_OP_TIMEOUT_MS })
    const tree = await gitMust(['write-tree'], { cwd: wtPath, env, timeoutMs: GIT_OP_TIMEOUT_MS })
    return tree.stdout.trim()
  } finally {
    try {
      fs.rmSync(tmpIndex, { force: true })
    } catch {
      /* 临时文件清理失败无碍 */
    }
  }
}

/**
 * 残留快照:临时 index 出 tree → commit 挂在 HEAD 之后,
 * ref=refs/archipelago/<threadId>/leftover-<n>(序号单调递增);写完回读校验,通过才返回 ok。
 * M12:序号**先落库占号再写 ref**——反序会在「ref 已写、序号未记」的崩溃窗口后重用同一序号,
 * 把旧快照 ref 无声覆盖掉;先占号最坏留一个空号,不覆盖任何记录。
 */
async function snapshotLeftover(
  bot: Bot,
  threadId: string,
  wtPath: string,
  seqBase: number,
  tree: string
): Promise<{ ok: boolean; ref?: string; files?: number }> {
  const idArgs = identityArgsOf(bot)
  const commit = await gitMust([...idArgs, 'commit-tree', tree, '-p', 'HEAD', '-m', '任务收尾快照(未提交残留,仅存档不合入)'], {
    cwd: wtPath,
    timeoutMs: GIT_OP_TIMEOUT_MS
  })
  const seq = seqBase + 1
  updateThread(threadId, { leftover_seq: seq }) // 先占号(崩溃只留空号,不留覆盖)
  const ref = leftoverRef(threadId, seq)
  await gitMust(['update-ref', ref, commit.stdout.trim()], { cwd: wtPath, timeoutMs: GIT_OP_TIMEOUT_MS })
  // 回读校验:ref 解析结果与刚写的 commit 一致才算保存成功
  const back = await gitMust(['rev-parse', ref], { cwd: wtPath, timeoutMs: GIT_OP_TIMEOUT_MS })
  if (back.stdout.trim() !== commit.stdout.trim()) {
    return { ok: false }
  }
  const files = await gitExec(['diff', '--name-only', 'HEAD', commit.stdout.trim()], { cwd: wtPath, timeoutMs: GIT_OP_TIMEOUT_MS })
  return { ok: true, ref, files: files.ok ? files.stdout.split('\n').filter(Boolean).length : undefined }
}

/**
 * 退役工作树保护(M6):回合中途换绑后,本回合的工具仍按回合入口捕获的旧基点写旧工作树;
 * 回合末按当前(新)绑定查库的 finalize 看不到它。这里对「回合捕获的旧 worktree」做最终
 * 快照保护:有残留(脏)就存 leftover(序号全局单调,跨仓库不冲突);干净则无事。
 */
async function protectRetiredWorktree(bot: Bot, threadId: string, retiredRoot: string): Promise<void> {
  if (!fs.existsSync(retiredRoot)) return
  try {
    const status = await gitExec(['status', '--porcelain'], { cwd: retiredRoot, timeoutMs: GIT_OP_TIMEOUT_MS })
    if (!status.ok || !status.stdout.trim()) return // 干净:无需保护
    const tree = await buildWorktreeTree(retiredRoot)
    const thread = getTaskThread(threadId)
    const seqBase = thread?.leftoverSeq ?? 0
    const snap = await snapshotLeftover(bot, threadId, retiredRoot, seqBase, tree)
    if (!snap.ok) throw new Error('退役工作树快照回读校验失败')
    audit(bot.id, 'task_workdir.retired-snapshot', { threadId, wtPath: retiredRoot, ref: snap.ref })
  } catch (err) {
    // 保护失败不抛给回合收尾:现场仍在磁盘与旧分支上,如实记录
    console.error('[task-workdir] 退役工作树保护失败(现场保留,可手动恢复):', retiredRoot, err)
  }
}

/** finalize 本体:回合槽 finally 内调用;strayed→error,残留按决策树收存;异常不抛(进恢复队列) */
async function runFinalize(bot: Bot, threadId: string, opts: { quiet?: boolean; capturedBase?: TaskExecBase } = {}): Promise<void> {
  const thread = getTaskThread(threadId)
  if (!thread || !thread.workdirPath) return
  // M6:回合捕获的基点是已退役的旧工作树(与当前绑定不同)→ 先保护旧现场,再走当前绑定的正常收尾
  if (opts.capturedBase?.mode === 'worktree' && opts.capturedBase.root !== thread.wtPath) {
    await protectRetiredWorktree(getBot(bot.id) ?? bot, threadId, opts.capturedBase.root)
  }
  if (!thread.wtBranch || !thread.wtPath) return
  if (thread.wtState !== 'ready' && thread.wtState !== 'finalizing') return
  const botLive = getBot(bot.id) ?? bot
  const probe = await probeRepo(thread.workdirPath)
  if (!probe.commonDir) {
    // 仓库不可达(目录被删等):标 error 如实交代
    markError(threadId, `工作目录无法访问(${thread.workdirPath});任务改动请让岛主检查工作树 ${thread.wtPath}。`)
    return
  }
  let release: () => void
  try {
    release = await acquireRepoLock(probe.commonDir)
  } catch {
    pendingFinalize.add(threadId)
    if (!opts.quiet) console.warn('[task-workdir] finalize 等锁超时,进恢复队列:', threadId)
    return
  }
  updateThread(threadId, { wt_state: 'finalizing' })
  try {
    const facts = await collectFacts(getTaskThread(threadId) ?? thread)
    const decision = decideFinalize(facts)
    if (decision.action === 'strayed') {
      markError(threadId, `${decision.reason}。我不会动这些改动;岛主可到工作树 ${thread.wtPath} 手动检查与处理。`)
      pendingFinalize.delete(threadId)
      return
    }
    if (decision.action === 'auto-commit') {
      // 居民从未提交:未提交残留自动 commit --no-verify 到分支(交付语义:这批改动属于任务)
      await gitMust([...identityArgsOf(botLive), 'add', '-A', '--', '.'], { cwd: thread.wtPath, timeoutMs: GIT_OP_TIMEOUT_MS })
      await gitMust(
        [...identityArgsOf(botLive), 'commit', '--no-verify', '--allow-empty', '-m', '任务改动(回合收尾自动提交)'],
        { cwd: thread.wtPath, timeoutMs: GIT_OP_TIMEOUT_MS }
      )
      audit(botLive.id, 'task_workdir.auto-commit', { threadId })
    } else if (decision.action === 'snapshot') {
      const freshThread = getTaskThread(threadId) ?? thread
      // 残留与上次快照一致就不重复存(每回合 finalize 都会走到这,不查重会堆一串相同 ref);
      // 比对口径=临时 index tree hash(git diff 不含 untracked,判不准)
      const tree = await buildWorktreeTree(freshThread.wtPath!)
      if (freshThread.leftoverSeq > 0) {
        const lastTree = await gitExec(['rev-parse', `${leftoverRef(threadId, freshThread.leftoverSeq)}^{tree}`], {
          cwd: freshThread.wtPath!,
          timeoutMs: GIT_OP_TIMEOUT_MS
        })
        if (lastTree.ok && lastTree.stdout.trim() === tree) {
          updateThread(threadId, { wt_state: 'ready', wt_error: null })
          pendingFinalize.delete(threadId)
          return
        }
      }
      const snap = await snapshotLeftover(botLive, threadId, freshThread.wtPath!, freshThread.leftoverSeq, tree)
      if (!snap.ok) throw new Error('残留快照保存后回读校验失败')
      audit(botLive.id, 'task_workdir.leftover-snapshot', { threadId, ref: snap.ref, files: snap.files })
    }
    updateThread(threadId, { wt_state: 'ready', wt_error: null })
    pendingFinalize.delete(threadId)
  } finally {
    release()
  }
}

/**
 * finalize 外壳(回合收尾/收尾清理调这个;绝不重跑模型回合)。
 * M2:同线程的 finalize 单飞(重入直接复用在跑的 promise,防「上一轮超时未结、下一轮再起一个」
 * 双写同一工作树);回合槽只等它至多 30s——超时后**不取消也不重置状态**(后台继续跑完),
 * 记 pendingFinalize,入口闸会先等在跑的这份收完再放行下一回合。
 */
const finalizeInFlight = new Map<string, Promise<void>>()

export async function finalizeTaskTurn(bot: Bot, threadId: string, opts: { capturedBase?: TaskExecBase } = {}): Promise<void> {
  const running = finalizeInFlight.get(threadId)
  if (running) return running
  const task = runFinalize(bot, threadId, opts).finally(() => finalizeInFlight.delete(threadId))
  finalizeInFlight.set(threadId, task)
  try {
    await Promise.race([task, delay(FINALIZE_TIMEOUT_MS).then(() => Promise.reject(new Error('finalize 超时')))])
  } catch (err) {
    pendingFinalize.add(threadId)
    console.error('[task-workdir] finalize 失败/超时(后台继续,恢复队列已记;入口闸会等它收完):', err)
  }
}

// ---- 恢复屏障(M14):启动恢复与任务回合并发的竞态 ----
// 扫描是 fire-and-forget,排队唤醒/用户消息可能在扫描收敛 preparing/finalizing 残留前先起回合,
// 闸门把残留当异常标 error、扫描随后跳过——可补跑的收尾被取消。屏障=共享同一个 promise,
// 闸门先等屏障再判定;每次挂载(含切账号重挂)重起一轮扫描。

let recoveryBarrier: Promise<void> | null = null

function waitRecovery(): Promise<void> {
  return recoveryBarrier ?? Promise.resolve()
}

export type WorkdirGate =
  | { ok: true; execBase: TaskExecBase | null }
  | { ok: false; message: string }

/**
 * 任务回合的执行资源闸(回合槽内、上下文组装前调用):
 * legacy(未绑定)→ 直通;直连 → 目录在即通过;worktree → none 先补待收尾再 prepare,ready 先 verify。
 * fail-closed:任何不通过本回合明确失败,绝不静默降级。
 */
export async function ensureWorkdirReady(bot: Bot, threadId: string): Promise<WorkdirGate> {
  // M14:先等启动恢复扫描收敛完(幂等,已扫过即刻通过)
  await waitRecovery()
  // M8:绑定授权卡等待中——卡的决策(批准/拒绝)落地前不开回合,防按 legacy 基点抢跑。
  // 必须排在 legacy 判定之前:卡未决时 workdir_path 还是 NULL,晚查会被 legacy 直通放走
  if (bindingPending.has(threadId)) {
    return { ok: false, message: '工作目录绑定正在等岛主确认,稍候再发。' }
  }
  const thread = getTaskThread(threadId)
  if (!thread) return { ok: false, message: '任务不存在' }
  if (!thread.workdirPath) return { ok: true, execBase: null } // legacy:零回归


  // M2:上一回合的 finalize 还在后台跑(回合槽等它超时了)——先等它收完再判定,
  // 否则旧收尾与新回合同时访问同一工作树
  const inFlight = finalizeInFlight.get(threadId)
  if (inFlight) await inFlight.catch(() => undefined)

  if (pendingFinalize.has(threadId)) {
    // 上次收尾没做完:恢复收尾(finalizeInFlight 单飞去重;失败进队列保留)
    await finalizeTaskTurn(bot, threadId).catch(() => undefined)
  }

  if (!thread.wtBranch) {
    // 直连绑定:目录在即通过
    if (!fs.existsSync(thread.workdirPath)) {
      const msg = `绑定的工作目录已不存在:${thread.workdirPath}。请让岛主重新绑定,或结束任务。`
      markError(threadId, msg)
      return { ok: false, message: msg }
    }
    return { ok: true, execBase: { root: thread.workdirPath, mode: 'direct', hardFence: false } }
  }

  if (thread.wtState === 'error') {
    return { ok: false, message: thread.wtError ?? '任务执行资源异常,本轮没有开始。' }
  }
  if (thread.wtState === 'ready') {
    const fresh = getTaskThread(threadId)!
    const v = await verifyWorktree(fresh)
    if (!v.ok) return { ok: false, message: v.message }
    return { ok: true, execBase: { root: fresh.wtPath!, mode: 'worktree', hardFence: true } }
  }
  if (thread.wtState === 'none') {
    const p = await prepareWorktree(bot, thread)
    if (!p.ok) return { ok: false, message: p.message }
    const fresh = getTaskThread(threadId)!
    return { ok: true, execBase: { root: fresh.wtPath!, mode: 'worktree', hardFence: true } }
  }
  if (thread.wtState === 'closed') {
    // 换绑退休/结束流程中断残留:工作树已收尾,重绑或结束是仅有的出口(不再标 error,M13)
    return { ok: false, message: '这个任务的工作树已收尾(提交仍在任务分支上)。请让岛主重新绑定工作目录,或结束任务。' }
  }
  // preparing/finalizing 落到这里的都是异常残留(单进程内不该有;崩溃后由恢复扫描收敛)
  const msg = `任务执行资源状态异常(${thread.wtState});请稍候重试,或让岛主结束任务后重新绑定。`
  markError(threadId, msg)
  return { ok: false, message: msg }
}

// ---- 收尾清理(结束任务;ipc 在停止握手后调用) ----

export interface WorkdirCloseResult {
  /** 工作树是否已移除(false=脏现场保留,路径在 keptPath) */
  removed: boolean
  keptPath: string | null
  branch: string | null
  snapshotRef: string | null
}

/** 工作树移除(仓库锁内、非强制):成功 true;失败(脏/占用)false=保留现场。release/recover 共用 */
async function tryRemoveWorktree(workdirPath: string, wtPath: string): Promise<boolean> {
  try {
    const probe = await probeRepo(workdirPath)
    if (!probe.commonDir) return false
    const release = await acquireRepoLock(probe.commonDir).catch(() => null)
    if (!release) return false
    try {
      const r = await gitExec(['worktree', 'remove', wtPath], { cwd: workdirPath, timeoutMs: WORKTREE_ADD_TIMEOUT_MS })
      if (!r.ok) {
        console.warn(`[task-workdir] 工作树保留(移除非强制,脏现场默认保留):${wtPath} —— ${r.stderr.trim().slice(0, 200)}`)
      }
      return r.ok
    } finally {
      release()
    }
  } catch (err) {
    console.error('[task-workdir] 工作树移除失败(保留现场):', err)
    return false
  }
}

/**
 * 结束任务的工作树收尾:先 finalize 保护(残留快照校验通过才许清理)→ git worktree remove(不带 force:
 * 脏工作树默认保留,禁止强制删除兜底)→ 分支一律保留(P6-a,删除须岛主明说+审批=第二批)。
 * H4:error 态或 HEAD 不在任务分支上的工作树**不自动移除**——detached HEAD 上的游离提交可能只
 * 在这个工作树可达,移除即失引用;现场保留交岛主。
 */
export async function releaseTaskWorkdir(botId: string, threadId: string): Promise<WorkdirCloseResult> {
  const thread = getTaskThread(threadId)
  if (!thread || !thread.workdirPath || !thread.wtBranch || !thread.wtPath) {
    return { removed: false, keptPath: null, branch: thread?.wtBranch ?? null, snapshotRef: null }
  }
  const bot = getBot(botId)
  if (!bot) return { removed: false, keptPath: thread.wtPath, branch: thread.wtBranch, snapshotRef: null }
  // 先 finalize(残留保护;runFinalize 只认 ready/finalizing 态)再置 closing——顺序反了
  // 会让 finalize 被状态机跳过、脏改动失去快照保护
  await finalizeTaskTurn(bot, threadId).catch(() => undefined)
  updateThread(threadId, { wt_state: 'closing' })
  const fresh = getTaskThread(threadId) ?? thread
  let snapshotRef: string | null = null
  if (fresh.leftoverSeq > 0) snapshotRef = leftoverRef(threadId, fresh.leftoverSeq)

  let removed = false
  let keepReason: string | null = null
  if (fresh.wtState === 'error' || fresh.wtError) {
    keepReason = `任务执行资源异常,现场保留:${fresh.wtPath}(${fresh.wtError ?? '异常'};分支 ${fresh.wtBranch} 的提交都在)`
  } else {
    // H4:HEAD 不在任务分支上 → 游离提交可能只在此工作树可达,不移除
    const head = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: fresh.wtPath!, timeoutMs: GIT_OP_TIMEOUT_MS })
    if (!head.ok || head.stdout.trim() !== fresh.wtBranch) {
      keepReason = `HEAD 已不在任务分支上(在 ${head.stdout.trim() || '未知位置'}),现场保留:${fresh.wtPath}(分支 ${fresh.wtBranch} 的提交都在)`
    }
  }
  if (!keepReason) {
    removed = await tryRemoveWorktree(fresh.workdirPath!, fresh.wtPath!)
    if (!removed) keepReason = `工作树已保留:${fresh.wtPath}(分支 ${fresh.wtBranch} 的提交都在)`
  }
  updateThread(threadId, { wt_state: 'closed', wt_error: removed ? null : keepReason })
  audit(botId, 'task_workdir.close', { threadId, removed, branch: fresh.wtBranch, snapshotRef, keepReason: removed ? null : keepReason })
  return { removed, keptPath: removed ? null : fresh.wtPath, branch: fresh.wtBranch, snapshotRef }
}

// ---- 启动恢复扫描(挂载账号库后调用) ----

/**
 * 三方核对(task_threads / git worktree 注册表 / 磁盘目录):
 * - preparing 残留:创建完整→ready,否则回 none(下回合重备)
 * - ready/finalizing:verify,坏的标 error;finalizing 补跑 finalize
 * - closing(结束流程中途崩,M13):补完非强制移除后收敛 closed;归档仍归岛主/IPC
 * - 磁盘上归属不明的目录只报告不删(可能是仍开放任务的现场)
 * 返回值=恢复屏障(M14):ensureWorkdirReady 在判定前等它,防「扫描未收敛、回合先把残留标 error」。
 */
export function recoverTaskWorkdirs(): Promise<void> {
  pendingFinalize.clear()
  recoveryBarrier = runRecoveryScan().catch((err) => {
    console.error('[task-workdir] 恢复扫描失败(下次挂载再来):', err)
  })
  return recoveryBarrier
}

async function runRecoveryScan(): Promise<void> {
  const threads = getDb()
    .prepare("SELECT * FROM task_threads WHERE status = 'open' AND workdir_path IS NOT NULL")
    .all() as { id: string; wt_state: string | null; wt_path: string | null; wt_branch: string | null }[]
  for (const row of threads) {
    const thread = getTaskThread(row.id)
    if (!thread) continue
    try {
      if (thread.wtBranch && thread.wtPath) {
        if (thread.wtState === 'preparing') {
          // 崩溃残留:工作树创建完整→收敛 ready;否则回 none 待重备
          const complete = fs.existsSync(thread.wtPath) && (await verifyWorktree(thread)).ok
          updateThread(thread.id, { wt_state: complete ? 'ready' : 'none' })
          if (!complete) {
            // 半创建的 worktree 注册项清掉,防 worktree add 撞「already registered」
            await gitExec(['worktree', 'prune'], { cwd: thread.workdirPath!, timeoutMs: GIT_OP_TIMEOUT_MS }).catch(() => undefined)
          }
        } else if (thread.wtState === 'finalizing') {
          const bot = getBot(thread.botId)
          if (bot) await finalizeTaskTurn(bot, thread.id)
        } else if (thread.wtState === 'ready') {
          await verifyWorktree(thread).catch(() => undefined)
        } else if (thread.wtState === 'closing') {
          // M13:结束流程中途崩溃——补完非强制移除(同 release 口径:失败=保留),收敛 closed
          await tryRemoveWorktree(thread.workdirPath!, thread.wtPath)
          updateThread(thread.id, { wt_state: 'closed' })
        }
      } else if (thread.wtState === 'preparing') {
        // preparing 但连 wt_path 都没落(创建前崩):直接回 none 待重备
        updateThread(thread.id, { wt_state: 'none' })
        await gitExec(['worktree', 'prune'], { cwd: thread.workdirPath!, timeoutMs: GIT_OP_TIMEOUT_MS }).catch(() => undefined)
      } else if (!thread.wtBranch && thread.workdirPath && !fs.existsSync(thread.workdirPath)) {
        markError(thread.id, `绑定的工作目录已不存在:${thread.workdirPath}`)
      }
    } catch (err) {
      console.error('[task-workdir] 恢复扫描单线程失败(跳过):', err)
    }
  }
  // 归属不明的目录只报告(开放线程的 wt_path 集合之外的都是)
  const root = taskWorkdirRoot()
  try {
    if (fs.existsSync(root)) {
      const owned = new Set(threads.map((t) => t.wt_path).filter(Boolean) as string[])
      const all = getDb().prepare('SELECT wt_path FROM task_threads WHERE wt_path IS NOT NULL').all() as { wt_path: string }[]
      for (const a of all) owned.add(a.wt_path)
      for (const name of fs.readdirSync(root)) {
        const p = path.join(root, name)
        if (!owned.has(p)) console.warn(`[task-workdir] 任务工作区里存在归属不明的目录(只报告不删):${p}`)
      }
    }
  } catch {
    /* 根不可读:跳过报告 */
  }
}
