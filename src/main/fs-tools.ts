import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { Bot, BotFileEntry } from '@shared/types'
import { requestApproval, type ApprovalScope } from './approval'
import { audit } from './audit'
import { getDb } from './store'
import { remapLegacyWorkspacePath } from './workspace'
import type { TaskExecBase } from './task-threads'

// 本机文件工具(M4.1):read_file / list_dir / find_files / search_files / write_file / edit_file
// 语义参考 pi/cindy/dsh:行号化读取、先读后写(mtime 跟踪)、精确替换、输出双上限(行数+字节)、
// 失败一律以文案返回给模型自纠(与 web.ts 同风格)
// 围栏(M4.1/§6.2):写路径在工作区内直接放行;工作区外需审批卡(完全访问档除外)
//
// 执行基点(2026-11-10 任务会话并行开发):绑定了工作目录的任务回合传 base——相对路径解析、
// 默认目录与写围栏根全部切到 base.root;worktree 模式 hardFence=true,工作树外写入硬拒绝
// (不经审批放行——审批只能兜 shell,不能成为文件工具绕过隔离的常规通道)。

const READ_MAX_LINES = 2000
const MAX_LINE_CHARS = 2000
const OUTPUT_MAX_BYTES = 50 * 1024
const LIST_LIMIT = 500
const FIND_DEFAULT_LIMIT = 200
const FIND_MAX_LIMIT = 1000
const SEARCH_DEFAULT_LIMIT = 100
const SEARCH_MAX_LIMIT = 500
const SEARCH_LINE_CHARS = 500
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8192
const WALK_BUDGET_MS = 10_000
const READ_TRACK_MAX = 256

/** 目录遍历默认剪枝:常见依赖/构建产物/缓存目录;隐藏文件(点开头)一律跳过。
 *  Windows 侧(2026-11-03 首版)补系统目录:主目录遍历不再误入 AppData 等巨无霸 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', 'target', '.cache', '.pytest_cache', '.idea', '.turbo', 'Library',
  'AppData', 'Application Data', 'Local Settings', 'Cookies', 'NetHood', 'PrintHood',
  'Recent', 'SendTo', 'Templates', '「开始」菜单', 'Start Menu', 'Searches', 'Saved Games', 'Links'
])

// ---- 路径解析与围栏 ----

export function resolveBotPath(bot: Bot, input: string, base?: string): string {
  const raw = input.trim()
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  if (path.isAbsolute(raw)) return path.normalize(raw)
  return path.resolve(base ?? bot.workspacePath, raw)
}

// realpathSafe/isWithin 已拆至 path-fence.ts(2026-11-04,零 electron 依赖供分类单测共用);
// 对外 re-export 保持既有 import 路径兼容
import { isWithin, realpathSafe } from './path-fence'
export { realpathSafe, isWithin }

function workspaceRoot(bot: Bot): string {
  return realpathSafe(bot.workspacePath)
}

/**
 * 写围栏:工作区内直接放行;工作区外——半自动档弹审批卡,全自动档自动审批(直接执行+留痕回执)。
 * 任务执行基点(2026-11-10):围栏根切 base.root;worktree 模式硬拒绝越界(不走审批),
 * 直连模式越界照旧走审批(围栏根=绑定目录)。
 * 返回 null = 放行;返回文案 = 拒绝原因(回给模型)。
 */
async function ensureWritable(
  bot: Bot,
  absPath: string,
  toolName: 'write_file' | 'edit_file',
  summary: string,
  signal?: AbortSignal,
  scope?: ApprovalScope,
  base?: TaskExecBase
): Promise<string | null> {
  const fenceRoot = base ? realpathSafe(base.root) : workspaceRoot(bot)
  if (isWithin(fenceRoot, realpathSafe(absPath))) return null
  if (base?.hardFence) {
    return `[任务隔离] 这个任务的写入范围是 ${base.root}(独立工作树),范围外的路径一律不写:${absPath}。隔离是这个任务的安全边界,没有审批例外;若确有范围外的需要,先在对话里向岛主说明,由岛主决定。`
  }
  const decision = await requestApproval(
    bot,
    {
      toolName,
      title: base ? '请求写入任务目录外的路径' : '请求写入工作区外的路径',
      detail: `${absPath}\n${summary}`,
      reason: base ? '这个位置在任务绑定的工作目录之外,确认这一次才写' : '这个位置在 TA 平时的工作文件夹之外,确认这一次才写'
    },
    signal,
    scope?.turnId,
    scope?.threadId
  )
  if (decision === 'approved') return null
  if (decision === 'aborted') return '本次回合已停止,写入未执行。'
  return `岛主拒绝了这次工作区外写入(${absPath})。可以改写到你的工作区内;若确有需要,请岛主在居民档案里调整权限档位。`
}

