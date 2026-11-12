// 任务会话工作目录绑定——纯逻辑层(2026-11-10 第一批):分支名清洗、模式判定矩阵、
// 执行资源状态机、brief 契约文案。零 electron/零 IO,单测与生产同源(先例:shell-classify-core)。

/** 任务回合的执行基点(ExecutionContext 的 fs/shell 投影,2026-11-10 第一批):
 *  root=相对路径基点与围栏根;hardFence=worktree 模式「工作树外写入硬拒绝」 */
export interface TaskExecBase {
  root: string
  mode: 'worktree' | 'direct'
  hardFence: boolean
}

/** 执行资源状态机(§5):none→preparing→ready⇄finalizing→closing→closed;任何态可落 error(人话原因落库) */
export type WtState = 'none' | 'preparing' | 'ready' | 'finalizing' | 'closing' | 'closed' | 'error'

export const WT_STATES: readonly WtState[] = ['none', 'preparing', 'ready', 'finalizing', 'closing', 'closed', 'error']

/** 绑定来源:第一批只有 explicit;detected(文件夹附件/路径引用)与 inherited(居民工作区默认)留给第三批 */
export type BindingSource = 'explicit' | 'detected' | 'inherited'

/** 状态机合法迁移表(单测的断言依据;error 可从 preparing/ready/finalizing/closing 进入) */
const TRANSITIONS: Record<WtState, WtState[]> = {
  none: ['preparing', 'closed'],
  preparing: ['ready', 'error', 'none'],
  ready: ['finalizing', 'closing', 'error'],
  finalizing: ['ready', 'error'],
  closing: ['closed', 'error'],
  closed: ['none'],
  error: ['none']
}

/** 换绑 = closed→none(重开代次)或 error→none(修复后重绑);single-step 校验供落库守卫 */
export function canTransition(from: WtState, to: WtState): boolean {
  return TRANSITIONS[from].includes(to)
}

// ---- 分支命名(P2-a:task/<居民名 sanitized>/<id6>,人读得懂;清洗后为空回退 id6)----

