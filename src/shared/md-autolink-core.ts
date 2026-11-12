// 居民正文里的本机路径 autolink(2026-11-06 方案 A;同日走查反馈补后缀规则):
// 纯函数扫描路径跨度,渲染层 remark 插件与选区浮窗「打开」判定与单测三方共用(零 electron 依赖)。
// 双规则:Felix 走查案例=居民在对话里最自然的写法是工作区相对路径(产出/xxx.md)——
// ①前缀规则(家目录形态,任意后缀):/Users/<名>/… 与 ~/…;
// ②后缀规则(.md/.markdown 结尾且含 /):相对路径与任意绝对路径(含 /tmp 等),点击时相对路径由
//   渲染层按当前居民工作区解析(见 Markdown.tsx 的 WorkspaceBaseContext),无解析语境则还原纯文本。
// 限制:不支持带空格的路径(匹配止于空白,截断路径点击会得到诚实的「文件已不在原位」)。

export interface LocalPathSpan {
  start: number
  /** 不含,与 String.slice 同口径 */
  end: number
  path: string
  /** true=工作区相对路径(产出/xxx.md),需要解析基准;false=绝对/~ 形态,直接可点 */
  relative: boolean
}

/**
 * 段字符=路径里允许出现的字符:字母/数字/CJK/`.`(扩展名)/`-`_` 等文件名常用符。
 * 反向排除三类:①空白 ②引号/书名号类(「」『』《》<>"'`)③中英句读(。，、；：！？,:;!?)与括号。
 * 句读是中文句子的天然边界:路径在第一个非段字符处截断(b.md,请查收 → b.md;felix,里面 → 只剩
 * 裸基座被拒)。文件名含逗号/冒号/括号属罕见,牺牲换零误伤。两类正则共用这份停止集。
 */
const SEG_STOP_SRC = '\\s<>"\'`「」『』《》。，、；：！？,:;!?()（）\\[\\]'
const SEGMENT_STOP_RE = new RegExp(`[${SEG_STOP_SRC}]`)

/** 前缀规则基座:/Users/<名> 或 ~;后跟至少一段 /xxx(段字符宽收,截断语义见 SEGMENT_STOP_RE) */
const HOME_PATH_RE = /(?:\/Users\/[^/\s]+|~)(?:\/[^\s]+)+/g

/** 后缀规则:段字符串、含至少一个 /、以 .md/.markdown 结尾(词边界防 .mdx);裸文件名(无 /)不认 */
const MD_SUFFIX_RE = new RegExp(`[^${SEG_STOP_SRC}]+\\/[^${SEG_STOP_SRC}]*\\.(?:md|markdown)\\b`, 'gi')

/** 路径起点前不能是路径字符:防止 xx/yyy/… 的中段误接 */
const PRECEDING_PATH_CHARS = /[\w~/.-]/

/**
 * 起点守卫:前一个字符是路径字符 → 中段误接,拒。
 * 冒号特判:「文件:产出/x.md」的冒号是合法引导,但 URL scheme 要拒——冒号前是 http(s)
 * 时,这个「路径」其实是 URL 的中段(before 已不含冒号,模式也不能再带冒号)。
 */
function startGuardFail(text: string, start: number): boolean {
  if (start === 0) return false
  const prev = text[start - 1] ?? ''
  if (PRECEDING_PATH_CHARS.test(prev)) return true
  if (prev === ':' || prev === '：') {
    return /https?$/i.test(text.slice(0, start - 1))
  }
  return false
}

function truncateAtStop(path: string): string {
  // 前缀规则的段字符宽收([^\s]):从首个停止符处截断
  const stop = SEGMENT_STOP_RE.exec(path)
  return stop ? path.slice(0, stop.index) : path
}

/**
 * 后缀规则的绝对头裁齐:「见/Users/…」「备份在~/…」——中文直接贴在绝对标记前时,真正路径从
 * ~ 或 /Users/ 起(CJK 头只是句子前缀)。产出/x.md 这类真相对路径没有这些标记,不受影响。
 */
function trimAbsoluteHead(path: string): string {
  const tilde = path.lastIndexOf('~')
  if (tilde > 0) return path.slice(tilde)
  const users = path.indexOf('/Users/')
  if (users > 0) return path.slice(users)
  return path
}

function isRelativePath(path: string): boolean {
  return !path.startsWith('/') && !path.startsWith('~') && !/^[a-zA-Z]:[\\/]/.test(path)
}

function pushSpan(spans: LocalPathSpan[], start: number, path: string, relative: boolean): void {
  // 截完可能只剩裸基座(/Users/felix 或 ~)或裸扩展名,不算路径
  if (!path.includes('/', relative ? 0 : 1) || path === '~') return
  spans.push({ start, end: start + path.length, path, relative })
}

/** 扫描一段纯文本里的本机路径跨度(升序、不重叠,两规则重合时取更长的一段);只处理纯文本——代码块/已有链接由调用方(mdast 节点类型)天然隔离 */
export function scanLocalPathSpans(text: string): LocalPathSpan[] {
  const home: LocalPathSpan[] = []
  const suffix: LocalPathSpan[] = []
  let m: RegExpExecArray | null

  HOME_PATH_RE.lastIndex = 0
  while ((m = HOME_PATH_RE.exec(text)) !== null) {
    const start = m.index
    if (startGuardFail(text, start)) continue
    pushSpan(home, start, truncateAtStop(m[0]), false)
  }

  MD_SUFFIX_RE.lastIndex = 0
  while ((m = MD_SUFFIX_RE.exec(text)) !== null) {
    let start = m.index
    let path = truncateAtStop(m[0])
    if (!/\.(?:md|markdown)$/i.test(path)) continue
    const trimmed = trimAbsoluteHead(path)
    if (trimmed.length !== path.length) {
      start += path.length - trimmed.length
      path = trimmed
    }
    if (startGuardFail(text, start)) continue
    pushSpan(suffix, start, path, isRelativePath(path))
  }

  // 合并去重:重叠时保留更长者(绝对形态两规则等长任取;前缀规则截短而后缀规则完整时取后缀)
  const all = [...home, ...suffix].sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: LocalPathSpan[] = []
  for (const span of all) {
    const last = merged[merged.length - 1]
    if (last && span.start < last.end) {
      if (span.end > last.end) merged[merged.length - 1] = span
      continue
    }
    merged.push(span)
  }
  return merged
}

/** 相对路径按工作区基准解析(纯字符串拼接,.. 逃逸由打开侧的诚实报错兜住;绝对形态原样返回;无基准 null) */
export function resolveWorkspacePath(base: string | null, path: string): string | null {
  if (!path) return null
  if (!isRelativePath(path)) return path
  if (!base) return null
  const trimBase = base.replace(/[\\/]+$/, '')
  if (!trimBase) return null
  return `${trimBase}/${path.replace(/^[\\/]+/, '')}`
}

/** 整段文本恰好是一个本机路径(选区浮窗「打开」的判定);返回路径或 null */
export function isLocalPathText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const spans = scanLocalPathSpans(trimmed)
  return spans.length === 1 && spans[0]!.start === 0 && spans[0]!.end === trimmed.length
    ? spans[0]!.path
    : null
}