/**
 * 写后围栏复核(H1 检测型):返回 null=落笔仍在围栏内;返回字符串=实际解析出的越界真实路径。
 * 围栏根也走 realpath(绑定目录自身可能是链接)。
 */
function checkContainment(root: string, writtenPath: string): string | null {
  const fence = realpathSafe(root)
  const real = realpathSafe(writtenPath)
  return isWithin(fence, real) ? null : real
}

// ---- 先读后写(mtime 跟踪,cindy/dsh 式) ----

const readFiles = new Map<string, Map<string, number>>()

function markRead(botId: string, realPath: string, mtimeMs: number): void {
  let per = readFiles.get(botId)
  if (!per) {
    per = new Map()
    readFiles.set(botId, per)
  }
  if (per.size >= READ_TRACK_MAX) {
    const oldest = per.keys().next().value
    if (oldest !== undefined) per.delete(oldest)
  }
  per.set(realPath, mtimeMs)
}

/** 覆盖/修改已存在文件前的校验;返回 null=通过 */
function readGuard(botId: string, absPath: string, stat: fs.Stats): string | null {
  const real = realpathSafe(absPath)
  const seen = readFiles.get(botId)?.get(real)
  if (seen === undefined) {
    return `文件已存在但本轮还没读过:${absPath}\n请先用 read_file 读原文,再覆盖或修改(防止盲写)。`
  }
  if (seen !== stat.mtimeMs) {
    return `文件在你上次读取后已被修改:${absPath}\n请重新 read_file 后再写。`
  }
  return null
}

// ---- 只读工具 ----

async function isBinary(absPath: string): Promise<boolean> {
  const fh = await fsp.open(absPath, 'r')
  try {
    const head = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await fh.read(head, 0, BINARY_SNIFF_BYTES, 0)
    return head.subarray(0, bytesRead).includes(0)
  } finally {
    await fh.close()
  }
}

