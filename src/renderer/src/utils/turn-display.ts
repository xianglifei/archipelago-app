import type { ApprovalMeta, ChatMessage, RelationMeta } from '@shared/types'

// 聊天消息流 → 展示结构(回合折叠方案 C 的纯逻辑核,自 ChatView 抽出供单测):
// 一次「用户消息 → 思考/工具/私信过程行 → 最终回复」是一个回合,出结果后过程默认整体收起;
// 新数据按 turnId 分组,旧消息无 turnId 按位置推导兜底;静默回信(B 处理来信)的过程行折进私信浮窗。
// 静默回信进行中(#34,2026-11-05):回复行还没落地的来信,其静默回合过程行按位置收进
// 它名下一粒「回信中」运行签,不再逐条铺在消息流;回复行落地整签让位(过程照旧折进浮窗)。

/** 回合时间线项:过程行或一次私信交流,sortId 取首行 id 保序 */
export type TimelineItem =
  | { sortId: number; kind: 'reasoning'; message: ChatMessage }
  | { sortId: number; kind: 'reasoningText'; text: string }
  | { sortId: number; kind: 'note'; message: ChatMessage }
  | { sortId: number; kind: 'tool'; message: ChatMessage }
  | { sortId: number; kind: 'approval'; message: ChatMessage }
  | { sortId: number; kind: 'relation'; message: ChatMessage }
  | { sortId: number; kind: 'exchange'; exchangeId: string; rows: ChatMessage[] }

/** 一个回合:用户消息 + 过程时间线 + 最终(或部分)正文 */
export interface TurnGroup {
  key: string
  turnId?: string
  userMessage?: ChatMessage
  anchor?: ChatMessage
  timeline: TimelineItem[]
}

/** 静默回信的临时组(#34):某封已送达、回复行未落地的来信,其回信回合过程行收在这;
 *  startAt=来信行时间(签上计秒的起点,空窗期无过程行也照走) */
export interface SilentTurnGroup {
  key: string
  exchangeId: string
  startAt: string
  timeline: TimelineItem[]
}

export type DisplayItem =
  | { type: 'turn'; group: TurnGroup }
  | { type: 'silentTurn'; group: SilentTurnGroup; running: boolean }
  | { type: 'exchange'; exchangeId: string; rows: ChatMessage[] }
  | { type: 'message'; message: ChatMessage }

export const isActionItem = (item: TimelineItem): boolean =>
  item.kind === 'tool' || item.kind === 'exchange' || item.kind === 'approval' || item.kind === 'relation'

function relationDir(m: ChatMessage): string | undefined {
  return m.kind === 'relation' ? (m.meta as RelationMeta | undefined)?.dir : undefined
}

/** 回合起止毫秒:起点=用户消息(存量兜底组取首条过程行);终点=正文消息(无正文取末条过程行) */
export function timelineEdgeMs(group: TurnGroup, edge: 'start' | 'end'): number {
  const datedAt = (item: TimelineItem): string | null =>
    item.kind === 'reasoningText'
      ? null
      : item.kind === 'exchange'
        ? (item.rows[0] ?? item.rows[item.rows.length - 1])?.createdAt ?? null
        : item.message.createdAt
  if (edge === 'start') {
    if (group.userMessage) return Date.parse(group.userMessage.createdAt)
    for (const item of group.timeline) {
      const at = datedAt(item)
      if (at) return Date.parse(at)
    }
    return 0
  }
  if (group.anchor) return Date.parse(group.anchor.createdAt)
  for (const item of [...group.timeline].reverse()) {
    const at = datedAt(item)
    if (at) return Date.parse(at)
  }
  return 0
}

/**
 * @param replyingActive 主进程真态:该居民当前有静默回信回合(relation/digest)在跑。
 *  只有「真态在回 + 回复行未落地」的签亮运行态;其余(崩溃残留/历史孤儿)按停止口径交给渲染端。
 */
