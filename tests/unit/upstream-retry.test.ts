import { describe, it, expect } from 'vitest'
import {
  MAX_RETRIES_PER_REQUEST,
  MAX_RETRIES_PER_TURN,
  FIRST_BYTE_TIMEOUT_MS,
  createRetryBudget,
  isUpstreamRetryableCode,
  retryDelayMs,
  decideRetry
} from '../../src/main/upstream-retry'

// 上游瞬时故障重试纯逻辑冒烟(2026-11-03 方案 - 上游瞬时故障重试与首字节超时,七点拍板全按推荐):
// 码表 = 上游 5xx/429 + 两段网络断(relay↔上游 upstream_error、客户端↔中转站 network_error)+ 首字超时;
// 四闸 = 码表 / 零输出 / 单请求次数(2)/ 回合预算(6);退避 = 1s→3s,429 加倍 2s→6s。

describe('isUpstreamRetryableCode:可重试码表', () => {
  it('上游 5xx 全系可重试', () => {
    for (const code of ['upstream_500', 'upstream_502', 'upstream_503', 'upstream_504', 'upstream_529']) {
      expect(isUpstreamRetryableCode(code)).toBe(true)
    }
  })

  it('网络断两段与首字超时可重试,上游 429 可重试', () => {
    expect(isUpstreamRetryableCode('upstream_error')).toBe(true) // relay↔上游网络断
    expect(isUpstreamRetryableCode('network_error')).toBe(true) // 客户端↔中转站网络断
    expect(isUpstreamRetryableCode('first_byte_timeout')).toBe(true) // 流首字 60s 超时
    expect(isUpstreamRetryableCode('upstream_429')).toBe(true)
  })

  it('4xx/中转站自身拦截/未知码/空串一律不重试', () => {
    for (const code of ['upstream_400', 'upstream_401', 'upstream_403', 'upstream_404', 'upstream_413', 'insufficient_credits', 'rate_limited', 'unauthorized', '']) {
      expect(isUpstreamRetryableCode(code)).toBe(false)
    }
  })
})

describe('retryDelayMs:退避序列', () => {
  it('普通码 1s→3s,次数超表长兜底取末值', () => {
    expect(retryDelayMs('upstream_503', 0)).toBe(1_000)
    expect(retryDelayMs('upstream_503', 1)).toBe(3_000)
    expect(retryDelayMs('upstream_503', 2)).toBe(3_000)
    expect(retryDelayMs('upstream_503', 99)).toBe(3_000)
  })

  it('上游 429 退避加倍 2s→6s', () => {
    expect(retryDelayMs('upstream_429', 0)).toBe(2_000)
    expect(retryDelayMs('upstream_429', 1)).toBe(6_000)
    expect(retryDelayMs('upstream_429', 5)).toBe(6_000)
  })
})

describe('decideRetry:四闸决策', () => {
  it('可重试码 + 零输出 + 次数与预算都有余 → 重试并给退避', () => {
    expect(decideRetry('upstream_503', false, 0, 0)).toEqual({ retry: true, delayMs: 1_000 })
    expect(decideRetry('upstream_429', false, 1, 3)).toEqual({ retry: true, delayMs: 6_000 })
  })

  it('零输出闸:已产出内容后失败不重试(重发会重复已进时间线的内容)', () => {
    expect(decideRetry('upstream_503', true, 0, 0).retry).toBe(false)
  })

  it('单请求次数闸:attempt 达上限不再重试', () => {
    expect(decideRetry('upstream_503', false, MAX_RETRIES_PER_REQUEST, 0).retry).toBe(false)
    expect(decideRetry('upstream_503', false, MAX_RETRIES_PER_REQUEST + 5, 0).retry).toBe(false)
  })

  it('回合预算闸:budgetUsed 达 6 后,即使本请求一次没试也不重试', () => {
    expect(decideRetry('upstream_502', false, 0, MAX_RETRIES_PER_TURN).retry).toBe(false)
  })

  it('预算闸在 5 时仍放行(第 6 次是最后一次)', () => {
    expect(decideRetry('upstream_502', false, 0, MAX_RETRIES_PER_TURN - 1).retry).toBe(true)
  })

  it('不可重试码四闸之外最先否决', () => {
    expect(decideRetry('upstream_400', false, 0, 0).retry).toBe(false)
    expect(decideRetry('', false, 0, 0).retry).toBe(false)
  })
})

describe('createRetryBudget:预算对象', () => {
  it('新建预算 used=0,只增不减由调用方维护', () => {
    const budget = createRetryBudget()
    expect(budget.used).toBe(0)
    budget.used++
    expect(budget.used).toBe(1)
  })
})

describe('常量取值(拍板口径)', () => {
  it('每请求 2 次 / 每回合 6 次 / 首字超时 60s', () => {
    expect(MAX_RETRIES_PER_REQUEST).toBe(2)
    expect(MAX_RETRIES_PER_TURN).toBe(6)
    expect(FIRST_BYTE_TIMEOUT_MS).toBe(60_000)
  })
})