export async function readFileTool(bot: Bot, args: Record<string, unknown>, base?: TaskExecBase): Promise<string> {
  const input = String(args.path ?? '').trim()
  if (!input) return '缺少参数:path(文件路径)。'
  const offset = Math.max(1, Math.floor(Number(args.offset ?? 1)) || 1)
  const limit = Math.min(READ_MAX_LINES, Math.max(1, Math.floor(Number(args.limit ?? READ_MAX_LINES)) || READ_MAX_LINES))
  const abs = resolveBotPath(bot, input, base?.root)

  let stat: fs.Stats
  try {
    stat = await fsp.stat(abs)
  } catch {
    return `文件不存在:${abs}(相对路径基于${base ? `本任务工作目录 ${base.root}` : `你的工作区 ${bot.workspacePath}`})。`
  }
  if (stat.isDirectory()) return `这是一个目录,不是文件:${abs}\n列目录请用 list_dir。`
  if (await isBinary(abs)) {
    return `这是二进制文件,不能按文本读取:${abs}`
  }

  const end = offset + limit - 1
  const lines: string[] = []
  let lineNo = 0
  let bytesUsed = 0
  let totalLines = 0
  let capped = false

  // 提前 break/上限截断时 readline.close() 不会关掉底层流,fd 悬着直到 GC——显式持有并销毁
  const stream = fs.createReadStream(abs, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      totalLines = ++lineNo
      if (lineNo < offset) continue
      if (lineNo > end) break
      const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…[行已截断]` : line
      if (bytesUsed + shown.length > OUTPUT_MAX_BYTES) {
        capped = true
        break
      }
      bytesUsed += shown.length
      lines.push(`${lineNo}\t${shown}`)
    }
  } catch {
    return `读取失败:${abs}(文件可能正在变化或无权限)。`
  } finally {
    rl.close()
    stream.destroy()
  }

  markRead(bot.id, realpathSafe(abs), stat.mtimeMs)

  if (lines.length === 0) {
    return offset > totalLines
      ? `起始行 ${offset} 超出文件总行数(共 ${totalLines} 行)。`
      : `文件是空的:${abs}`
  }
  const lastShown = Number(lines[lines.length - 1]!.split('\t', 1)[0])
  const notes: string[] = []
  if (lastShown < totalLines || capped) {
    notes.push(`已显示第 ${offset}–${lastShown} 行(共 ${totalLines} 行);继续读用 offset=${lastShown + 1}${capped ? '(已达单次 50KB 上限,可减小 limit)' : ''}。`)
  }
  return `${lines.join('\n')}${notes.length ? `\n\n[${notes.join(' ')}]` : ''}`
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fmtDate(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

export async function listDirTool(bot: Bot, args: Record<string, unknown>, base?: TaskExecBase): Promise<string> {
  const input = String(args.path ?? '').trim()
  const abs = input ? resolveBotPath(bot, input, base?.root) : (base?.root ?? bot.workspacePath)
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true })
  } catch {
    return `目录不存在或不可读:${abs}`
  }

  const dirs = entries.filter((e) => e.isDirectory() && e.name !== '.DS_Store').map((e) => e.name).sort()
  const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort()
  const names = [...dirs.map((n) => `${n}/`), ...files].slice(0, LIST_LIMIT)
  const truncated = dirs.length + files.length > names.length

  const lines: string[] = []
  for (const name of names) {
    const full = path.join(abs, name)
    try {
      const st = await fsp.stat(full)
      lines.push(name.endsWith('/') ? `d  ${name}  ${fmtDate(st.mtime.toISOString())}` : `f  ${name}  ${fmtSize(st.size)}  ${fmtDate(st.mtime.toISOString())}`)
    } catch {
      lines.push(`?  ${name}`)
    }
  }
  if (lines.length === 0) return `目录是空的:${abs}`
  return `${lines.join('\n')}${truncated ? `\n\n[仅显示前 ${LIST_LIMIT} 项]` : ''}`
}

/** glob → RegExp:支持 * ** ? 与 {a,b};匹配相对路径,大小写不敏感(macOS 习惯) */
export function globToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i += 2
        if (pattern[i] === '/') i++
      } else {
        re += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      re += '[^/]'
      i++
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end > i) {
        const alts = pattern
          .slice(i + 1, end)
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean)
          .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        re += `(?:${alts.join('|')})`
        i = end + 1
      } else {
        re += '\\{'
        i++
      }
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      i++
    }
  }
  return new RegExp(`^${re}$`, 'i')
}

interface WalkResult {
  files: string[]
  budgetHit: boolean
}

/** 目录遍历(供 find/search 共用):跳过 SKIP_DIRS 与隐藏条目,10s 预算 */
async function walkFiles(root: string, budgetMs = WALK_BUDGET_MS): Promise<WalkResult> {
  const files: string[] = []
  const deadline = Date.now() + budgetMs
  let budgetHit = false
  const stack: string[] = [root]
  while (stack.length > 0) {
    if (Date.now() > deadline) {
      budgetHit = true
      break
    }
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name))
      } else if (e.isFile()) {
        files.push(path.join(dir, e.name))
      }
    }
  }
  return { files, budgetHit }
}

export async function findFilesTool(bot: Bot, args: Record<string, unknown>, base?: TaskExecBase): Promise<string> {
  const pattern = String(args.pattern ?? '').trim()
  if (!pattern) return '缺少参数:pattern(文件名 glob,如 "*.ts" 或 "src/**/*.md")。'
  const input = String(args.path ?? '').trim()
  const root = input ? resolveBotPath(bot, input, base?.root) : (base?.root ?? bot.workspacePath)
  const limit = Math.min(FIND_MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit ?? FIND_DEFAULT_LIMIT)) || FIND_DEFAULT_LIMIT))
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return `目录不存在:${root}`
  }

  const re = globToRegExp(pattern)
  const matchName = !pattern.includes('/')
  const { files, budgetHit } = await walkFiles(root)

  const hits: { file: string; mtime: number }[] = []
  for (const file of files) {
    const rel = path.relative(root, file)
    if (re.test(rel) || (matchName && re.test(path.basename(file)))) {
      try {
        hits.push({ file, mtime: (await fsp.stat(file)).mtimeMs })
      } catch {
        hits.push({ file, mtime: 0 })
      }
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime)
  const shown = hits.slice(0, limit)

  if (shown.length === 0) {
    return `没找到匹配「${pattern}」的文件。可以放宽模式,或换个目录(path 参数)。${budgetHit ? '(遍历超 10 秒,结果可能不全)' : ''}`
  }
  const notes: string[] = []
  if (shown.length < hits.length) notes.push(`共 ${hits.length} 个,仅显示前 ${shown.length} 个(按修改时间从新到旧)`)
  if (budgetHit) notes.push('遍历超过 10 秒被截断,结果可能不全;建议缩小 path 范围')
  return `${shown.map((h) => h.file).join('\n')}${notes.length ? `\n\n[${notes.join(';')}]` : ''}`
}

export async function searchFilesTool(bot: Bot, args: Record<string, unknown>, base?: TaskExecBase): Promise<string> {
  const patternInput = String(args.pattern ?? '').trim()
  if (!patternInput) return '缺少参数:pattern(正则表达式)。'
  const include = String(args.include ?? '').trim()
  const ignoreCase = args.ignore_case === true
  const input = String(args.path ?? '').trim()
  const root = input ? resolveBotPath(bot, input, base?.root) : (base?.root ?? bot.workspacePath)
  const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit ?? SEARCH_DEFAULT_LIMIT)) || SEARCH_DEFAULT_LIMIT))

  let re: RegExp
  try {
    re = new RegExp(patternInput, ignoreCase ? 'i' : '')
  } catch (err) {
    return `正则表达式无效:${err instanceof Error ? err.message : String(err)}。`
  }
  const includeRe = include ? globToRegExp(include) : null
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return `目录不存在:${root}`
  }

  const { files, budgetHit } = await walkFiles(root)
  const results: string[] = []
  let truncated = false
  let bytesUsed = 0

  outer: for (const file of files) {
    if (includeRe && !includeRe.test(path.basename(file))) continue
    let stat: fs.Stats
    try {
      stat = await fsp.stat(file)
    } catch {
      continue
    }
    if (stat.size === 0 || stat.size > SEARCH_MAX_FILE_BYTES) continue
    let content: string
    try {
      const buf = await fsp.readFile(file)
      if (buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES)).includes(0)) continue
      content = buf.toString('utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        const text = lines[i]!.trim().slice(0, SEARCH_LINE_CHARS)
        const line = `${file}:${i + 1}:${text}`
        if (results.length >= limit || bytesUsed + line.length > OUTPUT_MAX_BYTES) {
          truncated = true
          break outer
        }
        results.push(line)
        bytesUsed += line.length
      }
    }
  }

  if (results.length === 0) {
    return `没搜到匹配「${patternInput}」的内容。可以换关键词、调整正则或扩大 path 范围。${budgetHit ? '(遍历超 10 秒,结果可能不全)' : ''}`
  }
  const notes: string[] = []
  if (truncated) notes.push(`已达上限(最多 ${limit} 条 / 50KB),可用更精确的 pattern 或加 include 过滤`)
  if (budgetHit) notes.push('遍历超过 10 秒被截断,结果可能不全;建议缩小 path 范围')
  return `${results.join('\n')}${notes.length ? `\n\n[${notes.join(';')}]` : ''}`
}

// ---- 写工具 ----

export async function writeFileTool(
  bot: Bot,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  scope?: ApprovalScope,
  base?: TaskExecBase
): Promise<string> {
  const input = String(args.path ?? '').trim()
  if (!input) return '缺少参数:path(目标路径)。'
  if (typeof args.content !== 'string') return '缺少参数:content(文件完整内容)。'
  const content = args.content
  const abs = resolveBotPath(bot, input, base?.root)

  let existed = false
  let prevMtimeMs = 0
  let prevSize = 0
  try {
    const stat = await fsp.stat(abs)
    if (stat.isDirectory()) return `目标是目录,不能写文件:${abs}`
    const guard = readGuard(bot.id, abs, stat)
    if (guard) return guard
    existed = true
    prevMtimeMs = stat.mtimeMs
    prevSize = stat.size
  } catch {
    // 不存在 = 新建,直接通过
  }

  const gate = await ensureWritable(bot, abs, 'write_file', `写入 ${content.length} 字符(整体覆盖)`, signal, scope, base)
  if (gate) return gate

  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    if (existed) {
      // 审批等待期间文件被改过:整体覆盖会吃掉别人的修改,复核 mtime 后诚实拒绝
      const fresh = await fsp.stat(abs)
      if (fresh.mtimeMs !== prevMtimeMs || fresh.size !== prevSize) {
        return `文件在审批等待期间被别人改过(${abs}),这次写入没有执行。请重新 read_file 核对最新内容后再写。`
      }
      await fsp.writeFile(abs, content, 'utf8')
    } else {
      // 审批期间冒出来的新文件不是这次审批覆盖的对象:排他创建,已存在即拒绝
      await fsp.writeFile(abs, content, { encoding: 'utf8', flag: 'wx' })
    }
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      return `写入取消:${abs} 在审批等待期间被别人新建了。请重新确认后再写。`
    }
    return `写入失败:${err instanceof Error ? err.message : String(err)}。`
  }
  // H1 写后围栏复核(检测型):写前 realpath 在围栏内≠落笔仍在围栏内——父目录符号链接
  // 可能在检查后被替换,让文件落到围栏外。全链路 O_NOFOLLOW/dirfd 重写超出本批范围
  // (居民想换链接本就需 shell,那是文档已声明的残余面),这里至少检测出来、审计留痕、
  // 向居民如实喊话,不让「静默越界」发生。
  if (base) {
    const escaped = checkContainment(base.root, abs)
    if (escaped) {
      audit(bot.id, 'write_file.escaped-fence', { path: abs, real: escaped, root: base.root })
      return `[任务隔离警告] 文件已写入,但位置经符号链接解析到了任务工作范围之外(${escaped})——目录链接可能被替换过。请核对文件实际位置并向岛主说明。`
    }
  }
  audit(bot.id, 'write_file', { path: abs, bytes: content.length, created: !existed })
  return `已写入:${abs}(${content.length} 字符)。`
}

export async function editFileTool(
  bot: Bot,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  scope?: ApprovalScope,
  base?: TaskExecBase
): Promise<string> {
  const input = String(args.path ?? '').trim()
  const oldString = typeof args.old_string === 'string' ? args.old_string : ''
  const newString = typeof args.new_string === 'string' ? args.new_string : ''
  const replaceAll = args.replace_all === true
  if (!input) return '缺少参数:path。'
  if (!oldString) return '缺少参数:old_string(要替换的原文,必须与文件内容精确一致)。'

  const abs = resolveBotPath(bot, input, base?.root)
  let stat: fs.Stats
  let raw: Buffer
  try {
    stat = await fsp.stat(abs)
    raw = await fsp.readFile(abs)
  } catch {
    return `文件不存在:${abs}。新建文件请用 write_file。`
  }
  if (stat.isDirectory()) return `目标是目录:${abs}`
  if (raw.subarray(0, Math.min(raw.length, BINARY_SNIFF_BYTES)).includes(0)) {
    return `这是二进制文件,不能用 edit_file 修改:${abs}`
  }
  const guard = readGuard(bot.id, abs, stat)
  if (guard) return guard

  let content = raw.toString('utf8')
  let oldForMatch = oldString
  let newForWrite = newString
  // read_file 输出是 LF;CRLF 文件需要把匹配串换算回去,写回时保持原行尾
  if (content.includes('\r\n')) {
    oldForMatch = oldString.replace(/\r?\n/g, '\r\n')
    newForWrite = newString.replace(/\r?\n/g, '\r\n')
  }
  if (oldForMatch === newForWrite) return 'old_string 与 new_string 相同,不需要修改。'

  const count = content.split(oldForMatch).length - 1
  if (count === 0) {
    return `在 ${abs} 里没找到要替换的文本。old_string 必须与文件内容逐字一致(含缩进与空行);请先用 read_file 核对原文。`
  }
  if (count > 1 && !replaceAll) {
    return `old_string 在 ${abs} 里出现了 ${count} 次,不唯一。请加长 old_string 包含更多上下文,或传 replace_all: true 全部替换。`
  }

  const gate = await ensureWritable(bot, abs, 'edit_file', `替换 ${replaceAll ? count : 1} 处文本`, signal, scope, base)
  if (gate) return gate

  // 审批等待可能很长:期间文件被岛主/别的居民改过的话,按旧快照整体写回会吃掉别人的修改。
  // 落笔前复核 mtime,变了就诚实拒绝,让模型重新 read_file 再来
  try {
    const fresh = await fsp.stat(abs)
    if (fresh.mtimeMs !== stat.mtimeMs || fresh.size !== stat.size) {
      return `文件在审批等待期间被别人改过(${abs}),这次替换没有执行。请重新 read_file 核对最新内容后再改。`
    }
  } catch {
    return `文件已不存在或无法访问:${abs},这次替换没有执行。`
  }

  content = replaceAll
    ? content.split(oldForMatch).join(newForWrite)
    : content.replace(oldForMatch, () => newForWrite) // 函数式替换:正文按字面写入,$&/$$ 等不再被当替换模板展开
  try {
    await fsp.writeFile(abs, content, 'utf8')
  } catch (err) {
    return `写入失败:${err instanceof Error ? err.message : String(err)}。`
  }
  // H1 写后围栏复核(检测型,同 write_file)
  if (base) {
    const escaped = checkContainment(base.root, abs)
    if (escaped) {
      audit(bot.id, 'edit_file.escaped-fence', { path: abs, real: escaped, root: base.root })
      return `[任务隔离警告] 替换已写入,但文件位置经符号链接解析到了任务工作范围之外(${escaped})——目录链接可能被替换过。请核对文件实际位置并向岛主说明。`
    }
  }
  audit(bot.id, 'edit_file', { path: abs, replaced: replaceAll ? count : 1 })
  return `已替换 ${replaceAll ? count : 1} 处:${abs}`
}

// ---- 经手文件视图(档案「文件」页签):audit 是唯一事实源,运行时 stat 补当前磁盘状态 ----

const FILE_LIST_MAX = 200

export function listBotFiles(bot: Bot): BotFileEntry[] {
  let rows: { kind: string; detail: string; created_at: string }[]
  try {
    rows = getDb()
      .prepare(
        `SELECT kind, detail, created_at FROM audit
          WHERE bot_id = ? AND kind IN ('write_file', 'edit_file')
          ORDER BY id DESC`
      )
      .all(bot.id) as { kind: string; detail: string; created_at: string }[]
  } catch {
    return []
  }

  const root = workspaceRoot(bot)
  const agg = new Map<string, { lastAt: string; ops: number; created: boolean }>()
  for (const row of rows) {
    // 最新在前:每条路径第一次出现即最近一次写入
    let detail: { path?: unknown; created?: unknown }
    try {
      detail = JSON.parse(row.detail)
    } catch {
      continue
    }
    const p = typeof detail.path === 'string' ? detail.path : ''
    if (!p) continue
    const prev = agg.get(p)
    if (prev) {
      prev.ops += 1
      prev.created = prev.created || detail.created === true
    } else {
      agg.set(p, { lastAt: row.created_at, ops: 1, created: detail.created === true })
    }
  }

  // 迁移兼容:0.9.6 起默认工作区搬去 ~/群岛,旧审计行不改写——旧默认根下的路径改写前缀再探一次,
  // 命中即用新位置(打开/显示/徽章全按新路径)。新旧两形态可能指向同一文件,按生效路径去重合并
  // (审计 id 倒序,先见者为较新写入:lastAt 取先到者,ops 累加,created 取或)。
  const entries = new Map<string, BotFileEntry>()
  for (const [p, a] of agg) {
    let eff = p
    let exists = false
    let size: number | null = null
    let statError: string | null = null
    try {
      const st = fs.statSync(p)
      if (st.isFile()) {
        exists = true
        size = st.size
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        const remapped = remapLegacyWorkspacePath(p)
        if (remapped !== p) {
          try {
            const st = fs.statSync(remapped)
            if (st.isFile()) {
              eff = remapped
              exists = true
              size = st.size
            }
          } catch {
            // 双双缺失:按原路径的「已不存在」处理
          }
        }
      } else {
        // EACCES/EPERM 等=路径在但主进程无权看——macOS 对 桌面/文稿/下载/网盘 有 TCC 隐私墙,
        // 被拒时文件明明在也会 stat 失败,与「已不存在」分开透出 code,前端才能如实告知
        statError = code ?? null
      }
    }
    const real = realpathSafe(eff)
    const inWorkspace = isWithin(root, real)
    const merged = entries.get(eff)
    if (merged) {
      merged.ops += a.ops
      merged.created = merged.created || a.created
      continue
    }
    entries.set(eff, {
      path: eff,
      displayPath: inWorkspace ? path.relative(root, real) : eff,
      inWorkspace,
      created: a.created,
      ops: a.ops,
      lastAt: a.lastAt,
      exists,
      size,
      statError
    })
  }
  const list = [...entries.values()]
  list.sort((x, y) => (x.lastAt < y.lastAt ? 1 : -1))
  return list.slice(0, FILE_LIST_MAX)
}
