// 危险命令分类纯逻辑(2026-11-04 W1/W2 修复时从 shell.ts 拆出,零 electron 依赖):
// 供主进程 run_command 分类与 vitest 单测同源调用(测试不能复制算法测自身)。
// 平台语义经 platform 参数注入(win32/posix):测试可在任意宿主上验证 Windows 分支。
import os from 'node:os'
import path from 'node:path'
import { realpathSafe } from './path-fence'

/** 分类器接受的命令长度上限(与既有行为一致) */
export const MAX_COMMAND_CHARS = 4096

export interface ClassifyResult {
  verdict: 'auto' | 'ask'
  reason?: string
}

/** 默认危险命令模式(§6.7)。2026-10-27 起 why=一句人话:审批卡 reason 显示它,不再露正则原文(内测反馈「看不懂」) */
export const DEFAULT_DANGER_PATTERNS: { pattern: string; why: string }[] = [
  { pattern: '\\bsudo\\b|\\bsu\\b|\\bdoas\\b', why: '提权执行(sudo 等),以管理员身份改动系统' },
  { pattern: '(^|\\s)rm\\s+(-\\S*[rf]\\S*|--recursive|--force)', why: '递归或强制删除文件,删了难以找回' },
  {
    pattern: '\\bdd\\s+(if|of)=|\\bmkfs|\\bdiskutil\\s+(erase|partition|apfs)|\\bnvram\\b',
    why: '磁盘级操作,可能清空整块盘'
  },
  { pattern: '\\bgit\\s+push\\b', why: '推送到远程仓库,会公开或覆盖远端内容' },
  {
    pattern:
      '\\b(shutdown|reboot|halt|poweroff)\\b|\\bosascript\\b|\\bdefaults\\s+(write|delete)\\b|\\blaunchctl\\b',
    why: '关机重启或系统级自动化脚本'
  },
  { pattern: '\\bkill\\s+-9\\b|\\bkillall\\b|\\bpkill\\b', why: '强制结束进程' },
  {
    pattern:
      '\\b(chmod|chown)\\s+(-R\\s|--recursive\\s)|(chmod|chown)\\b[^|;&]*\\s/(System|Library|usr|etc|private)(/|\\s|$)',
    why: '修改系统目录的权限'
  },
  { pattern: '\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(ba|z|fi|k)?sh(\\s|$)', why: '从网上下载脚本直接运行,内容不可预知' }
]

/** Windows 追加模式(2026-11-03 Windows 首版;2026-11-04 W2 修复删除别名真空区):
 *  与 POSIX 清单合并生效,mac 上不会命中(命令不存在)。
 *  已知局限(与 POSIX 清单同级):黑名单是近似而非沙箱,echo del -Recurse 之类字符串文本会误拦
 *  (宁可误拦)、-rec 等中间长度参数缩写不覆盖(极简 -r/-fo 与全拼覆盖)。 */
export const WINDOWS_DANGER_PATTERNS: { pattern: string; why: string }[] = [
  { pattern: '\\bregedit\\b|\\breg\\s+(add|delete|import|load)\\b|\\bbcdedit\\b|\\bdiskpart\\b|\\bvssadmin\\b', why: '改注册表/引导或磁盘底层,可能影响整台系统' },
  { pattern: '\\bformat\\s+[a-z]:', why: '格式化磁盘,数据会全部丢失' },
  // CMD 风格参数(/s /f /q)
  { pattern: '\\b(rd|rmdir)\\s+/s\\b|\\bdel\\s+/[fsq]', why: '递归或强制删除文件,删了难以找回' },
  // PowerShell:Remove-Item 全拼+全部内置别名(del/ri/rd/rmdir/erase 均为其别名),参数覆盖
  // 极简缩写 -r/-fo 与全拼 -Recurse/-Force,\b 防 -readonly 误伤;与 POSIX rm 规则同口径:单 -Force 也拦
  { pattern: '\\b(remove-item|ri|rd|rmdir|erase|del)\\b[^|;&]*\\s-(r(ecurse)?|fo(rce)?)\\b', why: '递归或强制删除文件,删了难以找回' },
  { pattern: '\\bset-executionpolicy\\b|\\biex\\s*\\(|\\binvoke-expression\\b', why: '修改脚本执行策略或动态执行内容不可预知的代码' }
]

/** 生效的默认清单:Windows 追加专属模式;mac 保持 POSIX 清单 */
export function activeDefaultPatterns(platform: string): { pattern: string; why: string }[] {
  return platform === 'win32' ? [...DEFAULT_DANGER_PATTERNS, ...WINDOWS_DANGER_PATTERNS] : DEFAULT_DANGER_PATTERNS
}

