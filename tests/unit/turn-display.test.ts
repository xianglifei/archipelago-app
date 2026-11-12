import { describe, it, expect } from 'vitest'
import { buildDisplay, type DisplayItem } from '../../src/renderer/src/utils/turn-display'
import type { ChatMessage } from '@shared/types'

// 静默回信「回信中」签纯逻辑冒烟(#34,2026-11-05):B 处理来信的思考/旁白/工具行
// 收进一粒运行签、回复落地整签消失、崩溃残留按停止口径保留、定时任务孤儿行不受影响。
// 真态来源=buildDisplay 第二参 replyActive(主进程 turnKind==='relation'|'digest' 的投影)。

let seq = 0
const msg = (over: Partial<ChatMessage> & Pick<ChatMessage, 'role'>): ChatMessage => {
  seq++
  return {
    id: seq,
    sessionId: 's1',
    content: '',
    reasoning: null,
    createdAt: new Date(Date.parse('2026-11-05T10:00:00Z') + seq * 1000).toISOString(),
    ...over
  }
}

const kindOf = (items: DisplayItem[]): string[] => items.map((d) => d.type)
const silentOf = (items: DisplayItem[]) =>
  items.filter((d): d is Extract<DisplayItem, { type: 'silentTurn' }> => d.type === 'silentTurn')

/** B 视角一次典型来信→回信:B 收到 A 的信(dir='in'),静默回合跑出过程行,最后落回复行 */
function letterExchange(opts: { reply: boolean; noReply?: boolean }) {
  const exchangeId = 'ex-1'
  const turnId = 'T-silent'
  const rows = [
    msg({ role: 'user', kind: 'relation', exchangeId, meta: { dir: 'in', peer: 'A' }, content: '[来自 A] 你好' }),
    msg({ role: 'assistant', kind: 'reasoning', turnId, reasoning: '想想怎么回' }),
    msg({ role: 'assistant', kind: 'note', turnId, reasoning: '先看看档案' }),
    msg({ role: 'assistant', kind: 'tool', turnId, meta: { toolName: 'read_file', status: 'done' } })
  ]
  if (opts.reply) {
    rows.push(
      msg({
        role: 'assistant',
        kind: 'relation',
        exchangeId,
        turnId,
        meta: opts.noReply
          ? { dir: 'reply', peer: 'A', noReply: true }
          : { dir: 'reply', peer: 'A' },
        content: opts.noReply ? '' : '[回复 A] 好的'
      })
    )
  }
  return rows
}

