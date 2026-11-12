import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

// git runner(2026-11-10 任务会话并行开发第一批):主进程专用的 git 调用底座。
// 与 shell.ts 的居民命令通道完全独立——那里探测/执行的是登录 shell(zsh/PowerShell),
// 这里要的是 git 可执行文件本身;参数走数组、shell:false,天然不做任何 shell 展开,
// 路径含空格/中文/前缀伪装(`--flag` 注入)都只是字面参数。
// 非交互铁律:GIT_TERMINAL_PROMPT=0(要凭据即失败,绝不挂起等输入),输出全量回收截上限。

export interface GitResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

export class GitTimeoutError extends Error {
  constructor(ms: number) {
    super(`git 命令超过 ${Math.round(ms / 1000)}s 未完成,已终止`)
  }
}

const GIT_OUTPUT_CAP = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

/** 非交互环境变量(与居民 spawn 环境的 NO_COLOR 族互补,这里只管「绝不交互」) */
function nonInteractiveEnv(env?: Record<string, string>): Record<string, string> {
  return {
    ...(env ?? {}),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    GIT_CONFIG_NOSYSTEM: '1'
  }
}

/** 进程内缓存(探测只在首次做,失败也缓存——探测本身有成本,fail-closed 语义下「不可用」是稳定态) */
let gitPathCache: string | null | undefined

function detectGitPath(): string | null {
  if (gitPathCache !== undefined) return gitPathCache
  gitPathCache = null
  if (process.platform === 'win32') {
    // Windows:git 不在 PATH 时按常见安装位置找(与 shell.ts 探测 Git Bash 同款候选,
    // 但探测对象是 git.exe 本身,装了 MinGit 没 Git Bash 的机器也能找到)
    const candidates = [
      process.env['ProgramFiles'] ? `${process.env['ProgramFiles']}\\Git\\cmd\\git.exe` : '',
      process.env['ProgramFiles(x86)'] ? `${process.env['ProgramFiles(x86)']}\\Git\\cmd\\git.exe` : '',
      process.env['LOCALAPPDATA'] ? `${process.env['LOCALAPPDATA']}\\Programs\\Git\\cmd\\git.exe` : ''
    ].filter(Boolean)
    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        gitPathCache = c
        break
      }
    }
  }
  if (!gitPathCache) {
    // mac/Linux:找 PATH 里的 git(不 spawn `which`,直接按 PATH 分隔逐个 stat,零子进程)
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    const exe = process.platform === 'win32' ? 'git.exe' : 'git'
    for (const d of dirs) {
      const p = path.join(d, exe)
      try {
        const st = fs.statSync(p)
        if (st.isFile()) {
          gitPathCache = p
          break
        }
      } catch {
        // 该目录没有,继续
      }
    }
  }
  return gitPathCache
}

/** git 是否可用(功能探测,不做版本比对;测试可注入伪 git) */
export function gitAvailable(): boolean {
  return detectGitPath() !== null
}

/** 仅供测试注入伪 git 可执行路径;生产代码不得调用 */
export function setGitPathForTests(p: string | null): void {
  gitPathCache = p
}

export function gitPath(): string {
  const p = detectGitPath()
  if (!p) throw new Error('本机 git 不可用')
  return p
}

/**
 * 执行一条 git 命令(参数数组;args 里的路径按调用方给的原文传递,git 自行按 cwd 解析)。
 * 失败不抛异常(返回 ok:false + stderr),只有「git 不可用 / 超时 / 启动失败」才以异常形态出。
 */
export async function gitExec(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {}
): Promise<GitResult> {
  const exe = gitPath()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return await new Promise<GitResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, {
        cwd: opts.cwd,
        shell: false,
        // 独立进程组(codex 评审 H3):git 可经 checkout filter/hook/签名程序派生子进程,
        // 只杀 git 本体时子进程仍持有 stdout/stderr 管道,close 永不触发、调用挂死——
        // detached 后可整组击杀(与 shell.ts run_command 同款取舍)
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...nonInteractiveEnv(opts.env) }
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    let out = ''
    let errOut = ''
    let capped = false
    // 上限按字节计(codex 评审 L1:JS 字符串 length 是 UTF-16 码元数,中文输出 6MB 字节
    // 只算 2M 字符,旧口径不截断);流式解码防多字节字符跨 chunk 被截半
    let bytesUsed = 0
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    const collect = (chunk: Buffer, dec: StringDecoder): string => {
      if (bytesUsed >= GIT_OUTPUT_CAP) {
        capped = true
        return ''
      }
      bytesUsed += chunk.length
      if (bytesUsed > GIT_OUTPUT_CAP) capped = true
      return dec.write(chunk)
    }
    child.stdout?.on('data', (b: Buffer) => (out += collect(b, outDecoder)))
    child.stderr?.on('data', (b: Buffer) => (errOut += collect(b, errDecoder)))
    let timedOut = false
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (timedOut) {
        reject(new GitTimeoutError(timeoutMs))
        return
      }
      // 收尾 flush 两路解码器的残留尾字节(多字节字符跨 chunk 的半字符)
      out += outDecoder.end()
      errOut += errDecoder.end()
      if (capped) errOut += '\n[git 输出超过 4MB,已截断]'
      resolve({ ok: code === 0, code: code ?? -1, stdout: out, stderr: errOut })
    }
    // 整组击杀(detached 进程组,负 pid;Windows 无进程组信号走 taskkill /T 连树强杀,同 shell.ts)
    const killChild = (): void => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        return
      }
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // 组已退出
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killChild()
    }, timeoutMs)
    const onAbort = (): void => {
      killChild()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => finish(code))
  })
}

/** 便捷形态:期待成功的调用,失败即抛(带 stderr 摘要) */
export async function gitMust(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {}
): Promise<GitResult> {
  const r = await gitExec(args, opts)
  if (!r.ok) {
    const why = r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
    throw new Error(`git ${args[0] ?? ''} 失败(exit ${r.code}):${why || '(无 stderr)'}`)
  }
  return r
}
