// 技能导入纯逻辑核心(2026-11-08 import_skill,与 skills-core 同款拆法):
// SKILL.md frontmatter 解析、导入卡校验(64/500/正文不限——岛主精选外带,拍板不压缩)、
// 来源目录扫描(上限/符号链接/噪音目录)、随卡文件清单文本——不碰 Electron/DB,冒烟直接 import
// DB 读写与编排见 skills.ts,工具编排见 tools.ts
import fs from 'node:fs'
import path from 'node:path'

/** 导入卡的上限(居民自建仍走 skills-core 的 20/120/10000):名字/描述对齐 Claude Code
 *  技能包命名惯例(2026-11-08 拍板),正文不设限——岛主从网络精选的技能保留原样,不压缩 */
export const IMPORTED_NAME_MAX = 64
export const IMPORTED_DESC_MAX = 500

/** 随卡资产上限:单文件 512KB / 全部合计 2MB / 文件数 50;超限文件跳过并记进清单(不整包拒收) */
export const IMPORT_ASSET_MAX_FILE_BYTES = 512 * 1024
export const IMPORT_ASSET_MAX_TOTAL_BYTES = 2 * 1024 * 1024
export const IMPORT_ASSET_MAX_FILES = 50

/** 技能收件箱目录名(工作区可见根 ~/群岛 下,岛主丢技能包的第二入口;第一入口=聊天附件) */
export const SKILL_INBOX_DIR_NAME = '技能收件箱'

/** 扫描时直接跳过的噪音条目(目录与系统文件;逐条记进 skipped,不静默) */
const SKIPPED_TREE_ENTRIES = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.DS_Store', 'Thumbs.db'])

export interface ImportedSkillDraft {
  name: string
  description: string
  content: string
}

/** 导入卡落卡校验:返回错误文案(null=通过)。与 validateSkillDraft 分工:上限宽、正文不限长 */
export function validateImportedSkillDraft(draft: ImportedSkillDraft): string | null {
  if (!draft.name) return '技能名不能为空:SKILL.md 的 frontmatter 要有 name,或把名字告诉居民。'
  if (draft.name.length > IMPORTED_NAME_MAX)
    return `技能名太长(${draft.name.length} 字,上限 ${IMPORTED_NAME_MAX} 字);可在导入时换个名字。`
  if (!draft.description) return '描述不能为空:SKILL.md 的 frontmatter 要有 description(什么时候用)。'
  if (draft.description.length > IMPORTED_DESC_MAX)
    return `描述太长(${draft.description.length} 字,上限 ${IMPORTED_DESC_MAX} 字),取 frontmatter 里的一句话。`
  if (!draft.content) return '正文不能为空:SKILL.md 除 frontmatter 外要有正文。'
  return null
}

export interface ParsedSkillMd {
  name?: string
  description?: string
  /** 去掉 frontmatter 后的正文(原样保留,不压缩不清洗) */
  body: string
}

/** 单行值清洗:去成对引号与行尾空白 */
function cleanScalar(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))))
    return t.slice(1, -1)
  return t
}

const isBlockStyle = (v: string): boolean => v === '>' || v === '>-' || v === '|' || v === '|-'

/** 第 targetLine 行在原文里的字符偏移(正文按原文切片:不重排行尾,保住 CRLF 与行首缩进) */
function rawLineOffset(text: string, targetLine: number): number {
  let pos = 0
  for (let n = 0; n < targetLine; n++) {
    const nl = text.indexOf('\n', pos)
    if (nl === -1) return text.length
    pos = nl + 1
  }
  return pos
}

/** 块标量收值:剥公共缩进('|' 字面量保留行内缩进与空行——描述里贴代码段不破形;
 *  '>' 折叠成段,空行当分段;尾部空行丢弃) */
