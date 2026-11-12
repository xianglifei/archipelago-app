// 任务会话工作目录绑定——纯逻辑层单测(2026-11-10 第一批):
// 分支名清洗/任务分支名/模式判定矩阵(fail-closed)/finalize 决策树/状态机迁移/
// git 身份注入/brief 契约文案/恢复快照 ref 命名。零 IO,与生产同源。
import { describe, expect, it } from 'vitest'
import {
  canTransition,
  decideFinalize,
  decideMode,
  directBrief,
  gitIdentityArgs,
  gitIdentityEnv,
  leftoverRef,
  sanitizeBranchSegment,
  taskBranchName,
  worktreeBrief,
  worktreeDirName,
  type RepoProbeInput
} from '../../src/main/task-workdir-core'

// 判定结果断言助手(expect().toBe 不做类型收窄,访问 reason/message 前先窄化)
const asBlock = (r: ReturnType<typeof decideMode>): Extract<ReturnType<typeof decideMode>, { mode: 'block' }> => {
  if (r.mode !== 'block') throw new Error(`expected block, got ${r.mode}`)
  return r
}
const asDirect = (r: ReturnType<typeof decideMode>): Extract<ReturnType<typeof decideMode>, { mode: 'direct' }> => {
  if (r.mode !== 'direct') throw new Error(`expected direct, got ${r.mode}`)
  return r
}

// 模式判定矩阵的探测定数
const healthyClean = (over: Partial<RepoProbeInput> = {}): RepoProbeInput => ({
  dirExists: true,
  isGitRepo: true,
  gitAvailable: true,
  repoHealthy: true,
  dirty: false,
  dirtyCount: 0,
  forceDirect: false,
  ...over
})

describe('分支名清洗(P2-a:task/<名>/<id6>)', () => {
  it('去掉 ref 保留字符/空白/路径分隔,保留中文', () => {
    expect(sanitizeBranchSegment('Momo')).toBe('Momo')
    expect(sanitizeBranchSegment('小 满')).toBe('小满')
    expect(sanitizeBranchSegment('a/b\\c:d*e?f~g^h[i]j{k}l')).toBe('abcdefghijkl')
  })
  it('.. 折叠、首尾 -/. 修剪、截 24', () => {
    expect(sanitizeBranchSegment('a..b')).toBe('ab')
    expect(sanitizeBranchSegment('-x.')).toBe('x')
    expect(sanitizeBranchSegment('.hidden')).toBe('hidden')
    expect(sanitizeBranchSegment('x'.repeat(40))).toHaveLength(24)
  })
  it('.lock 结尾被剥(git 禁止 ref 段以 .lock 结尾,codex M10)', () => {
    expect(sanitizeBranchSegment('Kai.lock')).toBe('Kai')
    expect(sanitizeBranchSegment('小满.LOCK')).toBe('小满')
    expect(sanitizeBranchSegment('x.lock.lock')).toBe('x')
  })
  it('清洗后为空回退 id6(taskBranchName 口径)', () => {
    const threadId = '1a2b3c4d-aaaa-bbbb-cccc-dddddddddddd'
    expect(taskBranchName('/', threadId)).toBe(`task/1a2b3c/1a2b3c`)
    expect(taskBranchName('Kai', threadId)).toBe('task/Kai/1a2b3c')
  })
  it('工作树目录名 = threadId 去连字符前 12 位', () => {
    expect(worktreeDirName('1a2b3c4d-aaaa-bbbb-cccc-dddddddddddd')).toBe('1a2b3c4daaaa')
  })
})

describe('模式判定矩阵(§5,fail-closed)', () => {
  it('健康干净仓库 → worktree', () => {
    expect(decideMode(healthyClean())).toEqual({ mode: 'worktree' })
  })
  it('非 git 目录 → 直连(P4-a)', () => {
    const r = decideMode(healthyClean({ isGitRepo: false }))
    expect(r).toEqual({ mode: 'direct', reason: 'not-git' })
  })
  it('git 仓库 + git 不可用 → 阻断不降级(场景 D);岛主显式改选直连才走直连', () => {
    const blocked = asBlock(decideMode(healthyClean({ gitAvailable: false })))
    expect(blocked.reason).toBe('no-git')
    expect(blocked.message).toContain('git 不可用')
    const forced = asDirect(decideMode(healthyClean({ gitAvailable: false, forceDirect: true })))
    expect(forced.reason).toBe('forced')
  })
  it('仓库异常(detached/无提交/进行中操作/子模块)→ 阻断并列明原因', () => {
    const r = asBlock(decideMode(healthyClean({ repoHealthy: false, healthReason: 'HEAD 处于分离状态(不在任何分支上)' })))
    expect(r.reason).toBe('unhealthy')
    expect(r.message).toContain('分离状态')
  })
  it('脏仓库 → 拒绝并列改动计数(场景 E;显式直连是岛主的出口)', () => {
    const r = asBlock(decideMode(healthyClean({ dirty: true, dirtyCount: 5 })))
    expect(r.reason).toBe('dirty')
    expect(r.message).toContain('5 个未提交改动')
    expect(asDirect(decideMode(healthyClean({ dirty: true, dirtyCount: 5, forceDirect: true }))).reason).toBe('forced')
  })
  it('目录不存在 → 阻断', () => {
    const r = asBlock(decideMode(healthyClean({ dirExists: false })))
    expect(r.reason).toBe('missing-dir')
  })
  it('git 不可用时连 isGitRepo 都只能靠 .git 兜底判定(矩阵仍闭合)', () => {
    // gitAvailable=false + 非 git 目录 → 仍应直连(不是 git 仓库就不需要 git)
    expect(decideMode(healthyClean({ gitAvailable: false, isGitRepo: false }))).toEqual({ mode: 'direct', reason: 'not-git' })
  })
})

