import type { ToolEventMeta } from '@shared/types'
import type { TimelineItem } from './turn-display'

// 回合改动文件卡聚合(2026-11-18,方案 - 回合改动文件列表):
// 把回合时间线里 write_file/edit_file 的过程行按路径聚合成「一行一个文件」的清单。
// 纯逻辑、零 IPC:数据源 = 既有 kind='tool' 行的 meta(path/add/del),历史会话重放同一条路。
// 口径(拍板稿 S 系列):失败/未执行的写编不计入(D2);running 行不进清单(回合结束才齐);
// 排序 = 时间线出现顺序(居民做事顺序,同路径去重保首次);增删行数缺省(旧数据)按 0 计、
// 界面对 0/0 不渲染数字槽(诚实:没有数据就不显示,不造假数)。

/** 与主进程写类工具白名单(chat.ts toolEventLabelKey / tools.ts 写分派)互为静态契约,漂移由单测把关 */
export const TURN_FILE_TOOLS = ['write_file', 'edit_file'] as const

/** 列表折叠阈值:超过此行数收起为「其余 N 个」(拍板 D3=5) */
export const TURN_FILES_COLLAPSE = 5

/** 一个改动文件条目:同一文件本回合多次写/编合并为一行,增删行数累加 */
export interface TurnFileEntry {
  /** 写入/编辑的目标绝对路径(meta.path,已按工作区解析) */
  path: string
  /** 展示主文案:文件名(basename) */
  fileName: string
  /** 展示辅助文案:所在目录(dirname;根目录/裸名为空串) */
  dirName: string
  /** 本回合对该文件的累计增行数 */
  add: number
  /** 本回合对该文件的累计删行数 */
  del: number
  /** 本回合对该文件的动作次数(写+编) */
  count: number
}

function splitFileName(path: string): { fileName: string; dirName: string } {
  // 统一按 / 切(meta.path 可能来自 win 反斜杠路径);dirName 仅展示,归一化成正斜杠即可
  const normalized = path.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  if (idx < 0) return { fileName: normalized, dirName: '' }
  return { fileName: normalized.slice(idx + 1) || normalized, dirName: idx > 0 ? normalized.slice(0, idx) : '' }
}

function isWriteTool(toolName: string): boolean {
  return (TURN_FILE_TOOLS as readonly string[]).includes(toolName)
}

/** 回合时间线 → 改动文件清单(一行一个文件);无写类动作的回合返回空数组,调用方整块不渲染 */
export function collectTurnFiles(timeline: TimelineItem[]): TurnFileEntry[] {
  const byPath = new Map<string, TurnFileEntry>()
  for (const item of timeline) {
    if (item.kind !== 'tool') continue
    const meta = (item.message.meta as ToolEventMeta | undefined) ?? { toolName: '', status: 'done' as const }
    if (!isWriteTool(meta.toolName)) continue
    // running=该动作还没落笔;failed=动作失败没有产生改动(拍板 D2 不计入)
    if (meta.status !== 'done') continue
    if (!meta.path) continue
    const { fileName, dirName } = splitFileName(meta.path)
    const existing = byPath.get(meta.path)
    if (existing) {
      existing.add += meta.add ?? 0
      existing.del += meta.del ?? 0
      existing.count += 1
      continue
    }
    byPath.set(meta.path, {
      path: meta.path,
      fileName,
      dirName,
      add: meta.add ?? 0,
      del: meta.del ?? 0,
      count: 1
    })
  }
  return [...byPath.values()]
}

/** 卡头统计:全部条目的增删合计 */
export function sumTurnFileStats(entries: TurnFileEntry[]): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const entry of entries) {
    add += entry.add
    del += entry.del
  }
  return { add, del }
}