/** 归一化变体:小写后分别做「引号/转义→空格」与「引号/转义→删除」——对抗 `gi"t" push`、`rm"-rf"` 式绕过 */
export function normalizeVariants(command: string): string[] {
  const lower = command.toLowerCase()
  const spaced = lower.replace(/['"`\\]/g, ' ').replace(/\s+/g, ' ').trim()
  const glued = lower.replace(/['"`\\]/g, '').replace(/\s+/g, ' ').trim()
  return spaced === glued ? [spaced] : [spaced, glued]
}

/** 卡面 reason:命中默认清单给人话;命中自定义清单不露正则(0.9 起自定义无 UI,兼容旧库) */
export function dangerWhy(re: RegExp, platform: string): string {
  const hit = activeDefaultPatterns(platform).find((p) => p.pattern === re.source)
  return hit ? hit.why : '命中你自定义的危险命令规则'
}

type PathMod = typeof path.posix

function pathModFor(platform: string): PathMod {
  return platform === 'win32' ? path.win32 : path.posix
}

/** 注入平台语义的围栏判断(生产 isWithin 用宿主 path,这里必须与解析同语义) */
function isWithinWith(pathMod: PathMod, parent: string, child: string): boolean {
  const rel = pathMod.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !pathMod.isAbsolute(rel))
}

/** 单个覆盖性重定向目标的提取结果 */
export type RedirectTarget =
  | { kind: 'file'; target: string } // 可静态解析的文件目标(相对/绝对/带引号/~ 展开在分类时做)
  | { kind: 'discard' } // /dev/null、NUL、$null:丢弃输出,不落文件
  | { kind: 'uncertain' } // 命令替换/通配符等,无法静态确定目标 → 保守 ask

/** 从**原始命令段**(未归一化,保留引号与路径字符)提取全部覆盖性重定向(`>` 与 `2>`,不含 `>>` 追加)。
 *  W1(2026-11-04):旧实现从归一化变体提取,Windows 绝对路径 C:\Users\... 的反斜杠被删,
 *  提取出 `c:`(盘符相对,resolve 回 workdir)或废字符串,越界覆盖被判「区内」放行。 */
export function extractRedirectTargets(seg: string, platform: string): RedirectTarget[] {
  const out: RedirectTarget[] = []
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] !== '>') continue
    if (seg[i + 1] === '>') {
      i++ // >> 追加:既有策略放行
      continue
    }
    if (i > 0 && seg[i - 1] === '>') continue
    let rest = seg.slice(i + 1)
    if (rest.startsWith('|')) rest = rest.slice(1) // >| clobber:目标照常检查
    if (/^&\d/.test(rest)) continue // >&1 / 2>&1 fd 合并:目标是描述符不是文件
    rest = rest.replace(/^\s+/, '')
    // 引号包裹的路径(路径含空格的常态写法):取到闭合引号
    let raw: string
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1)
      raw = end > 0 ? rest.slice(1, end) : rest.slice(1)
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1)
      raw = end > 0 ? rest.slice(1, end) : rest.slice(1)
    } else {
      raw = rest.split(/[\s|&;]+/, 1)[0] ?? ''
    }
    if (!raw) continue // `>` 后无目标:shell 自会报错,不写文件
    const lower = raw.toLowerCase()
    if (platform === 'win32') {
      if (lower === 'nul' || lower === '$null' || lower === '/dev/null') {
        out.push({ kind: 'discard' })
        continue
      }
    } else if (lower.startsWith('/dev/')) {
      out.push({ kind: 'discard' })
      continue
    }
    if (/[*?[\]]/.test(raw)) {
      out.push({ kind: 'uncertain' }) // glob 运行期展开,静态拿不准
      continue
    }
    if (raw.startsWith('$(') || raw.startsWith('`') || raw.startsWith('(')) {
      out.push({ kind: 'uncertain' }) // 命令替换/子表达式
      continue
    }
    out.push({ kind: 'file', target: raw })
  }
  return out
}

/**
 * 危险命令分类(cindy 简化版):关键词按归一化变体匹配(对抗混淆),任一段命中即整条 ask。
 * 结构性检查(命令过长、覆盖性重定向到工作区外)独立于可配置清单,始终生效。
 * platform 注入路径语义;customPatterns 为用户自定义危险模式(safety 设置,优先于默认清单)。
 */
export function classifyCommandFor(
  command: string,
  workspace: string,
  workdir: string,
  platform: string,
  customPatterns: string[] | null = null
): ClassifyResult {
  if (command.length > MAX_COMMAND_CHARS) {
    return { verdict: 'ask', reason: `命令超过 ${MAX_COMMAND_CHARS} 字符` }
  }
  const norms = normalizeVariants(command)
  const split = (s: string): string[] => s.split(/&&|\|\||[;|\n]/).map((seg) => seg.trim()).filter(Boolean)
  const segments = norms.flatMap(split)
  const sources = customPatterns && customPatterns.length > 0 ? customPatterns : activeDefaultPatterns(platform).map((p) => p.pattern)
  for (const src of sources) {
    let re: RegExp | null = null
    try {
      re = new RegExp(src, 'i')
    } catch {
      re = null
    }
    if (re && (norms.some((n) => re!.test(n)) || segments.some((s) => re!.test(s)))) {
      return { verdict: 'ask', reason: dangerWhy(re, platform) }
    }
  }
  // 覆盖性重定向(单个 >,含 2> 与 >|):目标从原始命令段解析,解析到工作区外/拿不准 → ask
  const pathMod = pathModFor(platform)
  const wsReal = realpathSafe(workspace)
  const rawSegs = split(command)
  for (const seg of rawSegs) {
    for (const rt of extractRedirectTargets(seg, platform)) {
      if (rt.kind === 'discard') continue
      if (rt.kind === 'uncertain') {
        return { verdict: 'ask', reason: '覆盖性重定向的目标无法静态判断(命令替换/通配符),需确认' }
      }
      let t = rt.target
      // ~ 展开(bash/PS 均支持):旧实现把 ~ 当普通相对名放行,实际写到用户主目录——存量漏审批,顺手修
      if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) {
        t = pathMod.join(os.homedir(), t.slice(1).replace(/^[\\/]/, ''))
      }
      const resolved = pathMod.isAbsolute(t) ? pathMod.normalize(t) : pathMod.resolve(workdir, t)
      if (!isWithinWith(pathMod, wsReal, realpathSafe(resolved))) {
        return { verdict: 'ask', reason: `覆盖性重定向到工作区外:${resolved}` }
      }
    }
  }
  return { verdict: 'auto' }
}
