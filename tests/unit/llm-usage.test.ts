import { describe, it, expect } from 'vitest'
import { toUsage } from '../../src/main/llm'

/**
 * P1a(方案 - 工具注入缓存稳定性 2026-11-19):usage 的缓存命中字段解析。
 * 两派形态并存——OpenAI 系(含 GLM)走 prompt_tokens_details.cached_tokens,DeepSeek 走
 * 顶层 prompt_cache_hit_tokens;端点未回传时 cachedPromptTokens=null(与「命中 0」区分,
 * 观测报表只统计有回传的样本)。usage 整体缺失或无 total_tokens 时照旧返回 null。
 */
describe('toUsage 缓存命中解析', () => {
  it('OpenAI 形:prompt_tokens_details.cached_tokens 命中', () => {
    expect(
      toUsage({
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_tokens_details: { cached_tokens: 800 }
      })
    ).toEqual({ promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cachedPromptTokens: 800 })
  })

  it('DeepSeek 形:顶层 prompt_cache_hit_tokens 命中', () => {
    expect(
      toUsage({
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_cache_hit_tokens: 640
      })
    ).toEqual({ promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cachedPromptTokens: 640 })
  })

  it('两派同在时 OpenAI 形优先(字段更结构化,判定不依赖隐式优先级漂移)', () => {
    expect(
      toUsage({
        prompt_tokens: 100,
        completion_tokens: 1,
        total_tokens: 101,
        prompt_cache_hit_tokens: 1,
        prompt_tokens_details: { cached_tokens: 99 }
      })?.cachedPromptTokens
    ).toBe(99)
  })

  it('端点未回传缓存字段:cachedPromptTokens=null——明确区分「未知」与「命中 0」', () => {
    const u = toUsage({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 })
    expect(u).toEqual({ promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cachedPromptTokens: null })
  })

  it('命中 0 是合法值(真回传了 0):不得折叠成 null', () => {
    expect(toUsage({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, prompt_tokens_details: { cached_tokens: 0 } })?.cachedPromptTokens).toBe(0)
  })

  it('usage 缺失或无 total_tokens:整体 null(部分端点流式不回传,沿既有口径)', () => {
    expect(toUsage(undefined)).toBeNull()
    expect(toUsage({ prompt_tokens: 10 })).toBeNull()
  })
})