function foldBlockScalar(style: '>' | '|', rawLines: string[]): string {
  const filled = [...rawLines]
  while (filled.length > 0 && filled[filled.length - 1] === '') filled.pop()
  if (filled.length === 0) return ''
  const base = Math.min(...filled.filter((l) => l !== '').map((l) => l.length - l.trimStart().length))
  const stripped = filled.map((l) => (l === '' ? '' : l.slice(Math.min(base, l.length - l.trimStart().length))))
  if (style === '|') return stripped.join('\n')
  // YAML 折叠口径:相邻非空行的单换行折成空格;空行=分段(留一个换行,再多剥一层)
  return stripped
    .join('\n')
    .replace(/(?<=\S)\n(?=\S)/g, ' ')
    .replace(/\n{2,}/g, (m) => '\n'.repeat(m.length - 1))
    .trim()
}

/**
 * 解析 SKILL.md:开头 `---` 围栏内的扁平 YAML 键值(frontmatter)+ 其余为正文。
 * 只认 name/description 两个键(Claude Code 技能包惯例);其他键(allowed-tools 等)
 * 属宿主专属语义,进群岛无对应物,按拍板忽略。值支持单行标量与 > / >- / | / |- 块标量
 * (块标量允许空行;字面量保留相对缩进)。解析失败或不完整时字段缺省(调用方决定兜底/
 * 报错),绝不抛异常。正文按原文切片原样保留(拍板:不压缩不清洗,含 CRLF 与行首缩进)。
 */
export function parseSkillMd(raw: string): ParsedSkillMd {
  const text = raw.replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { body: text.replace(/^(?:\r?\n)+/, '') }
  const out: ParsedSkillMd = { body: '' }
  let field: 'name' | 'description' | null = null
  let blockStyle: '>' | '|' | null = null
  const blockLines: string[] = []
  let i = 1
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '---' || line.trim() === '...') {
      i++
      break
    }
    // 块标量收集:空行与比键更缩进的行(空行是块内容,截断会静默丢半段描述)
    if (field && blockStyle && (line === '' || /^\s/.test(line))) {
      blockLines.push(line)
      continue
    }
    if (field && blockStyle) {
      // 块标量结束:落值
      setFrontmatterValue(out, field, foldBlockScalar(blockStyle, blockLines))
      field = null
      blockStyle = null
      blockLines.length = 0
    }
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    const key = m?.[1]
    if (!m || !key || (key !== 'name' && key !== 'description')) continue
    // 值域已由上面比较判定,窄化声明安全(可证不变式)
    const f = key as 'name' | 'description'
    const rest = m[2] ?? ''
    if (isBlockStyle(rest.trim())) {
      field = f
      blockStyle = rest.trim().includes('|') ? '|' : '>'
      continue
    }
    if (!rest.trim() && /^\s+\S/.test(lines[i + 1] ?? '')) {
      // 空值且下一行更缩进:按块标量收(多为折行 description)
      field = f
      blockStyle = '>'
      continue
    }
    setFrontmatterValue(out, f, cleanScalar(rest))
  }
  if (field && blockStyle) setFrontmatterValue(out, field, foldBlockScalar(blockStyle, blockLines))
  out.body = text.slice(rawLineOffset(text, i)).replace(/^(?:\r?\n)+/, '')
  return out
}

function setFrontmatterValue(out: ParsedSkillMd, key: 'name' | 'description', value: string): void {
  if (!value) return
  if (key === 'name') out.name = value
  else out.description = value
}

/** 工作区里的随卡目录名(技能/<安全名>);与 defaultWorkspacePath 同款清洗口径。
 *  '.'/'..' 落到兜底名:它们是合法的「清洗结果」却是相对路径分量,会让落位/清理指到
 *  「技能/」上层(实测名字 ".." 经 path.join 即工作区根,卸下会 rm 整个工作区) */