export function buildDisplay(messages: ChatMessage[], replyingActive = false): DisplayItem[] {
  // 静默回信回合:私信回复行(含「无回复」标记)携带的 turnId——这些回合的过程行折进私信浮窗,不独立成组
  const silentTurnIds = new Set<string>()
  for (const m of messages) {
    if (m.kind === 'relation' && m.exchangeId && m.turnId && relationDir(m) === 'reply') {
      silentTurnIds.add(m.turnId)
    }
  }

  const groups = new Map<string, TurnGroup>()
  const allGroups: TurnGroup[] = [] // 含存量位置兜底组,后处理(置顶补思考/排序)要覆盖到它们
  const exchanges = new Map<string, ChatMessage[]>()
  const display: DisplayItem[] = []
  const emittedGroups = new Set<string>()
  const emittedExchanges = new Set<string>()
  // 位置兜底:最近一条用户消息开启的「开着的组」——旧消息无 turnId,过程行按位置归进它;
  // 正文(anchor)落地后关闭。审批回执行至今不带 turnId,新数据也靠它归组
  let openGroup: TurnGroup | null = null
  // 静默回信进行中(#34):最近一封已送达、回复行还没落地的来信。它的回信回合没有用户消息、
  // 过程行无组可归——按位置收进这粒签;回复行落地/岛主开口/新来信接棒即关闭
  // (居民自己的正文落地不关:忙时入队的通报在 anchor 之后才消化,过程行仍要收进来)。
  // 关闭后,后面的孤儿行维持逐条独立展示,定时任务等场景不受本改动影响
  let pendingReply: SilentTurnGroup | null = null
  let pendingReplyItem: Extract<DisplayItem, { type: 'silentTurn' }> | null = null

  const emitGroupOnce = (g: TurnGroup): void => {
    if (!emittedGroups.has(g.key)) {
      emittedGroups.add(g.key)
      display.push({ type: 'turn', group: g })
    }
  }

  for (const m of messages) {
    if (m.kind === 'chat' && m.role === 'user') {
      // 岛主开口=叙事翻页:这封来信的回信过程行不再往签里收(用户回合与静默回信并发时维持散排旧状)
      pendingReply = null
      pendingReplyItem = null
      if (m.turnId && !silentTurnIds.has(m.turnId)) {
        let g = groups.get(m.turnId)
        if (!g) {
          g = { key: `turn:${m.turnId}`, turnId: m.turnId, timeline: [] }
          groups.set(m.turnId, g)
          allGroups.push(g)
        }
        g.userMessage = m
        openGroup = g
        emitGroupOnce(g)
      } else {
        // 兜底组同样要挂上用户消息本体:否则这条消息没有任何展示路径(改名通知等无 turnId 的
        // user 行会整条消失);过程行照旧按位置折进它名下
        openGroup = { key: `legacy:${m.id}`, timeline: [], userMessage: m }
        allGroups.push(openGroup)
        emitGroupOnce(openGroup)
      }
      continue
    }

    if (m.kind === 'chat' && m.role === 'assistant') {
      // 居民正文落地不关归属:通报在 B 忙时入队、当前回合结束后才消化,
      // 消化回合的过程行落在 anchor 之后,仍要收进来信的「回信中」签
      const g = m.turnId && !silentTurnIds.has(m.turnId) ? groups.get(m.turnId) : undefined
      if (g) {
        g.anchor = m
        emitGroupOnce(g)
      } else if (openGroup) {
        openGroup.anchor = m
      } else {
        display.push({ type: 'message', message: m })
      }
      // 正文落地,回合收口;之后的散行独立展示,直到下一条用户消息
      openGroup = null
      continue
    }

    if (m.kind === 'relation' && m.exchangeId) {
      let rows = exchanges.get(m.exchangeId)
      if (!rows) {
        rows = []
        exchanges.set(m.exchangeId, rows)
      }
      rows.push(m)
      if (!emittedExchanges.has(m.exchangeId)) {
        emittedExchanges.add(m.exchangeId)
        // 归属:发起方回合的私信(行带发起方 turnId)折进该回合时间线;静默/存量私信独立成签
        const owner = m.turnId && !silentTurnIds.has(m.turnId) ? groups.get(m.turnId) : undefined
        if (owner) {
          owner.timeline.push({ sortId: m.id, kind: 'exchange', exchangeId: m.exchangeId, rows })
          emitGroupOnce(owner)
        } else {
          display.push({ type: 'exchange', exchangeId: m.exchangeId, rows })
          // 私信开始意味着上一个回合的叙事已结束,别再把后面的散行归进旧组
          openGroup = null
          // 收到来信(dir='in' 且不属于任何本地回合):挂一粒静默回信签占位,回信过程行往里收;
          // 空窗期(还没出第一条思考行)也照常亮签,回复落地或叙事翻页才收走
          if (relationDir(m) === 'in') {
            const sg: SilentTurnGroup = {
              key: `silent:${m.exchangeId}`,
              exchangeId: m.exchangeId,
              startAt: m.createdAt,
              timeline: []
            }
            const item: Extract<DisplayItem, { type: 'silentTurn' }> = { type: 'silentTurn', group: sg, running: false }
            display.push(item)
            pendingReply = sg
            pendingReplyItem = item
          }
        }
      } else if (relationDir(m) === 'reply' && pendingReply?.exchangeId === m.exchangeId) {
        // 回复行落地:整签让位——签内过程行已被 silentTurnIds 收进私信浮窗,渲染端见空组即不显示
        pendingReply = null
        pendingReplyItem = null
      }
      continue
    }

    // 挂起中的审批签永远独立可见(不折)
    if (m.kind === 'approval' && (m.meta as ApprovalMeta | undefined)?.status === 'pending') {
      display.push({ type: 'message', message: m })
      continue
    }

    // 过程行:思考 / 工具 / 已决审批回执 / 旧版无 exchangeId 的私信行
    if (m.turnId && silentTurnIds.has(m.turnId)) continue // 静默回信的过程行在私信浮窗里看
    const g = m.turnId ? groups.get(m.turnId) : openGroup
    const item: TimelineItem | null =
      m.kind === 'reasoning'
        ? { sortId: m.id, kind: 'reasoning', message: m }
        : m.kind === 'note'
          ? { sortId: m.id, kind: 'note', message: m }
          : m.kind === 'tool'
          ? { sortId: m.id, kind: 'tool', message: m }
          : m.kind === 'approval'
            ? { sortId: m.id, kind: 'approval', message: m }
            : m.kind === 'relation'
              ? { sortId: m.id, kind: 'relation', message: m }
              : null
    if (g && item) {
      g.timeline.push(item)
      emitGroupOnce(g)
    } else if (item) {
      // 孤儿过程行:回合无组可归(静默回信/定时任务等无用户消息的回合)。
      // 来信待回时,思考/旁白/工具行收进「回信中」签;已决审批回执同收(2026-11-06 修复:
      // 全自动放行签曾漏收、独立成行且居中摊开,回复落地又消失);挂起审批在上方分支恒独立可见;
      // 其余(定时任务回合等)维持逐条独立展示
      if (
        pendingReply &&
        (m.kind === 'reasoning' || m.kind === 'note' || m.kind === 'tool' || m.kind === 'approval')
      ) {
        pendingReply.timeline.push(item)
      } else {
        // 进行中的静默回信还没有回复行:过程行实时独立可见,回复落地后折进私信浮窗
        display.push({ type: 'message', message: m })
      }
    }
  }

  // 存量兜底:旧回合没有分步思考行,但最终消息的 reasoning 字段存了整块思考——置顶补一块
  for (const g of allGroups) {
    if (g.anchor?.reasoning && !g.timeline.some((t) => t.kind === 'reasoning')) {
      g.timeline.unshift({ sortId: -1, kind: 'reasoningText', text: g.anchor.reasoning })
    }
  }
  for (const g of allGroups) g.timeline.sort((a, b) => a.sortId - b.sortId)

  // 运行态判定(#34):主进程真态说还在回信、这封来信也确实还没等到回复行,才亮「回信中」;
  // 回合死在半路(崩溃/重启)的残留签保持停止口径(渲染端默认展开,过程不吞)
  if (pendingReplyItem && pendingReply && replyingActive) pendingReplyItem.running = true
  return display
}
