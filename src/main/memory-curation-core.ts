// 夜间记忆整理纯核(方案 - Linger 借鉴三件套 2026-11-19,批次③):行协议解析、提案校验、
// 触发判定,全部纯函数零依赖——同 kanban-core 模式,单测直打本文件,编排(memory-curation.ts)
// 只做 IO 组合。设计借 Linger 夜间 wiki 的「结构化提案 + 程序校验」:模型只能对清单里已有
// 条目逐行提案,应用侧校验行号/行数/文本/变更上限,坏行丢弃不伤整批;归档与变更日志由程序写。

import type { MemoryEntry } from '@shared/types'

/** 单份清单一次整理最多动到的行数:夜间作业保守上限,防模型过度改写 */
export const CURATION_MAX_CHANGES = 8
/** 送进模型的最大条目数(取最近的):超长清单只整理尾部,头部原样保留 */
export const CURATION_WINDOW = 100
/** 新文本长度上限:与 addMemory 的 300 字截断同口径 */
export const CURATION_TEXT_CAP = 300

export type CurationProposal =
  | { kind: 'merge'; lines: number[]; text: string }
  | { kind: 'supersede'; line: number; text: string }
  | { kind: 'reject'; line: number; reason: string }

export interface CurationArchive {
  entry: MemoryEntry
  action: 'merge' | 'supersede' | 'reject'
  reason?: string
}

export interface CurationOutcome {
  /** 整理后的条目集(merge 结果落在首行位置,supersede 原位替换,日期都记 today) */
  entries: MemoryEntry[]
  /** 受影响行数(merge 计入其全部行) */
  changed: number
  /** 被移出/被替换的旧条目,由程序归档进 history 留痕 */
  archives: CurationArchive[]
  /** 校验不过被丢弃的原始提案行(只进观测,不落记忆) */
  invalid: string[]
}

/** 本地日期键 YYYY-MM-DD(触发判定的「今天」与整理条目的落行日期共用) */
export function localDateKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 解析整理模型的输出。done=只输出了 DONE(没有需要整理的);
 * 无法解析的行进 invalid,不阻断其余行的解析(坏行丢弃不伤整批)。
 */
export function parseCuration(content: string): { proposals: CurationProposal[]; done: boolean; invalid: string[] } {
  const lines = content
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const proposals: CurationProposal[] = []
  const invalid: string[] = []
  let done = false
  for (const line of lines) {
    if (line === 'DONE') {
      done = true
      continue
    }
    const parts = line.split('|')
    const head = parts[0]
    if (head === 'MERGE' && parts.length === 3) {
      const nums = parts[1]!
        .split(/[,，、\s]+/)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
      const uniq = [...new Set(nums)]
      const text = parts[2]!.trim()
      if (uniq.length >= 2 && text) proposals.push({ kind: 'merge', lines: uniq, text })
      else invalid.push(line)
    } else if (head === 'SUPERSEDE' && parts.length === 3) {
      const n = Number.parseInt(parts[1]!, 10)
      const text = parts[2]!.trim()
      if (Number.isInteger(n) && n > 0 && text) proposals.push({ kind: 'supersede', line: n, text })
      else invalid.push(line)
    } else if (head === 'REJECT' && parts.length === 3) {
      const n = Number.parseInt(parts[1]!, 10)
      const reason = parts[2]!.trim()
      if (Number.isInteger(n) && n > 0 && reason) proposals.push({ kind: 'reject', line: n, reason })
      else invalid.push(line)
    } else {
      invalid.push(line)
    }
  }
  return { proposals, done, invalid }
}

/**
 * 校验提案并对清单做整理规划(不落盘)。规则:
 * - 行号必须真实存在;同一行不得被两个提案引用(先到先得,后来者进 invalid);
 * - 新文本截断到 CURATION_TEXT_CAP,且不得与任何未被动到的条目逐字相同(防整理制造重复);
 * - REJECT 必须给理由;
 * - 全部提案受影响行数合计 ≤ CURATION_MAX_CHANGES,超限的整条提案丢弃;
 * - 拿不准=KEEP:不在任何提案里的条目原样保留。
 */
export function planCuration(entries: MemoryEntry[], proposals: CurationProposal[], today: string): CurationOutcome {
  const byLine = new Map(entries.map((e) => [e.line, e]))
  const taken = new Set<number>() // 已被某提案引用的行
  const kept = new Set(entries.map((e) => e.line)) // 幸存行(初始全保留,提案逐步移除)
  const mergedInto = new Map<number, string>() // 行 → 并入后的新文本(merge 首行 / supersede 该行)
  const archives: CurationArchive[] = []
  const invalid: string[] = []
  let changed = 0

  const untouchedTexts = new Set(entries.map((e) => e.text))

  const describe = (p: CurationProposal): string =>
    p.kind === 'merge' ? `MERGE|${p.lines.join(',')}|${p.text.slice(0, 40)}` : p.kind === 'supersede' ? `SUPERSEDE|${p.line}|${p.text.slice(0, 40)}` : `REJECT|${p.line}|${p.reason.slice(0, 40)}`

  for (const p of proposals) {
    const affectLines = p.kind === 'merge' ? p.lines : [p.line]
    // 行号存在 + 未被他案占用
    if (affectLines.some((n) => !byLine.has(n) || taken.has(n))) {
      invalid.push(describe(p))
      continue
    }
    // 变更上限:这条提案会超预算就整条丢弃(不截半条)
    if (changed + affectLines.length > CURATION_MAX_CHANGES) {
      invalid.push(describe(p))
      continue
    }
    if (p.kind === 'merge') {
      const text = p.text.slice(0, CURATION_TEXT_CAP)
      if (untouchedTexts.has(text)) {
        invalid.push(describe(p))
        continue
      }
      affectLines.forEach((n, i) => {
        taken.add(n)
        // 首行留在原位承载合并文本,其余行移除
        if (i > 0) kept.delete(n)
        else mergedInto.set(n, text)
        archives.push({ entry: byLine.get(n)!, action: 'merge' })
      })
      changed += affectLines.length
    } else if (p.kind === 'supersede') {
      const text = p.text.slice(0, CURATION_TEXT_CAP)
      if (untouchedTexts.has(text)) {
        invalid.push(describe(p))
        continue
      }
      taken.add(p.line)
      mergedInto.set(p.line, text) // 原位替换,行保留
      archives.push({ entry: byLine.get(p.line)!, action: 'supersede' })
      changed += 1
    } else {
      taken.add(p.line)
      kept.delete(p.line)
      archives.push({ entry: byLine.get(p.line)!, action: 'reject', reason: p.reason })
      changed += 1
    }
  }

  const out: MemoryEntry[] = []
  let nextLine = 1
  for (const e of entries) {
    if (!kept.has(e.line)) continue
    const text = mergedInto.get(e.line)
    out.push(text ? { line: nextLine++, date: today, text } : { line: nextLine++, date: e.date, text: e.text })
  }
  return { entries: out, changed, archives, invalid }
}

/**
 * 触发判定:开关开 + 有脏 scope + 已过当日触发点 + 今天还没跑过。
 * 「今天」按本地时区;应用整夜关机则次日开机后 60s 内补跑(触发点已过)。
 */
export function shouldRunCuration(
  now: Date,
  opts: { enabled: boolean; dirty: boolean; lastRunDate: string | null; hour: number; minute: number }
): boolean {
  if (!opts.enabled || !opts.dirty) return false
  if (opts.lastRunDate === localDateKey(now)) return false
  return now.getHours() > opts.hour || (now.getHours() === opts.hour && now.getMinutes() >= opts.minute)
}
