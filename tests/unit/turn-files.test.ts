import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
import { countChangedLines } from 'src/main/fs-tools'
import {
  TURN_FILES_COLLAPSE,
  TURN_FILE_TOOLS,
  collectTurnFiles,
  sumTurnFileStats,
  type TurnFileEntry
} from 'src/renderer/src/utils/turn-files'
import type { TimelineItem } from 'src/renderer/src/utils/turn-display'
import type { ChatMessage, ToolEventMeta } from '@shared/types'

// 回合改动文件卡纯逻辑(2026-11-18 方案):行级增删统计(countChangedLines)+
// 时间线聚合(collectTurnFiles)+ 与主进程写分派的源码契约静态断言(防两处白名单漂移)。

let seq = 0
const msg = (over: Partial<ChatMessage>): ChatMessage => {
  seq++
  return {
    id: seq,
    sessionId: 's1',
    role: 'assistant',
    kind: 'tool',
    content: '',
    reasoning: null,
    createdAt: new Date(Date.parse('2026-11-18T10:00:00Z') + seq * 1000).toISOString(),
    ...over
  }
}

const toolItem = (meta: ToolEventMeta, id?: number): TimelineItem => ({
  sortId: id ?? seq,
  kind: 'tool',
  message: msg({ meta })
})

describe('countChangedLines(fs-tools 行级增删统计)', () => {
  it('新建文件(before=null)全部计增,空内容为 0', () => {
    expect(countChangedLines(null, 'a\nb\nc')).toEqual({ add: 3, del: 0 })
    expect(countChangedLines(null, '')).toEqual({ add: 0, del: 0 })
  })

  it('内容一致 → 0/0;末尾换行产生的空尾行不计数', () => {
    expect(countChangedLines('a\nb\nc', 'a\nb\nc')).toEqual({ add: 0, del: 0 })
    expect(countChangedLines('a\nb\nc\n', 'a\nb\nc')).toEqual({ add: 0, del: 0 })
  })

  it('整体清空计全删;纯追加计全增', () => {
    expect(countChangedLines('a\nb\nc', '')).toEqual({ add: 0, del: 3 })
    expect(countChangedLines('a\nb', 'a\nb\nc\nd')).toEqual({ add: 2, del: 0 })
  })

  it('局部替换:LCS 精确计增删', () => {
    // a b c → a X c:1 增 1 删
    expect(countChangedLines('a\nb\nc', 'a\nX\nc')).toEqual({ add: 1, del: 1 })
    // 中间删两行
    expect(countChangedLines('a\nb\nc\nd', 'a\nd')).toEqual({ add: 0, del: 2 })
  })

  it('CRLF 与 LF 等价计数', () => {
    expect(countChangedLines('a\r\nb\r\nc', 'a\nX\nc')).toEqual({ add: 1, del: 1 })
  })

  it('超限大文件退化袋交集:不出错、增删合计守恒(不卡写路径)', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `old-${i}`).join('\n')
    const after = ['head', ...Array.from({ length: 2500 }, (_, i) => `old-${i}`), 'tail'].join('\n')
    const diff = countChangedLines(before, after)
    expect(diff.del).toBeGreaterThan(0)
    expect(diff.add).toBeGreaterThan(0)
    // 公共行(old-*)在两份都出现 2500 行,精确保守:3000 - 2500 = 500 删,2502 - 2500 = 2 增
    expect(diff.del).toBe(500)
    expect(diff.add).toBe(2)
  })
})

