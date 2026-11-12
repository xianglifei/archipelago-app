import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb, metaGet, metaSet, nowIso } from './store'
import { requireDataRoot } from './paths'

// 居民默认工作区(需求 2026-10-28 拍板,学 WorkBuddy 路线一):主目录下可见的「群岛」文件夹。
// 产物第一读者是岛主,Finder 必须找得到;主目录根不在 macOS TCC 保护清单(桌面/文稿/下载/iCloud
// 才在),可见与免隐私弹窗兼得。权限语义零关联:半自动档工作区外写入弹卡、全自动档自动放行留痕,
// 都只看 bot.workspacePath 指哪,不看它在不在默认位置。

let visibleRootOverride: string | null = null

/** 工作区可见根(~/群岛);测试可改指到 /tmp 隔离,生产只认主目录 */
export function visibleWorkspaceRoot(): string {
  return visibleRootOverride ?? path.join(os.homedir(), '群岛')
}

/** 仅供冒烟测试隔离主目录用;生产代码不得调用 */
export function setVisibleWorkspaceRootForTests(p: string | null): void {
  visibleRootOverride = p
}

/** 旧默认工作区根(账号数据目录内,0.3~0.9.5 时代的藏身处);迁移范围判定与审计旧路径改写都以它为前缀 */
export function legacyWorkspaceRoot(): string {
  return path.join(requireDataRoot(), 'workspaces')
}

/** 默认工作区路径:~/群岛/<居民名安全化>-<ID 前 6 位>(命名沿用 M4.1 既有规则,同名居民天然不撞) */
export function defaultWorkspacePath(name: string, id: string): string {
  const safe = name.replace(/[/\\:*?"<>|\s]+/g, '').slice(0, 24) || 'resident'
  return path.join(visibleWorkspaceRoot(), `${safe}-${id.slice(0, 6)}`)
}

/** 建目录(递归、幂等);失败只记日志——工作区允许暂不存在,首次写入与「打开」都会兜底补建 */
export function ensureWorkspaceDir(p: string): void {
  try {
    fs.mkdirSync(p, { recursive: true })
  } catch (err) {
    console.error('[workspace] 创建工作区目录失败:', p, err)
  }
}

/** 旧默认根下的路径改写到新根;不在旧根下(用户改指过/新路径)原样返回。纯前缀替换,不探存在性 */
export function remapLegacyWorkspacePath(p: string): string {
  const oldRoot = legacyWorkspaceRoot()
  return p.startsWith(oldRoot + path.sep)
    ? path.join(visibleWorkspaceRoot(), p.slice(oldRoot.length + 1))
    : p
}

/**
 * 存量迁移(一次性,登录挂载账号库后调用):把仍在旧默认根(<dataRoot>/workspaces)下的工作区搬到 ~/群岛。
 * - 范围判定只看前缀:用户改指过真实项目的不在旧根下,天然不动;居民后来改名导致目录名与「按当前名
 *   重算的默认值」不一致的仍在此前缀内,一并搬(目录名保持原名)。
 * - 移动优先 rename(同卷原子);EXDEV 回退递归复制+删源。
 * - 目标已存在:空目录直接换掉;非空视为冲突,该居民跳过、保留原位(绝不碰用户文件)。
 * - 任何异常都只记日志,该居民留在旧位照常可用。
 * - 幂等:账号库 meta KV workspace.migrated.v1,置位即不再跑。
 */
export function migrateLegacyWorkspaces(): void {
  if (metaGet<string>('workspace.migrated.v1')) return
  const oldRoot = legacyWorkspaceRoot()
  const rows = getDb()
    .prepare('SELECT id, workspace_path FROM bots')
    .all() as { id: string; workspace_path: string | null }[]
  for (const row of rows) {
    const p = row.workspace_path?.trim()
    if (!p || !p.startsWith(oldRoot + path.sep)) continue
    const target = remapLegacyWorkspacePath(p)
    try {
      ensureWorkspaceDir(visibleWorkspaceRoot())
      if (fs.existsSync(target)) {
        if (fs.readdirSync(target).length > 0) {
          console.warn('[workspace] 目标已存在非空,跳过迁移保留原位:', target)
          continue
        }
        fs.rmdirSync(target)
      }
      try {
        fs.renameSync(p, target)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        fs.cpSync(p, target, { recursive: true })
        fs.rmSync(p, { recursive: true, force: true })
      }
      getDb()
        .prepare('UPDATE bots SET workspace_path = ?, updated_at = ? WHERE id = ?')
        .run(target, nowIso(), row.id)
    } catch (err) {
      console.error('[workspace] 迁移失败,该居民保留原位:', p, err)
    }
  }
  // 旧根清场:空了就删;非空(有冲突跳过者/用户手放的东西)原样保留
  try {
    if (fs.existsSync(oldRoot) && fs.readdirSync(oldRoot).length === 0) fs.rmdirSync(oldRoot)
  } catch {
    /* 清场失败无碍 */
  }
  try {
    metaSet('workspace.migrated.v1', '1')
  } catch (err) {
    console.error('[workspace] 幂等标记写入失败(下次启动会重跑,跳过逻辑保证安全):', err)
  }
}
