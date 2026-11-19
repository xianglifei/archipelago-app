// 提示词工程化 FR-1(方案 - 系统提示词工程化 2026-11-18)纯函数契约:
// 时间锚三件套不落库、只依赖入参——同输入必须逐字稳定,这是「不打散 provider
// prompt cache 前缀」的机制前提,单独锁死;管家提示词是固定常量,golden 锁漂移;
// promptTokensBySection(FR3)按段累加,压缩事件 tokensBySection 的口径由此锚定。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '@shared/types'
import {
  currentTimeLine,
  familiarOf,
  gapMarker,
  promptTokensBySection,
  timeAnchor
} from '../../src/main/steward'
import { buildStewardUserPrompt, STEWARD_SYSTEM_PROMPT } from '../../src/main/prompts'
import { DENIED_BYPASS_LINE } from '../../src/main/approval-lines'

const ROOT = join(__dirname, '..', '..', 'src', 'main')

const msg = (kind: ChatMessage['kind']): ChatMessage => ({
  id: 1,
  sessionId: 's',
  role: 'user',
  content: '',
  reasoning: null,
  createdAt: '2026-11-18T09:00:00',
  kind
})

describe('timeAnchor:绝对时间锚', () => {
  it('本地时区字段拼装(无 Z 后缀按本地解析,测试与时区无关)', () => {
    expect(timeAnchor('2026-11-18T09:05:00')).toBe('11-18(周三) 09:05')
    expect(timeAnchor('2026-01-01T00:00')).toBe('01-01(周四) 00:00')
  })
})

describe('gapMarker:间隔标记行边界', () => {
  it('同刻/时钟回拨不插(防出负数时长)', () => {
    expect(gapMarker('2026-11-18T10:00:00', '2026-11-18T10:00:00')).toBeNull()
    expect(gapMarker('2026-11-18T10:00:00', '2026-11-18T09:59:00')).toBeNull()
  })
  it('间隔不足且未跨自然日不插', () => {
    expect(gapMarker('2026-11-18T10:00:00', '2026-11-18T10:20:00')).toBeNull()
  })
  it('间隔不足但跨自然日必插(深夜断档)', () => {
    expect(gapMarker('2026-11-18T23:50:00', '2026-11-19T00:10:00')).toBe(
      '[—— 已过约 20 分钟 · 以下是 11-19(周四) 00:10 起的对话 ——]'
    )
  })
  it('人性化间隔档位:分钟/小时/天+余小时', () => {
    expect(gapMarker('2026-11-18T10:00:00', '2026-11-18T10:45:00')).toBe(
      '[—— 已过约 45 分钟 · 以下是 11-18(周三) 10:45 起的对话 ——]'
    )
    expect(gapMarker('2026-11-18T10:00:00', '2026-11-18T13:00:00')).toBe(
      '[—— 已过约 3 小时 · 以下是 11-18(周三) 13:00 起的对话 ——]'
    )
    expect(gapMarker('2026-11-17T10:00:00', '2026-11-18T22:00:00')).toBe(
      '[—— 已过约 1 天 12 小时 · 以下是 11-18(周三) 22:00 起的对话 ——]'
    )
  })
  it('非法时间输入不插(历史脏数据不炸装配)', () => {
    expect(gapMarker('not-a-date', '2026-11-18T10:00:00')).toBeNull()
  })
})

describe('currentTimeLine:当前时间公告', () => {
  it('固定 Date 逐字稳定(数组尾部公告,变化只落在最后几十 token)', () => {
    expect(currentTimeLine(new Date(2026, 10, 18, 9, 5))).toBe('[当前时间:2026-11-18(周三) 09:05]')
  })
})

describe('familiarOf:熟络档位判定', () => {
  it('只数 chat/relation 行,达标即升温', () => {
    const chats = Array.from({ length: 40 }, () => msg('chat'))
    expect(familiarOf(chats)).toBe(true)
    expect(familiarOf(chats.slice(1))).toBe(false)
    // 工具/思考行不计入:40 条 tool 行 + 39 条 chat 仍不达标
    expect(familiarOf([...Array.from({ length: 40 }, () => msg('tool')), ...chats.slice(1)])).toBe(false)
  })
})

describe('STEWARD_SYSTEM_PROMPT:管家提示词 golden', () => {
  it('逐字锁定(措辞变更须显式更新本快照)', () => {
    expect(STEWARD_SYSTEM_PROMPT).toBe(
      [
        '你是群岛的上下文管家。你的唯一任务:把一段对话压缩成检查点摘要,供该对话的 Bot 之后继续工作。',
        '要求:',
        '- 400 字以内;',
        '- 首行用()标注本次压缩对话的时间范围,如「(10-20 至 10-26)」;与旧摘要合并时以新对话的时间范围为准,旧摘要里的日期保留;',
        '- 保留:任务目标、关键决定、数字与事实、用户原话中的重要要求和偏好、未完成事项;重要事件尽量带上日期;',
        '- 用户说过的重要原话保留逐字引用;',
        '- 只输出摘要本身,不要任何前言后语。'
      ].join('\n')
    )
  })
  it('管家 user prompt:旧摘要前缀合入,无旧摘要直进正文', () => {
    expect(buildStewardUserPrompt(null, 'T')).toBe('【需要压缩的对话】\nT')
    expect(buildStewardUserPrompt('旧', 'T')).toBe('【已有旧摘要,请合并进来】\n旧\n\n【需要压缩的对话】\nT')
  })
})

describe('DENIED_BYPASS_LINE:审批防绕过尾句(2026-11-19 借 Linger)', () => {
  it('golden 逐字锁定(拒绝挡的是同一效果:禁原样重试+禁绕过+唯一出路岛主自己来)', () => {
    expect(DENIED_BYPASS_LINE).toBe(
      '不要原样重试,也不要改用别的工具、脚本或写法去达到同一效果;确需执行,请岛主自己来。'
    )
  })
  it('源码契约:run_command/写围栏/MCP 三处执行类拒绝必须引用该常量(管理类工具不在此列)', () => {
    for (const rel of ['shell.ts', 'fs-tools.ts', 'mcp.ts']) {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      expect(src, `${rel} 应引用 DENIED_BYPASS_LINE`).toContain('${DENIED_BYPASS_LINE}')
    }
    // S2 权限档位行持有同一语义的完整版(与常量同调),锁关键词防单边漂移
    const prompts = readFileSync(join(ROOT, 'prompts.ts'), 'utf8')
    expect(prompts).toContain('不要改用别的工具或写法去达到同一效果')
  })
})

describe('promptTokensBySection:段级 token 估算(FR3)', () => {
  it('按段名累加,同名段合并;未校准 key 走 1.4 字符比兜底', () => {
    const out = promptTokensBySection('key-unseen', [
      { name: 'stable', text: 'a'.repeat(140) }, // 140/1.4 = 100
      { name: 'runtime', text: 'b'.repeat(70) }, // 70/1.4 = 50
      { name: 'stable', text: 'c'.repeat(7) } // ceil(7/1.4)=5,并入 stable
    ])
    expect(out).toEqual({ stable: 105, runtime: 50 })
  })
  it('空段列表返回空对象(全空提示不产噪音字段)', () => {
    expect(promptTokensBySection('k', [])).toEqual({})
  })
})
