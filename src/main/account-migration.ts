// 存量认领迁移(0.8 登录门):把 0.7.x 及以前平铺在 userData 根的岛数据,
// 迁入 accounts/<account_id>/ 账号目录。纯 node 模块(不 import electron),可独立演练。
//
// 崩溃安全采用「复制-改写-标记-删源」四段式:
//   1. 备份:根数据完整复制到 backups/pre-account-<ts>/(安全副本,兼演练凭据)
//   2. 复制:各项复制进账号目录(源不动)
//   3. 改写:账号目录库内的绝对路径前缀重写到新位置;全部成功才写 claim.done
//   4. 删源:删除根上的原项
// 中断恢复(resumeInterruptedMigration):
//   - 账号目录有 .migrating 无 claim.done → 半成品,整个删掉重来(根数据未动过,权威源)
//   - 有 claim.done 但根上仍有旧项 → 第 4 步被中断,补删即幂等完成。
//     只删修改时间早于 claim.done 的项;更晚的是迁完后又跑过旧版(降级/DMG 直启)产生的
//     新数据,挪进 backups/stray-legacy-* 保命,绝不静默清除。

import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'

const LEGACY_ITEMS = [
  'archipelago.db',
  'archipelago.db-wal',
  'archipelago.db-shm',
  'memory',
  'workspaces',
  'secrets.json'
] as const

function existingLegacyItems(root: string): string[] {
  return LEGACY_ITEMS.filter((name) => fs.existsSync(path.join(root, name)))
}

/** 根目录是否存在未认领的平铺旧数据(以主库文件为准) */
export function legacyDataExists(root: string): boolean {
  return fs.existsSync(path.join(root, 'archipelago.db'))
}

/** 读旧库的岛信息(只读,用于认领卡展示);读不出给兜底值 */
export function readLegacyIslandInfo(root: string): { name: string; ownerName: string; botCount: number; lastUsedAt: string | null } {
  try {
    const db = new Database(path.join(root, 'archipelago.db'), { readonly: true })
    try {
      const space = db.prepare("SELECT value FROM meta WHERE key = 'space'").get() as { value: string } | undefined
      const parsed = space ? (JSON.parse(space.value) as { name?: string; ownerName?: string }) : {}
      const botCount = (
        db.prepare('SELECT COUNT(*) AS c FROM bots WHERE deleted_at IS NULL').get() as { c: number }
      ).c
      const lastUsedAt = (
        db
          .prepare(
            'SELECT MAX(created_at) AS m FROM (SELECT MAX(created_at) AS created_at FROM messages UNION ALL SELECT MAX(created_at) FROM group_messages)'
          )
          .get() as { m: string | null }
      ).m
      return { name: parsed.name?.trim() || '未命名岛', ownerName: parsed.ownerName?.trim() || '岛主', botCount, lastUsedAt }
    } finally {
      db.close()
    }
  } catch {
    return { name: '未命名岛', ownerName: '岛主', botCount: 0, lastUsedAt: null }
  }
}

/** 库内以旧根为前缀的绝对路径改写到新根(bots.workspace_path 等) */
function rewriteAbsolutePaths(dbPath: string, fromRoot: string, toRoot: string): void {
  const db = new Database(dbPath)
  try {
    const rows = db
      .prepare("SELECT id, workspace_path FROM bots WHERE workspace_path IS NOT NULL AND workspace_path LIKE ?")
      .all(`${fromRoot}${path.sep}%`) as { id: string; workspace_path: string }[]
    const update = db.prepare('UPDATE bots SET workspace_path = ? WHERE id = ?')
    for (const row of rows) {
      const next = path.join(toRoot, row.workspace_path.slice(fromRoot.length + 1))
      update.run(next, row.id)
    }
  } finally {
    db.close()
  }
}

/** 中断恢复:开机时调用;把半迁移状态收敛到确定态 */
export function resumeInterruptedMigration(root: string): void {
  const accounts = path.join(root, 'accounts')
  if (!fs.existsSync(accounts)) return
  for (const entry of fs.readdirSync(accounts, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(accounts, entry.name)
    const done = fs.existsSync(path.join(dir, 'claim.done'))
    const migrating = fs.existsSync(path.join(dir, '.migrating'))
    if (!done && migrating) {
      // 半成品:根数据未被破坏(权威源),整个丢弃重来
      fs.rmSync(dir, { recursive: true, force: true })
      continue
    }
    if (done) {
      // 第 4 步(删源)可能被中断:幂等补删。只认领完成标记之前落盘的项;
      // 更晚出现的平铺数据是迁完又跑过旧版产生的新数据,挪备份不清除,防降级场景静默丢数据
      const doneAt = fs.statSync(path.join(dir, 'claim.done')).mtimeMs
      const strays: string[] = []
      for (const name of existingLegacyItems(root)) {
        const item = path.join(root, name)
        if (fs.statSync(item).mtimeMs > doneAt) {
          strays.push(name)
          continue
        }
        // current.json / logs 等机器级文件不在 LEGACY_ITEMS 里,不会误删
        fs.rmSync(item, { recursive: true, force: true })
      }
      if (strays.length > 0) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const strayDir = path.join(root, 'backups', `stray-legacy-${stamp}`)
        fs.mkdirSync(strayDir, { recursive: true })
        for (const name of strays) {
          try {
            fs.renameSync(path.join(root, name), path.join(strayDir, name))
          } catch (err) {
            console.error(`[migration] 迁移后又出现新数据,挪备份失败(留待下次启动重试):${name}`, err)
          }
        }
      }
    }
  }
}

/**
 * 执行认领迁移:根平铺数据 → accounts/<accountId>/
 * 前置:账号目录不存在;根上存在旧数据。调用方负责后续挂载与登录态落盘。
 */
export function migrateLegacyToAccount(root: string, accountId: string): void {
  if (!legacyDataExists(root)) throw new Error('根目录没有可认领的旧数据')
  const accountPath = path.join(root, 'accounts', accountId)
  if (fs.existsSync(accountPath)) throw new Error('账号目录已存在,不可重复认领')

  // 1. 备份(安全副本)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(root, 'backups', `pre-account-${stamp}`)
  fs.mkdirSync(backupDir, { recursive: true })
  for (const name of existingLegacyItems(root)) {
    fs.cpSync(path.join(root, name), path.join(backupDir, name), { recursive: true })
  }

  // 2. 复制进账号目录(源不动),写进行中标记
  fs.mkdirSync(accountPath, { recursive: true })
  fs.writeFileSync(path.join(accountPath, '.migrating'), String(Date.now()))
  for (const name of existingLegacyItems(root)) {
    fs.cpSync(path.join(root, name), path.join(accountPath, name), { recursive: true })
  }

  // 3. 改写库内绝对路径前缀;成功后落完成标记
  const dbPath = path.join(accountPath, 'archipelago.db')
  if (fs.existsSync(dbPath)) {
    rewriteAbsolutePaths(dbPath, root, accountPath)
  }
  fs.writeFileSync(path.join(accountPath, 'claim.done'), String(Date.now()))
  fs.rmSync(path.join(accountPath, '.migrating'), { force: true })

  // 4. 删源(根上旧数据清场;旧版根级 sea-session.json 一并清掉)
  for (const name of existingLegacyItems(root)) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true })
  }
  const legacySession = path.join(root, 'sea-session.json')
  if (fs.existsSync(legacySession)) fs.rmSync(legacySession, { force: true })
}
