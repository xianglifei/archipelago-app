import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { app } from 'electron'
import type { Bot, SafetyState } from '@shared/types'
import { requestApproval, type ApprovalScope } from './approval'
import { audit } from './audit'
import { metaGet, metaSet } from './store'
import { resolveBotPath } from './fs-tools'
import { gitIdentityEnv, type TaskExecBase } from './task-workdir-core'

// 终端工具(M4.2):run_command——非持久 shell,一次性执行、输出回传
// 安全设计(参考 cindy/dsh,按群岛体量裁剪):
// - 危险命令先过分类器:命中默认/自定义模式或覆盖性重定向到工作区外 → 弹审批卡(§6.2/§6.7)
// - detached 进程组,超时/停止先 SIGTERM 整组、2 秒后 SIGKILL
// - 输出保尾 50KB/2000 行,全量 spill 到 userData/tool-output(0600)
// - 静态分类不可闭合(变量拼接/PATH 污染可绕过,cindy 源码亦自认),兜底 = 审批卡展示完整原命令 + 全量审计
//
// 任务执行基点(2026-11-10):绑定工作目录的任务回合传 base——默认 cwd 与分类器的「工作区」
// 都切到 base.root;shell 经绝对路径越界是「默认隔离」的已知残余面(§1),靠审批档位兜底。
// base 存在时注入居民 git 身份环境变量(§6.1 零共享配置改动)。

const KEY_DANGER_PATTERNS = 'safety.dangerousPatterns'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const OUTPUT_MAX_BYTES = 50 * 1024
const OUTPUT_MAX_LINES = 2000
const OUTPUT_MEMORY_CAP = 16 * 1024 * 1024

// 危险模式清单/归一化/重定向解析/分类纯逻辑已拆至 shell-classify-core.ts(2026-11-04 W1/W2,
// 零 electron 依赖,单测与生产同源);对外 re-export 保持既有 import 路径兼容
import {
  activeDefaultPatterns,
  classifyCommandFor as classifyForCore,
  type ClassifyResult
} from './shell-classify-core'
export {
  DEFAULT_DANGER_PATTERNS,
  WINDOWS_DANGER_PATTERNS,
  activeDefaultPatterns,
  extractRedirectTargets,
  normalizeVariants
} from './shell-classify-core'
export type { ClassifyResult, RedirectTarget } from './shell-classify-core'

export function safetyGet(): SafetyState {
  const custom = metaGet<string[]>(KEY_DANGER_PATTERNS)
  return {
    customPatterns: custom && custom.length > 0 ? custom : null,
    // 对外仍给纯 pattern 数组(why 只用于卡面文案,不进存储格式)
    defaultPatterns: activeDefaultPatterns(process.platform).map((p) => p.pattern)
  }
}

export function safetySetCustom(patterns: string[]): SafetyState {
  const cleaned = patterns.map((p) => p.trim()).filter((p) => p.length > 0)
  metaSet(KEY_DANGER_PATTERNS, cleaned)
  return safetyGet()
}

/** 生产壳:宿主平台 + 用户自定义危险模式,供 runCommandTool 调用 */
export function classifyCommand(command: string, workspace: string, workdir: string): ClassifyResult {
  return classifyForCore(command, workspace, workdir, process.platform, safetyGet().customPatterns)
}


// ---- shell 事实源(2026-11-04 W3 修复) ----
// 工具说明(tools.ts)与实际 spawn 共用同一探测结果:描述说 zsh 就是 zsh,说 PowerShell 就不带 &&。
// 进程内缓存:探测(existsSync×3)只做一次,避免每次 spawn/生成工具说明重复 IO,也保证两边强一致。

export type ShellKind = 'gitbash' | 'powershell' | 'zsh' | 'bash' | 'sh'
export interface ShellInfo {
  kind: ShellKind
  path: string
}

let shellInfoCache: ShellInfo | null = null

