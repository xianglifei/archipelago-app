import type { ChatQuote, MessageAttachment } from './types'
import { quoteLines } from './quote-core'

// 对话导出 Markdown 纯逻辑(2026-11-02 多选消息导出):归一化行 → md 拼装。
// 主进程(main/export.ts)负责查库/读图/写文件,这里零 IO,tests/unit 同源冒烟。
// 口径见 doc/需求 - 对话导出Markdown(多选消息分享) - 2026-11-02.md §3.4:
// 导出的是「对话内容」——用户消息与居民正文,过程类(思考/工具/审批/私信)不导;
// 居民正文本来就是 markdown 源文本原样输出;用户消息渲染层是纯文本,行首控制字符转义防爆版式;
// 引用块复用 quote-core 的 quoteLines,与注入居民 prompt 的格式一字不差。
// 文档内标签(岛主/引用来源/附件记号)是居民世界文本,中文写死不随 UI 语言切换。

/** 导出产物大小硬上限(字符):图片 base64 全内联时的软保护,超限由主进程拦截提示 */
export const EXPORT_MAX_CHARS = 50 * 1024 * 1024

/** 归一化导出行:单聊(messages 表)与群聊(group_messages 表)不同构,查询侧各自投影成这一种 */
export interface ExportMessageRow {
  id: number
  /** 发言人显示名(岛主名或居民名);拼装时岛主行自动带「(岛主)」后缀 */
  speaker: string
  /** 岛主本人的消息 */
  isOwner: boolean
  content: string
  /** ISO 时间戳(库里的 UTC ISO,拼装时按本机时区格式化) */
  createdAt: string
  /** 用户消息携带的选区引用 */
  quotes?: ChatQuote[]
  /** 用户消息携带的附件 */
  attachments?: MessageAttachment[]
  /** 定时任务触发的居民消息(说话人行尾注记,解释「为什么 TA 当时开口」) */
  fromTask?: boolean
}

export interface ExportOptions {
  /** 会话描述,进头部元信息:如「与 Momo 的单聊」/「群聊 · 出海小队」 */
  conversation: string
  /** 导出时刻(ISO) */
  exportedAt: string
}

/** 本机时区 yyyy-MM-dd HH:mm(渲染层 formatStamp 是 i18n 词典口径,导出文档自成一格不共用) */
export function formatExportStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 用户消息行首 markdown 控制字符转义:渲染层用户气泡是纯文本,导出后要还原「纯文本」观感,
 * 防止随手一句「# 标题」/「1. 事项」/「*强调*」在文档里变成 H1/列表/斜体。
 * > 与 * 后面无论有没有空格都构成语法(>foo 是引用块、*foo* 是斜体),无条件转义;
 * # + - 与有序标记只在后跟空白/行尾时构成语法,无空格时保持字面不动。
 * 不动行中字符(用户引用代码片段时行中 # 不受影响)。
 */
export function escapeUserText(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let out = line.replace(/^(\s*)([>*])/, '$1\\$2')
      out = out.replace(/^(\s*)([#+-])(\s|$)/, '$1\\$2$3')
      out = out.replace(/^(\s*)(\d{1,9})([.)])(\s|$)/, '$1$2\\$3$4')
      return out
    })
    .join('\n')
}

/** 附件展示名清掉会炸 md 语法的方括号 */
function safeAlt(name: string): string {
  return name.replace(/[[\]]/g, ' ')
}

/**
 * 拼一条消息的 md 块:说话人行 → 引用块 → 正文 → 附件行。
 * 图片仅在 imageData 里带了该附件 path 的 dataURL 时内联 `![](data:...)`(主进程读原件、
 * 白名单校验后传入);读不到的图片降级为文件名标注,与文件/文件夹附件同待遇。
 */
function messageBlock(row: ExportMessageRow, imageData: Map<string, string>): string {
  const head = `**${row.speaker}${row.isOwner ? '(岛主)' : ''}** ${formatExportStamp(row.createdAt)}${
    row.fromTask ? ' · 定时任务' : ''
  }`
  const parts: string[] = [head]
  const quote = quoteLines(row.quotes)
  if (quote) parts.push(quote.trim())
  const body = row.isOwner ? escapeUserText(row.content.trim()) : row.content.trim()
  if (body) parts.push(body)
  for (const att of row.attachments ?? []) {
    if (att.kind === 'image') {
      const dataUrl = imageData.get(att.path)
      if (dataUrl) parts.push(`![${safeAlt(att.name)}](${dataUrl})`)
      else parts.push(`📷 ${safeAlt(att.name)}`)
    } else if (att.kind === 'dir') {
      parts.push(`📁 ${safeAlt(att.name)}`)
    } else {
      parts.push(`📎 ${safeAlt(att.name)}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * 拼整份导出文档:头部元信息(导出时间/会话/条数)→ 逐条消息块 → 文末署名。
 * 行按 id 升序排(跳选的中间消息直接缺位,不插省略标记——头部条数已说明是节选)。
 * 空 rows 返回空串,由主进程守卫「没有可导出的消息」。
 */
export function buildExportMarkdown(
  rows: ExportMessageRow[],
  options: ExportOptions,
  imageData: Map<string, string> = new Map()
): string {
  if (rows.length === 0) return ''
  const sorted = [...rows].sort((a, b) => a.id - b.id)
  const header = `> 由「群岛」导出 · ${formatExportStamp(options.exportedAt)} · ${options.conversation} · 共 ${sorted.length} 条`
  const blocks = sorted.map((row) => messageBlock(row, imageData))
  return [header, '', blocks.join('\n\n'), '', '---', '', '*由群岛(Archipelago)生成*'].join('\n')
}
