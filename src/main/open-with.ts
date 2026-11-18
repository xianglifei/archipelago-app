import { execFile } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import type { FilesOpenWithFail } from '@shared/types'
import { expandHomePath } from './md-reader'

// 「打开 ▾」指定应用打开(回合改动文件卡,2026-11-18)——从 ipc.ts 拆出的可测模块:
// - 失败只回 reason 码(与 ImageRead 同口径),用户文案由渲染层走词典,主进程不拼中英文案
// - 应用名必须命中本机 /Applications 顶层名单:open -a 也认 .app 路径,
//   不拦的话这条 IPC 等于「按任意路径启动应用」(渲染端名单即白名单,菜单给什么才能开什么)

/** macOS 应用候选:/Applications 顶层 .app 去后缀按名排序;非 darwin 或读不到目录返回空数组 */
export function listMacApps(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'darwin') return []
  try {
    return readdirSync('/Applications')
      .filter((name) => name.endsWith('.app'))
      .map((name) => name.slice(0, -4))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/** openWithApp 的可注入依赖(单测用:平台与名单不依赖真机 darwin 环境) */
export interface OpenWithDeps {
  platform?: NodeJS.Platform
  /** 覆盖应用候选名单;缺省 = listMacApps() 现读 */
  apps?: string[]
}

/**
 * 用指定应用打开文件;resolve('') = 成功,否则为失败原因码(见 FilesOpenWithFail)。
 * 校验全在 exec 之前;open 的真实退出结果经回调异步回传(渲染端 await 得到真结局,不是「发了就算成功」)。
 */
export function openWithApp(rawPath: string, app: string, deps?: OpenWithDeps): Promise<FilesOpenWithFail | ''> {
  const platform = deps?.platform ?? process.platform
  if (platform !== 'darwin') return Promise.resolve('unsupported-platform')
  if (typeof rawPath !== 'string' || !rawPath) return Promise.resolve('bad-path')
  const appName = typeof app === 'string' ? app.trim() : ''
  if (!appName) return Promise.resolve('bad-path')
  const apps = deps?.apps ?? listMacApps(platform)
  if (!apps.includes(appName)) return Promise.resolve('app-not-found')
  const p = expandHomePath(rawPath)
  // 自查存在性:open -a 对不存在的路径常无声失败;ENOENT=真没了,其余 errno=隐私墙类拦截
  try {
    statSync(p)
  } catch (err) {
    return Promise.resolve((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'no-access')
  }
  return new Promise((resolve) => {
    const child = execFile('open', ['-a', appName, p], (err) => {
      resolve(err ? 'open-failed' : '')
    })
    child.on('error', () => undefined) // 回调已兜,防 error 事件无人接变成未处理异常
  })
}