export function shellInfo(): ShellInfo {
  if (shellInfoCache) return shellInfoCache
  if (process.platform === 'win32') {
    // Windows(2026-11-03 首版):PowerShell 恒在,别名覆盖 ls/rm/cat 等常见 POSIX 习惯;
    // Git Bash 若装了则优先(POSIX 语义更全),WSL bash 依赖可选功能不假设存在
    const gitBash = [
      process.env['ProgramFiles'] ? `${process.env['ProgramFiles']}\\Git\\bin\\bash.exe` : '',
      process.env['ProgramFiles(x86)'] ? `${process.env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe` : '',
      process.env['LOCALAPPDATA'] ? `${process.env['LOCALAPPDATA']}\\Programs\\Git\\bin\\bash.exe` : ''
    ].find((p) => p && fs.existsSync(p))
    shellInfoCache = gitBash ? { kind: 'gitbash', path: gitBash } : { kind: 'powershell', path: 'powershell.exe' }
    return shellInfoCache
  }
  const envShell = process.env.SHELL ?? ''
  if (/(zsh|bash)$/.test(envShell)) {
    shellInfoCache = { kind: envShell.endsWith('zsh') ? 'zsh' : 'bash', path: envShell }
    return shellInfoCache
  }
  if (fs.existsSync('/bin/zsh')) shellInfoCache = { kind: 'zsh', path: '/bin/zsh' }
  else if (fs.existsSync('/bin/bash')) shellInfoCache = { kind: 'bash', path: '/bin/bash' }
  else shellInfoCache = { kind: 'sh', path: '/bin/sh' }
  return shellInfoCache
}

function pickShell(): string {
  return shellInfo().path
}

/** Windows spawn 参数(PowerShell 单命令语义);mac/POSIX 走 zsh -c */
function shellSpawnArgs(shellPath: string, command: string): string[] {
  if (process.platform === 'win32' && !/bash\.exe$/i.test(shellPath)) {
    return ['-NoProfile', '-NonInteractive', '-Command', command]
  }
  return ['-c', command]
}

function killTree(pid: number): void {
  // Windows 无进程组信号:taskkill /T 连树强杀(无 SIGTERM 优雅期,诚实取舍)
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => {
      // taskkill 不可用(理论不可能):放弃击杀,等进程自然退出
    })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }, 2000).unref()
}

function spillOutput(text: string): string | null {
  try {
    const dir = path.join(app.getPath('userData'), 'tool-output')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `cmd-${Date.now()}-${randomBytes(4).toString('hex')}.log`)
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
    return file
  } catch (err) {
    console.error('[shell] spill 输出失败:', err)
    return null
  }
}

function tailOutput(text: string): string {
  const lines = text.split('\n')
  let body = lines.length > OUTPUT_MAX_LINES ? lines.slice(-OUTPUT_MAX_LINES).join('\n') : text
  if (body.length > OUTPUT_MAX_BYTES) {
    body = body.slice(-OUTPUT_MAX_BYTES)
    const nl = body.indexOf('\n')
    if (nl >= 0) body = body.slice(nl + 1) // 不切半行
  }
  return body
}

