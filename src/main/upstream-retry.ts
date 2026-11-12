// 上游瞬时故障重试判定(方案 doc/方案 - 上游瞬时故障重试与首字节超时 - 2026-11-03.md,七点拍板全按推荐):
// 上游过载秒拒(5xx/429)与网络抖动是自愈型瞬时故障,直接弹错等于让用户当重试器
// (2026-11-03 杨柳案例:4 次手动重发全落在故障窗口内)。码表/退避/预算/判定全部纯逻辑化,
// llm.chatStream 只做循环(与 turn-guard 同款拆分,单测同源)。
// 零输出闸:仅「一个字节都没收到就失败」的请求才整体重发——已吐字后中断不重试(内容可能已进时间线,重发会重复)。

/** 每请求最多重试 2 次(共 3 次尝试):瞬时抖动 1 次即过;持续故障窗口内多试只拖长等待 */
export const MAX_RETRIES_PER_REQUEST = 2

/** 每回合(runToolLoop 全程)累计重试 ≤6 次:防 100 步极端场景下每步都撞时重试放大回合时长 */
export const MAX_RETRIES_PER_TURN = 6

/** 流首字节超时(方案 4):流建立起 60s 无首个内容性 chunk(keep-alive 注释行不算,排队≠健康——
 *  2026-11-03 案例挂 182s 期间 keep-alive 一直活着)。稳态首字 1.35s 的 44 倍余量,远小于痛点 182s */
export const FIRST_BYTE_TIMEOUT_MS = 60_000

/** 回合级重试预算:runToolLoop 顶部创建一次,全程透传;used 只增不减 */
export interface RetryBudget {
  used: number
}

export function createRetryBudget(): RetryBudget {
  return { used: 0 }
}

/** 可重试码表:上游 5xx(过载/内部错误)+ 上游 429(平台限速)+ relay↔上游网络断(upstream_error)
 *  + 客户端↔中转站网络断(network_error,post 内包装)+ 首字超时(first_byte_timeout)。
 *  4xx(请求本身问题,重试必败且掩盖问题)、insufficient_credits/rate_limited(中转站自身拦截)一律不重试 */
export function isUpstreamRetryableCode(code: string): boolean {
  if (code === 'upstream_error' || code === 'network_error' || code === 'first_byte_timeout' || code === 'upstream_429') {
    return true
  }
  return /^upstream_5\d\d$/.test(code)
}

/** 退避序列:普通 1s→3s;上游 429 加倍 2s→6s(次数超出表长兜底取末值,noUncheckedIndexedAccess 安全) */
export function retryDelayMs(code: string, attempt: number): number {
  const table = code === 'upstream_429' ? [2_000, 6_000] : [1_000, 3_000]
  return table[Math.min(attempt, table.length - 1)] ?? 3_000
}

/** 单次失败后的重试决策(纯函数):四闸全过才重试——码表 / 零输出 / 单请求次数 / 回合预算 */
export function decideRetry(
  code: string,
  sawOutput: boolean,
  attempt: number,
  budgetUsed: number
): { retry: boolean; delayMs: number } {
  if (!isUpstreamRetryableCode(code)) return { retry: false, delayMs: 0 }
  if (sawOutput) return { retry: false, delayMs: 0 }
  if (attempt >= MAX_RETRIES_PER_REQUEST) return { retry: false, delayMs: 0 }
  if (budgetUsed >= MAX_RETRIES_PER_TURN) return { retry: false, delayMs: 0 }
  return { retry: true, delayMs: retryDelayMs(code, attempt) }
}