/** 居民名 → 分支段:去 git ref 不允许的字符与路径敏感形态,压空白,截 24 */
export function sanitizeBranchSegment(name: string): string {
  // eslint-disable-next-line no-control-regex -- 控制符本就是要清洗的目标(\u0000-\u001f/\u007f)
  const bad = new RegExp('[\\s\\u0000-\\u001f\\u007f~^:?*{}[\\\\\\]\\/]', 'g')
  const s = name
    .replace(bad, '') // 空白/控制符/ref 保留字符/路径分隔(转义写法见上,防字符类里的 / 截断正则字面量)
    .replace(/\.\.+/g, '') // .. 触发 reflog 路径歧义
    .replace(/[@{]/g, '') // @{...} reflog 语法
    .replace(/^[-.]+/, '') // 不许以 -/. 开头(会被当选项/相对路径)
    .replace(/[-.]+$/, '') // 不许以 . 结尾(lock 文件惯例)
    .replace(/(\.lock)+$/i, '') // git 禁止 ref 路径段以 .lock 结尾(codex M10;重复后缀一次剥尽)
    .replace(/[-.]+$/, '') // 去 .lock 后可能又露出尾部点杠,再收一遍
    .slice(0, 24)
  return s
}

/** 任务分支全名:task/<safe>/<id6>(threadId 去连字符取前 6 位,与默认工作区命名同口径) */
export function taskBranchName(residentName: string, threadId: string): string {
  const id6 = threadId.replace(/-/g, '').slice(0, 6)
  const safe = sanitizeBranchSegment(residentName)
  return `task/${safe || id6}/${id6}`
}

/** 工作树目录名:threadId 前 12 位(碰撞检测在编排层做,这里只出名字) */
export function worktreeDirName(threadId: string): string {
  return threadId.replace(/-/g, '').slice(0, 12)
}

// ---- 模式判定(§5 降级矩阵,fail-closed:git 期望但不可用 = 阻断,不是降级)----

export interface RepoProbeInput {
  /** 目录存在且可 stat */
  dirExists: boolean
  /** 目录是 git 仓库(有 .git 或 rev-parse --git-dir 成功) */
  isGitRepo: boolean
  /** 本机 git 可执行可用 */
  gitAvailable: boolean
  /** 仓库健康(有提交/非 bare/基点分支存在且非 detached/无进行中操作/非 submodule) */
  repoHealthy: boolean
  /** 健康检查的人话失败原因(repoHealthy=false 时给全) */
  healthReason?: string
  /** 工作树脏(git status --porcelain 非空) */
  dirty: boolean
  /** 脏文件计数(dirty 时展示用) */
  dirtyCount: number
  /** 岛主显式要求直连(绑定授权卡/工具参数来的逃生口,git 异常时才生效) */
  forceDirect: boolean
}

export type ModeDecision =
  | { mode: 'worktree' }
  | { mode: 'direct'; reason: 'not-git' | 'forced' }
  | { mode: 'block'; reason: 'missing-dir' | 'no-git' | 'unhealthy' | 'dirty'; message: string }

/** 模式判定矩阵(纯函数;绑定生效时一次性判定并随绑定持久) */
export function decideMode(input: RepoProbeInput): ModeDecision {
  if (!input.dirExists) {
    return { mode: 'block', reason: 'missing-dir', message: '目录不存在或无法访问,请核对路径后再试。' }
  }
  if (!input.isGitRepo) {
    // 非 git 目录 → 直连(P4-a:写文档/做设计的岛主同样受益;授权卡明示无隔离)
    return { mode: 'direct', reason: 'not-git' }
  }
  // 下面全是 git 仓库
  if (input.forceDirect) {
    // 岛主显式改选直连(git 缺失/仓库异常时的出口;脏仓库直连=岛主自己的仓库自己拍板)
    return { mode: 'direct', reason: 'forced' }
  }
  if (!input.gitAvailable) {
    return {
      mode: 'block',
      reason: 'no-git',
      message: '本机 git 不可用,无法启用隔离;可安装 git,或改选直连模式。'
    }
  }
  if (!input.repoHealthy) {
    return {
      mode: 'block',
      reason: 'unhealthy',
      message: `仓库暂时不能开隔离任务:${input.healthReason ?? '仓库状态异常'}。可先处理后再开,或改选直连模式。`
    }
  }
  if (input.dirty) {
    return {
      mode: 'block',
      reason: 'dirty',
      message: `仓库有 ${input.dirtyCount} 个未提交改动,请先提交或暂存再开任务(隔离任务从干净基点出发,你的未提交改动不会也不该混进任务的交付)。`
    }
  }
  return { mode: 'worktree' }
}

// ---- brief 契约文案(注入上下文,同时是 finalize 校验依据的「契约」面)----

/** 分支契约(§6.1):工作目录段+分支契约段,worktree 模式每回合注入 */
export function worktreeBrief(branch: string, baseCommit: string, workRoot: string): string {
  return (
    `[工作目录] 你的工作目录是独立工作树:${workRoot}\n` +
    `[任务分支] 你在分支 ${branch} 上工作,起点 commit ${baseCommit.slice(0, 12)}。所有改动以提交落在这个分支上;` +
    `不要 squash/amend/rebase/reset 越过起点,不要切换分支或进 detached HEAD。工作树之外的一切目录(包括岛主的原目录)不要写。` +
    `收尾用一句话向岛主汇报:改了什么、落在分支哪、要不要合并。岛主目录后续的新改动不会自动进入你的工作树。`
  )
}

/** 直连模式 brief(P4-a):明示无隔离 */
export function directBrief(dir: string): string {
  return (
    `[工作目录] 这个任务直接在目录里工作:${dir}(直连模式,改动直接落在目录里,无隔离)。` +
    `收尾用一句话向岛主汇报改了什么。`
  )
}

// ---- finalize 决策(纯函数形态,编排层据 git 探测结果调用)----

export interface FinalizeSituation {
  /** HEAD 在任务分支上 */
  headOnBranch: boolean
  /** HEAD 包含基点 commit(没 reset 越过起点) */
  containsBase: boolean
  /** 工作树有未提交改动 */
  dirty: boolean
  /** 分支上基点之后已有提交(居民提交过) */
  hasCommits: boolean
}

export type FinalizeAction =
  | { action: 'none' }
  | { action: 'auto-commit' }
  | { action: 'snapshot' }
  | { action: 'strayed'; reason: string }

/**
 * finalize 决策树(§6.1):
 * - HEAD 跑偏/越基点 → 阻断交付标 error(第一批口径;第三批升级修复回合 P3-a)
 * - 干净 → 无动作(「工作树干净且无新提交」与「已提交且干净」都无需处理)
 * - 脏 + 从未提交 → 未提交残留自动 commit --no-verify 到分支
 * - 脏 + 已提交 → 带序号恢复快照 refs/archipelago/<threadId>/leftover-<n>(保存并回读校验成功才许后续清理)
 */
export function decideFinalize(s: FinalizeSituation): FinalizeAction {
  if (!s.headOnBranch) return { action: 'strayed', reason: 'HEAD 已不在任务分支上' }
  if (!s.containsBase) return { action: 'strayed', reason: '分支历史已越过/丢失起点 commit' }
  if (!s.dirty) return { action: 'none' }
  return s.hasCommits ? { action: 'snapshot' } : { action: 'auto-commit' }
}

/** 恢复快照 ref 名(序号单调递增防覆盖) */
export function leftoverRef(threadId: string, seq: number): string {
  return `refs/archipelago/${threadId}/leftover-${seq}`
}

// ---- git 身份(§6.1:零共享配置改动——参数/环境注入,不写任何仓库配置)----

/** 主进程 git 调用的 -c 参数(前缀插入 argv) */
export function gitIdentityArgs(botName: string, botId: string): string[] {
  return ['-c', `user.name=${botName}(群岛)`, '-c', `user.email=resident-${botId6(botId)}@archipelago.local`]
}

/** 居民 spawn 的 shell 环境注入(与主进程 -c 参数同源身份) */
export function gitIdentityEnv(botName: string, botId: string): Record<string, string> {
  const name = `${botName}(群岛)`
  const email = `resident-${botId6(botId)}@archipelago.local`
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
}

function botId6(botId: string): string {
  return botId.replace(/-/g, '').slice(0, 6)
}
