// 账号目录分区(0.8 登录门):userData 根 = 机器级;各账号数据在 accounts/<account_id>/ 下
// dataRoot 在登录成功(或开机凭本地令牌解锁)后才指向具体账号目录;登录屏阶段一切业务库不可用。

import { app } from 'electron'
import path from 'node:path'

let dataRoot: string | null = null

/** 机器级根(userData):logs/tool-output/backups/current.json/accounts 都住这里 */
export function machineRoot(): string {
  return app.getPath('userData')
}

export function accountsRoot(): string {
  return path.join(machineRoot(), 'accounts')
}

export function accountDir(accountId: string): string {
  return path.join(accountsRoot(), accountId)
}

/** 当前解锁账号的标记(机器级);登出即删,这是「锁」的实现 */
export function currentAccountFile(): string {
  return path.join(machineRoot(), 'current.json')
}

export function setDataRoot(dir: string): void {
  dataRoot = dir
}

export function clearDataRoot(): void {
  dataRoot = null
}

export function currentDataRoot(): string | null {
  return dataRoot
}

/** 业务模块取数据根;登录前调用即抛错(防登录屏阶段误触业务库) */
export function requireDataRoot(): string {
  if (!dataRoot) throw new Error('尚未登录,账号数据未挂载')
  return dataRoot
}