describe('静默回信「回信中」签(turn-display,#34)', () => {
  it('进行中:过程行收进运行签,不再逐条铺在消息流', () => {
    const items = buildDisplay(letterExchange({ reply: false }), true)
    expect(kindOf(items)).toEqual(['exchange', 'silentTurn'])
    const sign = silentOf(items)[0]!
    expect(sign.running).toBe(true)
    expect(sign.group.timeline.map((t) => t.kind)).toEqual(['reasoning', 'note', 'tool'])
    // 没有任何散落的过程行
    expect(items.some((d) => d.type === 'message')).toBe(false)
  })

  it('已决审批回执同收进签(2026-11-06 修复):全自动放行签不再逃签居中摊开;挂起审批仍独立可见', () => {
    const exchangeId = 'ex-ap'
    const turnId = 'T-ap'
    const rows = [
      msg({ role: 'user', kind: 'relation', exchangeId, meta: { dir: 'in', peer: 'A' }, content: '[来自 A] 帮个忙' }),
      msg({ role: 'assistant', kind: 'tool', turnId, meta: { toolName: 'run_command', status: 'done' } }),
      // 全自动放行回执(dev 实测 2026-11-06:曾独立成行、居中摊开、回复落地又消失)
      msg({
        role: 'assistant',
        kind: 'approval',
        turnId,
        meta: {
          approvalId: 'ap-1',
          toolName: 'run_command',
          title: '请求执行命令',
          detail: 'rm -rf /tmp/x',
          reason: '递归或强制删除文件,删了难以找回',
          status: 'auto-approved'
        }
      }),
      // 同回合里还有一张挂起中的审批卡(半自动档会撞上)
      msg({
        role: 'assistant',
        kind: 'approval',
        turnId,
        meta: {
          approvalId: 'ap-2',
          toolName: 'write_file',
          title: '请求写入文件',
          detail: '/tmp/probe.mjs',
          reason: '这个位置在 TA 平时的工作文件夹之外',
          status: 'pending'
        }
      })
    ]
    const items = buildDisplay(rows, true)
    const sign = silentOf(items)[0]!
    expect(sign.running).toBe(true)
    expect(sign.group.timeline.map((t) => t.kind)).toEqual(['tool', 'approval'])
    // 散行只剩挂起审批(恒独立可见),放行回执不再逃签
    const loose = items.filter((d) => d.type === 'message')
    expect(loose).toHaveLength(1)
    expect((loose[0] as Extract<DisplayItem, { type: 'message' }>).message.meta).toMatchObject({
      approvalId: 'ap-2'
    })
  })

  it('空窗期:来信已到、还没有第一条思考行,也亮空运行签(计秒从送达时刻起)', () => {
    const items = buildDisplay(
      [msg({ role: 'user', kind: 'relation', exchangeId: 'ex-2', meta: { dir: 'in', peer: 'A' } })],
      true
    )
    const sign = silentOf(items)[0]!
    expect(sign.running).toBe(true)
    expect(sign.group.timeline).toHaveLength(0)
  })

  it('回复落地:整签让位(空组+非运行,渲染端不显示),过程行全部折进私信浮窗', () => {
    const items = buildDisplay(letterExchange({ reply: true }), false)
    const sign = silentOf(items)[0]!
    expect(sign.running).toBe(false)
    expect(sign.group.timeline).toHaveLength(0)
    // 过程行不再出现在消息流(silentTurnIds 已收走)
    expect(items.some((d) => d.type === 'message')).toBe(false)
    // 交流签的行集包含 来信+回复 两行
    const ex = items.find((d): d is Extract<DisplayItem, { type: 'exchange' }> => d.type === 'exchange')!
    expect(ex.rows).toHaveLength(2)
  })

  it('无回复标记落地:同样整签让位(处理过但没回上来)', () => {
    const items = buildDisplay(letterExchange({ reply: true, noReply: true }), false)
    const sign = silentOf(items)[0]!
    expect(sign.running).toBe(false)
    expect(sign.group.timeline).toHaveLength(0)
    expect(items.some((d) => d.type === 'message')).toBe(false)
  })

  it('崩溃残留(回复行没落地、真态也没在回):过程行保留在签内,按停止口径展示', () => {
    const items = buildDisplay(letterExchange({ reply: false }), false)
    const sign = silentOf(items)[0]!
    expect(sign.running).toBe(false)
    expect(sign.group.timeline.map((t) => t.kind)).toEqual(['reasoning', 'note', 'tool'])
    expect(items.some((d) => d.type === 'message')).toBe(false)
  })

  it('定时任务等无用户消息的回合:孤儿过程行不受本改动影响,仍逐条独立展示', () => {
    const rows = [
      msg({ role: 'assistant', kind: 'reasoning', turnId: 'T-task', reasoning: '任务开始' }),
      msg({ role: 'assistant', kind: 'tool', turnId: 'T-task', meta: { toolName: 'write_file', status: 'done' } }),
      msg({ role: 'assistant', kind: 'chat', turnId: 'T-task', content: '任务完成', meta: { taskId: 'tk' } })
    ]
    for (const active of [false, true]) {
      const items = buildDisplay(rows, active)
      expect(kindOf(items)).toEqual(['message', 'message', 'message'])
      expect(silentOf(items)).toHaveLength(0)
    }
  })

  it('归属切断:来信未回期间用户/居民正文开口后,后续孤儿行不再归给旧来信', () => {
    const rows = [
      ...letterExchange({ reply: false }).slice(0, 2), // 'in' 行 + 一条思考行
      msg({ role: 'user', kind: 'chat', turnId: 'U1', content: '在忙吗' }),
      msg({ role: 'assistant', kind: 'reasoning', turnId: 'U1', reasoning: '嗯' }),
      msg({ role: 'assistant', kind: 'chat', turnId: 'U1', content: '在回信呢' }),
      msg({ role: 'assistant', kind: 'tool', turnId: 'T-other', meta: { toolName: 'read_file', status: 'done' } })
    ]
    const items = buildDisplay(rows, false)
    // 前半:来信签(残留,含第一条思考行);中间:正常用户回合组;末尾孤儿工具行散排
    const sign = silentOf(items)[0]!
    expect(sign.running).toBe(false)
    expect(sign.group.timeline.map((t) => t.kind)).toEqual(['reasoning'])
    const turn = items.find((d): d is Extract<DisplayItem, { type: 'turn' }> => d.type === 'turn')
    expect(turn?.group.userMessage?.content).toBe('在忙吗')
    expect(turn?.group.anchor?.content).toBe('在回信呢')
    const loose = items.filter((d) => d.type === 'message')
    expect(loose).toHaveLength(1)
  })

  it('通报在 B 忙时入队:当前回合 anchor 落地后消化的过程行,仍收进来信的运行签', () => {
    const rows = [
      msg({ role: 'user', kind: 'chat', turnId: 'U1', content: '在忙吗' }),
      // 岛主正与 B 对话期间 A 发来通报:'in' 行先落地,消化回合等 B 空闲
      msg({ role: 'user', kind: 'relation', exchangeId: 'ex-d', meta: { dir: 'in', peer: 'A' } }),
      msg({ role: 'assistant', kind: 'chat', turnId: 'U1', content: '在呢' }),
      // B 空闲后消化通报:过程行 + 回复行
      msg({ role: 'assistant', kind: 'reasoning', turnId: 'T-d', reasoning: '知道了' }),
      msg({
        role: 'assistant',
        kind: 'relation',
        exchangeId: 'ex-d',
        turnId: 'T-d',
        meta: { dir: 'reply', peer: 'A', noReply: true }
      })
    ]
    // 消化进行中:真态在回(digest),签亮运行态且收住了 anchor 之后的过程行
    const mid = buildDisplay(rows.slice(0, 4), true)
    const sign = silentOf(mid)[0]!
    expect(sign.running).toBe(true)
    expect(sign.group.timeline.map((t) => t.kind)).toEqual(['reasoning'])
    // 消化完毕:回复行落地,整签让位
    const done = buildDisplay(rows, false)
    expect(silentOf(done)[0]!.group.timeline).toHaveLength(0)
    expect(done.some((d) => d.type === 'message')).toBe(false)
  })

  it('新来信接棒:旧来信残留保持停止态,只有最新待回来信可能亮运行签', () => {
    const rows = [
      msg({ role: 'user', kind: 'relation', exchangeId: 'ex-a', meta: { dir: 'in', peer: 'A' } }),
      msg({ role: 'assistant', kind: 'reasoning', turnId: 'T-a', reasoning: '回一半崩了' }),
      msg({ role: 'user', kind: 'relation', exchangeId: 'ex-b', meta: { dir: 'in', peer: 'C' } }),
      msg({ role: 'assistant', kind: 'reasoning', turnId: 'T-b', reasoning: '正在回' })
    ]
    const items = buildDisplay(rows, true)
    const signs = silentOf(items)
    expect(signs).toHaveLength(2)
    expect(signs[0]!.group.exchangeId).toBe('ex-a')
    expect(signs[0]!.running).toBe(false)
    expect(signs[0]!.group.timeline.map((t) => t.kind)).toEqual(['reasoning'])
    expect(signs[1]!.group.exchangeId).toBe('ex-b')
    expect(signs[1]!.running).toBe(true)
    expect(signs[1]!.group.timeline.map((t) => t.kind)).toEqual(['reasoning'])
  })
})