describe('finalize 决策树(§6.1)', () => {
  it('HEAD 跑偏/越基点 → strayed(第一批:阻断交付)', () => {
    expect(decideFinalize({ headOnBranch: false, containsBase: true, dirty: false, hasCommits: false })).toEqual({
      action: 'strayed',
      reason: 'HEAD 已不在任务分支上'
    })
    expect(decideFinalize({ headOnBranch: true, containsBase: false, dirty: false, hasCommits: true })).toEqual({
      action: 'strayed',
      reason: '分支历史已越过/丢失起点 commit'
    })
  })
  it('干净 → 无动作(无论有没有新提交)', () => {
    expect(decideFinalize({ headOnBranch: true, containsBase: true, dirty: false, hasCommits: false })).toEqual({ action: 'none' })
    expect(decideFinalize({ headOnBranch: true, containsBase: true, dirty: false, hasCommits: true })).toEqual({ action: 'none' })
  })
  it('脏 + 从未提交 → 自动 commit;脏 + 已提交 → 带序号快照', () => {
    expect(decideFinalize({ headOnBranch: true, containsBase: true, dirty: true, hasCommits: false })).toEqual({ action: 'auto-commit' })
    expect(decideFinalize({ headOnBranch: true, containsBase: true, dirty: true, hasCommits: true })).toEqual({ action: 'snapshot' })
  })
})

describe('状态机迁移(§5)', () => {
  it('主干迁移全通过:none→preparing→ready⇄finalizing→closing→closed', () => {
    expect(canTransition('none', 'preparing')).toBe(true)
    expect(canTransition('preparing', 'ready')).toBe(true)
    expect(canTransition('ready', 'finalizing')).toBe(true)
    expect(canTransition('finalizing', 'ready')).toBe(true)
    expect(canTransition('ready', 'closing')).toBe(true)
    expect(canTransition('closing', 'closed')).toBe(true)
  })
  it('error 从工作态进入;error/none 互达(修复后重绑);非法迁移被拒', () => {
    expect(canTransition('preparing', 'error')).toBe(true)
    expect(canTransition('ready', 'error')).toBe(true)
    expect(canTransition('error', 'none')).toBe(true)
    expect(canTransition('none', 'ready')).toBe(false)
    expect(canTransition('ready', 'closed')).toBe(false)
    expect(canTransition('closed', 'ready')).toBe(false)
  })
})

describe('git 身份(§6.1:参数/环境注入,零配置改动)', () => {
  it('-c 参数与 shell env 同源同值', () => {
    expect(gitIdentityArgs('Kai', '1a2b3c4d-aaaa-bbbb-cccc-dddddddddddd')).toEqual([
      '-c',
      'user.name=Kai(群岛)',
      '-c',
      'user.email=resident-1a2b3c@archipelago.local'
    ])
    expect(gitIdentityEnv('Kai', '1a2b3c4d-aaaa-bbbb-cccc-dddddddddddd')).toEqual({
      GIT_AUTHOR_NAME: 'Kai(群岛)',
      GIT_AUTHOR_EMAIL: 'resident-1a2b3c@archipelago.local',
      GIT_COMMITTER_NAME: 'Kai(群岛)',
      GIT_COMMITTER_EMAIL: 'resident-1a2b3c@archipelago.local'
    })
  })
})

describe('brief 契约文案与快照 ref', () => {
  it('worktree brief 含分支/起点/禁改约定/收尾汇报/岛主目录不自动同步', () => {
    const b = worktreeBrief('task/Kai/1a2b3c', 'abcdef1234567890', '/tmp/wt')
    expect(b).toContain('task/Kai/1a2b3c')
    expect(b).toContain('abcdef123456')
    expect(b).toContain('不要 squash/amend/rebase/reset 越过起点')
    expect(b).toContain('不要切换分支或进 detached HEAD')
    expect(b).toContain('岛主目录后续的新改动不会自动进入你的工作树')
  })
  it('direct brief 明示无隔离', () => {
    expect(directBrief('/tmp/docs')).toContain('直连模式')
    expect(directBrief('/tmp/docs')).toContain('无隔离')
  })
  it('恢复快照 ref 带线程 id 与单调序号', () => {
    expect(leftoverRef('tid-1', 3)).toBe('refs/archipelago/tid-1/leftover-3')
  })
})