export async function runCommandTool(
  bot: Bot,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  scope?: ApprovalScope,
  base?: TaskExecBase
): Promise<string> {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) return '缺少参数:command(要执行的命令)。'

  const workdirInput = String(args.workdir ?? '').trim()
  const workdir = workdirInput ? resolveBotPath(bot, workdirInput, base?.root) : (base?.root ?? bot.workspacePath)
  if (workdirInput) {
    try {
      if (!fs.statSync(workdir).isDirectory()) return `workdir 不是目录:${workdir}`
    } catch {
      return `workdir 不存在:${workdir}`
    }
  } else if (!base) {
    fs.mkdirSync(workdir, { recursive: true }) // 工作区首次使用时落盘;任务基点目录由绑定/prepare 保证存在
  }

  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS))

  const verdict = classifyCommand(command, base?.root ?? bot.workspacePath, workdir)
  if (verdict.verdict === 'ask') {
    // 权限两档(2026-10-27):半自动弹卡等岛主决策;全自动自动审批(直接执行+留痕回执)
    const decision = await requestApproval(
      bot,
      {
        toolName: 'run_command',
        title: '请求执行命令',
        detail: command,
        reason: verdict.reason ?? '命中危险命令规则'
      },
      signal,
      scope?.turnId,
      scope?.threadId
    )
    if (decision === 'aborted') return '本次回合已停止,命令未执行。'
    if (decision === 'denied') {
      audit(bot.id, 'run_command.denied', { command, reason: verdict.reason })
      return `岛主拒绝了这条命令(${verdict.reason})。可以换一种不触碰红线的做法;如果确实需要,请岛主自己执行,不要原样重试。`
    }
  }

  const started = Date.now()
  return await new Promise<string>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      const shellPath = pickShell()
      child = spawn(shellPath, shellSpawnArgs(shellPath, command), {
        cwd: workdir,
        detached: true, // 独立进程组,超时/中止可整组击杀
        windowsHide: true, // Windows 下 detached + 管道 stdio 会闪控制台窗,必须压掉
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
          TERM: 'dumb',
          PAGER: 'cat',
          GIT_PAGER: 'cat',
          // 任务基点(2026-11-10):居民在这个任务里提交的东西署居民自己的群岛身份(零共享配置改动)
          ...(base ? gitIdentityEnv(bot.name, bot.id) : {})
        }
      })
    } catch (err) {
      resolve(`命令启动失败:${err instanceof Error ? err.message : String(err)}`)
      return
    }

    const chunks: string[] = []
    let buffered = 0
    let overflowed = false
    // 流式解码(2026-11-04 W5):per-chunk buf.toString('utf8') 在多字节字符跨 chunk 边界时
    // 产生替换字符(全平台存量 bug);stdout/stderr 各持一个 StringDecoder,流内缓冲半字符,
    // finish 时 end() flush 残留尾字节。编码策略(中文 Windows PS 5.1 的 GBK 输出)另属
    // 真机确认项,不在 Mac 上盲改。
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    const collect = (buf: Buffer, dec: StringDecoder): void => {
      if (buffered >= OUTPUT_MEMORY_CAP) {
        overflowed = true
        return
      }
      buffered += buf.length
      chunks.push(dec.write(buf))
    }
    child.stdout?.on('data', (b: Buffer) => collect(b, outDecoder))
    child.stderr?.on('data', (b: Buffer) => collect(b, errDecoder))

    let timedOut = false
    let aborted = false
    let settled = false
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)

      const elapsed = Date.now() - started
      let text = chunks.join('') + outDecoder.end() + errDecoder.end()
      if (overflowed) text = `${text}\n…[输出超过 16MB,已丢弃多余部分]`
      let note = ''
      if (text.length > OUTPUT_MAX_BYTES || text.split('\n').length > OUTPUT_MAX_LINES) {
        const full = spillOutput(text)
        text = tailOutput(text)
        note = `\n\n[输出过长,此处仅保留末尾${full ? `;完整输出已存:${full}` : ''}]`
      }
      const headers: string[] = []
      if (timedOut) headers.push(`[命令超过 ${Math.round(timeoutMs / 1000)}s,已强制终止]`)
      if (aborted) headers.push('[回合被停止,命令已终止]')
      const body = text.trim() ? text.trimEnd() : '(无输出)'
      const exit = exitCode === null ? 'unknown' : String(exitCode)
      audit(bot.id, 'run_command', {
        command,
        workdir,
        exitCode: exit,
        ms: elapsed,
        timedOut,
        truncated: note !== '' || overflowed
      })
      resolve(`${headers.length ? `${headers.join('')}\n` : ''}${body}${note}\n[exit code: ${exit}]`)
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      if (child.pid) killTree(child.pid)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(`命令执行失败:${err.message}`)
    })
    child.on('close', (code) => finish(code))
  })
}