describe('collectTurnFiles(时间线聚合)', () => {
  it('只收 write_file/edit_file 的 done 行;read/run 等不进清单', () => {
    const items: TimelineItem[] = [
      toolItem({ toolName: 'write_file', status: 'done', path: '/ws/a.ts' }),
      toolItem({ toolName: 'read_file', status: 'done', path: '/ws/a.ts' }),
      toolItem({ toolName: 'run_command', status: 'done' }),
      toolItem({ toolName: 'web_search', status: 'done' })
    ]
    const entries = collectTurnFiles(items)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.fileName).toBe('a.ts')
  })

  it('running 行不进清单(半截不渲染);failed 行不计入(拍板 D2)', () => {
    const items: TimelineItem[] = [
      toolItem({ toolName: 'write_file', status: 'running', path: '/ws/a.ts' }),
      toolItem({ toolName: 'write_file', status: 'failed', path: '/ws/b.ts' }),
      toolItem({ toolName: 'edit_file', status: 'done', path: '/ws/a.ts', add: 3, del: 1 })
    ]
    const entries = collectTurnFiles(items)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe('/ws/a.ts')
  })

  it('无 path 的行跳过;同路径去重保首次出现顺序并累加增删与次数', () => {
    const items: TimelineItem[] = [
      toolItem({ toolName: 'edit_file', status: 'done', path: '/ws/b.ts', add: 1, del: 2 }),
      toolItem({ toolName: 'write_file', status: 'done', path: '/ws/a.ts', add: 10, del: 0 }),
      toolItem({ toolName: 'edit_file', status: 'done', path: '/ws/a.ts', add: 0, del: 4 }),
      toolItem({ toolName: 'edit_file', status: 'done', add: 5, del: 5 })
    ]
    const entries = collectTurnFiles(items)
    expect(entries.map((e) => e.fileName)).toEqual(['b.ts', 'a.ts'])
    expect(entries[1]).toMatchObject({ add: 10, del: 4, count: 2 })
    expect(entries[0]!.count).toBe(1)
  })

  it('旧数据无 add/del(缺省 0)照样进清单;sumTurnFileStats 对全 0 返回 0/0', () => {
    const items: TimelineItem[] = [
      toolItem({ toolName: 'write_file', status: 'done', path: '/ws/legacy.md' })
    ]
    const entries = collectTurnFiles(items)
    expect(entries[0]).toMatchObject({ add: 0, del: 0, count: 1 })
    expect(sumTurnFileStats(entries)).toEqual({ add: 0, del: 0 })
  })

  it('文件名/目录切分:win 反斜杠与裸名;根路径目录为空', () => {
    const items: TimelineItem[] = [
      toolItem({ toolName: 'write_file', status: 'done', path: 'C:\\ws\\src\\x.ts' }),
      toolItem({ toolName: 'write_file', status: 'done', path: 'README.md' }),
      toolItem({ toolName: 'write_file', status: 'done', path: '/root-only.md' })
    ]
    const entries = collectTurnFiles(items)
    expect(entries[0]).toMatchObject({ fileName: 'x.ts', dirName: 'C:/ws/src' })
    expect(entries[1]).toMatchObject({ fileName: 'README.md', dirName: '' })
    expect(entries[2]).toMatchObject({ fileName: 'root-only.md', dirName: '' })
  })

  it('sumTurnFileStats 合计各条目;折叠阈值为 5(拍板 D3)', () => {
    const many: TurnFileEntry[] = Array.from({ length: 7 }, (_, i) => ({
      path: `/ws/f${i}.ts`,
      fileName: `f${i}.ts`,
      dirName: '/ws',
      add: 1,
      del: 0,
      count: 1
    }))
    expect(sumTurnFileStats(many)).toEqual({ add: 7, del: 0 })
    expect(TURN_FILES_COLLAPSE).toBe(5)
    expect(TURN_FILE_TOOLS).toEqual(['write_file', 'edit_file'])
  })
})

describe('源码契约静态断言(防白名单/统计链漂移)', () => {
  const fsToolsSrc = readFileSync(join(ROOT, 'src/main/fs-tools.ts'), 'utf8')
  const toolsSrc = readFileSync(join(ROOT, 'src/main/tools.ts'), 'utf8')
  const chatSrc = readFileSync(join(ROOT, 'src/main/chat.ts'), 'utf8')

  it('fs-tools 两个写工具都接收 statsOut 并回填 countChangedLines', () => {
    // writeFileTool 与 editFileTool 的签名与回填各出现一次
    expect(fsToolsSrc.match(/statsOut\?: \{ add\?: number; del\?: number \}/g)?.length).toBe(2)
    expect(fsToolsSrc.match(/countChangedLines\(beforeContent/g)?.length).toBe(2)
    // write 新建分支:全增统计
    expect(fsToolsSrc).toContain('countChangedLines(null, content)')
  })

  it('tools.ts 写分派把 fileStatsOut 透传给两个写工具;run_command 不透传', () => {
    expect(toolsSrc).toContain('writeFileTool(caller, args, deps.signal, scope, deps.execBase, deps.fileStatsOut)')
    expect(toolsSrc).toContain('editFileTool(caller, args, deps.signal, scope, deps.execBase, deps.fileStatsOut)')
    expect(toolsSrc).toContain('return runCommandTool(caller, args, deps.signal, scope, deps.execBase)')
  })

  it('chat.ts 分发点每次调用建新鲜统计出口,并把统计合进事件行 meta', () => {
    expect(chatSrc).toContain('fileStatsOut: fileStats')
    expect(chatSrc).toContain('fileStats.add !== undefined || fileStats.del !== undefined')
    expect(chatSrc).toContain('done: (result, metaPatch)')
  })

  it('渲染端聚合白名单与词典齐备(chat.turnFiles.*)', () => {
    const zh = readFileSync(join(ROOT, 'src/renderer/src/i18n/zh.ts'), 'utf8')
    const en = readFileSync(join(ROOT, 'src/renderer/src/i18n/en.ts'), 'utf8')
    for (const key of ['title', 'more', 'collapse', 'open', 'openMenu', 'openWithLabel', 'reveal']) {
      expect(zh).toMatch(new RegExp(`turnFiles: \\{[\\s\\S]*?${key}:`))
      expect(en).toMatch(new RegExp(`turnFiles: \\{[\\s\\S]*?${key}:`))
    }
  })
})