describe('回合折叠既有行为回归(turn-display 抽出后不变形)', () => {
  it('常规用户回合:过程行折进时间线,正文收口', () => {
    const rows = [
      msg({ role: 'user', kind: 'chat', turnId: 'U1', content: '帮我看看' }),
      msg({ role: 'assistant', kind: 'reasoning', turnId: 'U1', reasoning: '想想' }),
      msg({ role: 'assistant', kind: 'tool', turnId: 'U1', meta: { toolName: 'web_search', status: 'done' } }),
      msg({ role: 'assistant', kind: 'chat', turnId: 'U1', content: '查到了' })
    ]
    const items = buildDisplay(rows, true)
    expect(kindOf(items)).toEqual(['turn'])
    const g = items[0] as Extract<DisplayItem, { type: 'turn' }>
    expect(g.group.userMessage?.content).toBe('帮我看看')
    expect(g.group.anchor?.content).toBe('查到了')
    expect(g.group.timeline.map((t) => t.kind)).toEqual(['reasoning', 'tool'])
  })

  it('发起方回合里的私信(dir=out)折进该回合时间线,不产生回信签', () => {
    const rows = [
      msg({ role: 'user', kind: 'chat', turnId: 'U1', content: '去问下 B' }),
      msg({
        role: 'assistant',
        kind: 'relation',
        exchangeId: 'ex-c',
        turnId: 'U1',
        meta: { dir: 'out', peer: 'B' },
        content: '[发给 B] 在吗'
      }),
      msg({
        role: 'assistant',
        kind: 'relation',
        exchangeId: 'ex-c',
        turnId: 'U1',
        meta: { dir: 'reply-in', peer: 'B' },
        content: '[来自 B 的回复] 在'
      }),
      msg({ role: 'assistant', kind: 'chat', turnId: 'U1', content: 'B 说在' })
    ]
    const items = buildDisplay(rows, true)
    expect(kindOf(items)).toEqual(['turn'])
    expect(silentOf(items)).toHaveLength(0)
    const g = items[0] as Extract<DisplayItem, { type: 'turn' }>
    expect(g.group.timeline.map((t) => t.kind)).toEqual(['exchange'])
  })
})

describe('兜底组用户消息可见性(旧消息无 turnId)', () => {
  it('无 turnId 的用户消息挂上兜底组本体,不再被整条吞掉(改名通知等场景)', () => {
    const rows = [
      msg({ role: 'user', kind: 'chat', content: '(岛务通知:你改名了)' }), // 无 turnId
      msg({ role: 'assistant', kind: 'chat', content: '知道了' })
    ]
    const items = buildDisplay(rows, false)
    const g = items.find((d) => d.type === 'turn') as Extract<DisplayItem, { type: 'turn' }> | undefined
    expect(g).toBeTruthy()
    expect(g?.group.userMessage?.content).toBe('(岛务通知:你改名了)')
    expect(g?.group.anchor?.content).toBe('知道了')
  })

  it('有 turnId 的常规回合不受影响', () => {
    const rows = [
      msg({ role: 'user', kind: 'chat', turnId: 'U9', content: '你好' }),
      msg({ role: 'assistant', kind: 'chat', turnId: 'U9', content: '你好呀' })
    ]
    const items = buildDisplay(rows, false)
    const g = items[0] as Extract<DisplayItem, { type: 'turn' }>
    expect(g.group.userMessage?.content).toBe('你好')
  })
})