export function sanitizeSkillDirName(name: string): string {
  const safe = name.replace(/[/\\:*?"<>|\s]+/g, '').slice(0, 32)
  return !safe || safe === '.' || safe === '..' ? 'skill' : safe
}

export interface ScannedAssetFile {
  /** 相对来源根的布局路径(正斜杠归一,materialize 按它原样重建) */
  rel: string
  size: number
}

export interface ScannedSkippedEntry {
  rel: string
  reason: string
}

export interface SourceScanResult {
  files: ScannedAssetFile[]
  skipped: ScannedSkippedEntry[]
  totalBytes: number
  /** 非空=硬性超限(文件数/总量),整包拒收 */
  breach: string | null
}

/** 来源目录扫描(递归):收录随卡文件清单;符号链接逐条跳过(防引用出包),超单文件上限跳过,
 *  文件数/总量超限记 breach 整包拒收。不读文件内容——尺寸判定只看 lstat。 */
export function scanSourceTree(root: string): SourceScanResult {
  const files: ScannedAssetFile[] = []
  const skipped: ScannedSkippedEntry[] = []
  let totalBytes = 0
  let breach: string | null = null
  const walk = (dir: string, rel: string): void => {
    if (breach) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      skipped.push({ rel: rel || '.', reason: '目录读不了(权限),整段跳过' })
      return
    }
    for (const entry of entries) {
      if (breach) return
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (SKIPPED_TREE_ENTRIES.has(entry.name)) {
        skipped.push({ rel: childRel, reason: '噪音目录/系统文件,不入岛' })
        continue
      }
      const childPath = path.join(dir, entry.name)
      let st: fs.Stats
      try {
        st = fs.lstatSync(childPath)
      } catch {
        skipped.push({ rel: childRel, reason: '取不到文件信息,跳过' })
        continue
      }
      if (st.isSymbolicLink()) {
        skipped.push({ rel: childRel, reason: '符号链接不入岛(防引用出包)' })
        continue
      }
      if (st.isDirectory()) {
        walk(childPath, childRel)
        continue
      }
      if (!st.isFile()) {
        skipped.push({ rel: childRel, reason: '非常规文件,跳过' })
        continue
      }
      // 先判单件跳过、再判件数/总量(口径:超单件的记清单不计数,不该把整包顶到拒收)
      if (st.size > IMPORT_ASSET_MAX_FILE_BYTES) {
        skipped.push({
          rel: childRel,
          reason: `单个文件 ${(st.size / 1024).toFixed(0)}KB 超上限(${IMPORT_ASSET_MAX_FILE_BYTES / 1024}KB),跳过`
        })
        continue
      }
      if (files.length >= IMPORT_ASSET_MAX_FILES) {
        breach = `随卡文件超过 ${IMPORT_ASSET_MAX_FILES} 个,整包拒收;请精简技能包后重试。`
        return
      }
      if (totalBytes + st.size > IMPORT_ASSET_MAX_TOTAL_BYTES) {
        breach = `随卡文件合计超过 ${(IMPORT_ASSET_MAX_TOTAL_BYTES / 1024 / 1024).toFixed(0)}MB,整包拒收;请精简技能包后重试。`
        return
      }
      files.push({ rel: childRel, size: st.size })
      totalBytes += st.size
    }
  }
  walk(root, '')
  return { files, skipped, totalBytes, breach }
}

/** 人话文件量:清单/审批卡用 */
export function assetVolumeText(files: ScannedAssetFile[]): string {
  if (files.length === 0) return '无(纯文字卡)'
  const kb = Math.max(1, Math.round(files.reduce((n, f) => n + f.size, 0) / 1024))
  return `${files.length} 个文件 / 约 ${kb}KB`
}

/**
 * 随卡文件的清单段(拼进卡正文尾部):相对布局原样重建 + 根路径交代 + 执行口径。
 * 所有安装者的工作区里目录名一致,一份静态清单对全员成立(安装即复制,拍板)。
 */
export function buildImportedManifestSection(
  dirName: string,
  files: ScannedAssetFile[],
  skipped: ScannedSkippedEntry[]
): string {
  if (files.length === 0 && skipped.length === 0) return ''
  const lines = [
    '',
    '――――――',
    '随卡文件(岛主导入时一并带入,原样布局):',
    `文件已放到你的工作区「技能/${dirName}/」下;本卡正文里提到的相对路径(如 scripts/xxx.py)都以该目录为根。`,
    ...files.map((f) => `· ${f.rel}`),
    ...skipped.map((s) => `· ${s.rel}(未带入:${s.reason})`),
    '运行脚本或命令一律用 run_command(默认在你的工作区里跑);按你的权限档位,需要岛主过目的会先弹审批卡。'
  ]
  return lines.join('\n')
}
