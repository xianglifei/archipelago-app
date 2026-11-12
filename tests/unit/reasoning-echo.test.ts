import { describe, it, expect } from 'vitest'
import { reasoningEchoValue } from '../../src/main/llm'

/**
 * A(方案 2026-11-06 §3/§7.4):DeepSeek 思考模式 reasoning_content 回传取值策略。
 * 挂字段仅当「字段显式出现过(含空串)」且「干净收尾(finish=stop/tool_calls)」;
 * 截断流(length/content_filter)与从未思考过的步一律不挂。
 */
describe('reasoningEchoValue', () => {
  it('思考+tool_calls 干净收尾:回传累计原文', () => {
    expect(reasoningEchoValue({ reasoning: '先比较十分位…', sawReasoning: true, finishReason: 'tool_calls' })).toBe('先比较十分位…')
  })

  it('思考+stop 干净收尾:回传累计原文', () => {
    expect(reasoningEchoValue({ reasoning: '推完了', sawReasoning: true, finishReason: 'stop' })).toBe('推完了')
  })

  it('字段显式出现但内容为空串:回传空串(空串也是合法原样,与不挂字段区分)', () => {
    expect(reasoningEchoValue({ reasoning: null, sawReasoning: true, finishReason: 'tool_calls' })).toBe('')
  })

  it('从未出现过该字段(非思考步):不挂', () => {
    expect(reasoningEchoValue({ reasoning: null, sawReasoning: false, finishReason: 'tool_calls' })).toBeUndefined()
    expect(reasoningEchoValue({ reasoning: '残留', sawReasoning: false, finishReason: 'stop' })).toBeUndefined()
  })

  it('截断流(length/content_filter/缺 finish)不回传:内容不保证原样', () => {
    expect(reasoningEchoValue({ reasoning: '推到一半', sawReasoning: true, finishReason: 'length' })).toBeUndefined()
    expect(reasoningEchoValue({ reasoning: '推到一半', sawReasoning: true, finishReason: 'content_filter' })).toBeUndefined()
    expect(reasoningEchoValue({ reasoning: '推到一半', sawReasoning: true, finishReason: null })).toBeUndefined()
  })
})
