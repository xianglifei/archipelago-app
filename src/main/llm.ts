// OpenAI 兼容协议客户端(群岛通道 / DeepSeek 自带 Key 共用),主进程内使用;支持流式与工具调用
import { net } from 'electron'
import { currentSeaToken, seaRelayBaseUrl } from './auth'
import { getProvider } from '@shared/providers'
import { getApiKey } from './secrets'
import { decideRetry, FIRST_BYTE_TIMEOUT_MS, type RetryBudget } from './upstream-retry'
import { normalizeErrorCode } from './error-code'

/** 后台 LLM 调用(记忆反哺/档案管家/上下文压缩/群聊)统一取凭证:
 *  群岛通道=会话令牌 + SEA 派生端点;自带 Key 通道(BYOK)=secrets.json 里的 DeepSeek Key。
 *  两边切档由设置页的切档事务把存量居民一起刷成新 provider,这里只按 bot.providerId 分流。 */
export function llmCredentials(providerId: string): { baseUrl: string; apiKey: string | null } {
  if (providerId === 'archipelago') {
    return { baseUrl: seaRelayBaseUrl(), apiKey: currentSeaToken() }
  }
  const provider = getProvider(providerId)
  return { baseUrl: provider?.baseUrl ?? '', apiKey: getApiKey(providerId) ?? null }
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** 多模态分段(2026-10-29 图片输入):OpenAI 兼容格式,与字符串正文并存于 user 消息 */
export type LlmContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** 消息正文的字符量(用量校准用):数组时只数文本段,图片按 0 计(视觉 token 由服务端用量回传统计) */
export function llmContentChars(content: string | LlmContentPart[]): number {
  if (typeof content === 'string') return content.length
  return content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0)
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LlmContentPart[]
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  /** A(2026-11-06):DeepSeek 思考模式要求带过 reasoning_content 的 assistant 消息回传时原样带上;
   *  仅群岛通道(上游 DeepSeek)在回合内回放时挂(见 reasoningEchoValue),其余供应商不透传专有字段 */
  reasoning_content?: string
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: LlmMessage[]
  tools?: ToolSpec[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** 附加请求头(群岛通道带 x-island-uid 便于运营对账) */
  headers?: Record<string, string>
}

/** 群岛通道结构化错误:服务端 403 insufficient_credits 等带 error.code 的响应 */
export class RelayError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number
  ) {
    super(message)
  }
}

/** 超长错误(B3):模型/中转侧判定输入超过上下文窗口。
 *  单聊与群聊捕获后同步强制压缩并重试一次,而不是让用户对着「对话中断,请重试」死循环 */
export class ContextTooLongError extends Error {}

/** 判定一段错误文本是否属于超长:优先结构化 code,其次中英关键词。
 *  注意保持收敛——"payload too large"(请求体超限,如超大附件)、内容审核、限频都不属于
 *  超长,误吞会白白触发一次付费强制压缩重试、还给用户误导文案 */
const CONTEXT_TOO_LONG_PATTERNS: RegExp[] = [
  /context length/i,
  /context[\s_-]?(length|exceed)/i, // 结构化 code 形态:context_length_exceeded 等
  /context window/i,
  /maximum context/i,
  /prompt is too long/i,
  /tokens?.{0,10}exceed|exceed.{0,14}tokens?/i,
  // 中文:主语(上下文/输入)必须带长度/窗口/超限类宾语,或「超出」必须指向输入/上下文/长度——
  // 裸「上下文」会误吞内容审核类(「上下文中包含违规内容」),裸「超出…限制」会误吞限频类(「超出频率限制」)
  /上下文.{0,6}(长度|窗口|上限|限制|超限|超出|过长|过大)/,
  /输入过长|输入.{0,4}超出|(超过|超出).{0,4}(上下文|最大长度|长度限制)/
]

export function isContextTooLongText(text: string): boolean {
  return CONTEXT_TOO_LONG_PATTERNS.some((re) => re.test(text))
}

export interface UsageInfo {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ChatResult {
  content: string
  reasoning: string | null
  toolCalls: ToolCall[] | null
  /** 末个分块的结束原因('stop'/'length'/…):缺省 null;摘要压缩用它拒绝截断的摘要落盘 */
  finishReason: string | null
  /** 上游在本响应中显式出现过 reasoning_content 字段(含空串)——与「从未有该字段」区分,A 回传取值的前提 */
  sawReasoning: boolean
  /** 本响应的用量(部分供应商流式不回传则为 null):供 token 估算校准 */
  usage: UsageInfo | null
}

/** A(2026-11-06)回传取值策略:字段显式出现过且干净收尾(finish=stop/tool_calls;length/content_filter
 *  等截断流的内容不保证原样,不回传)→ 回传累计原文(可能为空串,空串也是合法原样);
 *  否则 undefined(不挂字段,非思考步的回复本就无法定义,不带即合法)。供应商分叉在调用侧。 */
export function reasoningEchoValue(result: Pick<ChatResult, 'reasoning' | 'sawReasoning' | 'finishReason'>): string | undefined {
  if (!result.sawReasoning) return undefined
  if (result.finishReason !== 'stop' && result.finishReason !== 'tool_calls') return undefined
  return result.reasoning ?? ''
}

export interface StreamCallbacks {
  onDelta?: (text: string) => void
  onReasoning?: (text: string) => void
  /** 收到 SSE 注释行(DeepSeek 排队期持续下发 : keep-alive):连接活着、模型还没开始出字 */
  onActivity?: () => void
}

function buildBody(req: ChatRequest, stream: boolean): string {
  return JSON.stringify({
    model: req.model,
    messages: req.messages,
    stream,
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {})
  })
}

async function post(req: ChatRequest, stream: boolean): Promise<Response> {
  // net.fetch 跟随系统代理(undici 全局 fetch 不认代理,sea 通道在需代理出网的机器上直连超时,
  // 兜底成「对话中断,请重试」;2026-10-27 dev 实测直连 000/走代理 401 定位)
  let res: Response
  try {
    res = await net.fetch(`${req.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
        ...(req.headers ?? {})
      },
      body: buildBody(req, stream),
      signal: req.signal
    })
  } catch (err) {
    // 停止键/外部中止语义照常传播(runToolLoop 的 aborted 判定看 signal,不认这类包装);
    // 网络层异常(本机断网/DNS/代理抖动)包成结构化码,进上游瞬时故障重试码表
    if (req.signal?.aborted) throw err
    throw new RelayError(`网络连接失败:${err instanceof Error ? err.message : String(err)}`, 'network_error', 0)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let code = ''
    let message = ''
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
      code = parsed?.error?.code ?? ''
      message = parsed?.error?.message ?? ''
    } catch {
      /* 非 JSON 按普通错误 */
    }
    // 超长优先于其他归类(B3):无论结构化 code 还是裸文本,命中即抛 ContextTooLongError
    if (isContextTooLongText(`${code} ${message} ${text}`.slice(0, 500))) {
      throw new ContextTooLongError(message || `模型服务返回 ${res.status}:${text.slice(0, 300)}`)
    }
    // 自带 Key 的两类硬故障按 HTTP 状态归一;429 不覆盖中转站的 upstream_429(见 normalizeErrorCode)
    const normalized = normalizeErrorCode(res.status, code)
    if (normalized) throw new RelayError(message || `模型服务返回 ${res.status}`, normalized, res.status)
    throw new Error(`模型服务返回 ${res.status}:${text.slice(0, 300)}`)
  }
  return res
}

interface StreamDelta {
  choices?: {
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

interface NonStreamMessage {
  choices?: {
    message?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

function toUsage(raw: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): UsageInfo | null {
  if (!raw || typeof raw.total_tokens !== 'number') return null
  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
    totalTokens: raw.total_tokens
  }
}

/** 流式对话:SSE 逐行解析,回调增量;返回完整结果(含工具调用)。
 *  上游瞬时故障自动重试(方案 2026-11-03 拍板):可重试码 + 零输出时按退避序列整体重发,
 *  预算由调用方(runToolLoop 全回合一份)透传;首字超时的流中断同样走重试 */
export async function chatStream(
  req: ChatRequest,
  callbacks: StreamCallbacks = {},
  retry?: { budget?: RetryBudget }
): Promise<ChatResult> {
  let attempt = 0
  // 零输出闸的观察点:任何内容性增量(正文/思考/工具调用)都算「已产出」,跨尝试保留——
  // 第一尝试吐过字后中断,重发会把已进时间线的内容重复一遍
  let sawOutput = false
  for (;;) {
    try {
      return await chatStreamOnce(req, callbacks, () => {
        sawOutput = true
      })
    } catch (err) {
      const code = err instanceof RelayError ? err.code : ''
      const decision = decideRetry(code, sawOutput, attempt, retry?.budget?.used ?? 0)
      if (!decision.retry || req.signal?.aborted) throw err
      if (retry?.budget) retry.budget.used++
      attempt++
      await sleepAbortable(decision.delayMs, req.signal)
    }
  }
}

/** 首字节超时 + 单次流式对话:chatStream 的重试单元 */
async function chatStreamOnce(req: ChatRequest, callbacks: StreamCallbacks, markOutput: () => void): Promise<ChatResult> {
  // 首字节超时(方案 4):流建立起 60s 无首个内容性 chunk(keep-alive 注释行不算,排队≠健康)→
  // abort 并抛 first_byte_timeout(上层按可重试码整体重发);收到任何增量即解除定时器,
  // 之后不再有整体超时(长回合靠步数上限与停止键管)。计时用墙钟,睡眠计入属合理(睡眠中同样零产出)
  const timeoutController = new AbortController()
  let firstByteTimedOut = false
  const bridgeAbort = (): void => timeoutController.abort(req.signal?.reason)
  if (req.signal) {
    if (req.signal.aborted) bridgeAbort()
    else req.signal.addEventListener('abort', bridgeAbort, { once: true })
  }
  const firstByteTimer = setTimeout(() => {
    firstByteTimedOut = true
    timeoutController.abort(new Error('first byte timeout'))
  }, FIRST_BYTE_TIMEOUT_MS)
  firstByteTimer.unref?.()
  const clearFirstByte = (): void => clearTimeout(firstByteTimer)
  try {
    const res = await post({ ...req, signal: timeoutController.signal }, true)
    if (!res.body) throw new Error('模型服务未返回数据流')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let reasoning = ''
    let sawReasoning = false
    const toolAcc: ToolCall[] = []
    let finishReason: string | null = null
    let usage: UsageInfo | null = null
    let firstByte = true
    // 首个内容性增量:解除首字超时定时器 + 标记已产出(零输出闸)
    const markFirstByte = (): void => {
      if (!firstByte) return
      firstByte = false
      clearFirstByte()
      markOutput()
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineAt: number
      while ((newlineAt = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineAt).trim()
        buffer = buffer.slice(newlineAt + 1)
        if (line.startsWith(':')) {
          callbacks.onActivity?.()
          continue
        }
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const parsed = JSON.parse(payload) as StreamDelta
          // usage/finish_reason 在结束分块上,该分块常无 delta——必须先取再走 delta 短路
          const chunkFinish = parsed.choices?.[0]?.finish_reason
          if (chunkFinish) finishReason = chunkFinish
          usage = toUsage(parsed.usage) ?? usage
          const delta = parsed.choices?.[0]?.delta
          if (!delta) continue
          // 字段显式出现即标记(含空串):A 回传取值要与「从未有该字段」区分
          if (typeof delta.reasoning_content === 'string') sawReasoning = true
          if (delta.reasoning_content) {
            markFirstByte()
            reasoning += delta.reasoning_content
            callbacks.onReasoning?.(delta.reasoning_content)
          }
          if (delta.content) {
            markFirstByte()
            content += delta.content
            callbacks.onDelta?.(delta.content)
          }
          if (delta.tool_calls) {
            markFirstByte()
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0
              toolAcc[i] = toolAcc[i] ?? { id: '', name: '', arguments: '' }
              if (tc.id) toolAcc[i].id = tc.id
              if (tc.function?.name && !toolAcc[i].name) toolAcc[i].name = tc.function.name
              if (tc.function?.arguments) toolAcc[i].arguments += tc.function.arguments
            }
          }
        } catch {
          // 忽略无法解析的 SSE 行(心跳等)
        }
      }
    }

    const toolCalls = toolAcc
      .filter((t) => t.name)
      .map((t, i) => ({ ...t, id: t.id || `call_${i}` }))

    return {
      content,
      reasoning: reasoning || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      finishReason,
      sawReasoning,
      usage
    }
  } catch (err) {
    if (firstByteTimedOut) {
      // 首字超时转结构化码(status 504 语义),进重试码表;最终失败显示人话「模型服务响应超时」
      throw new RelayError('模型服务响应超时,请稍后再试', 'first_byte_timeout', 504)
    }
    throw err
  } finally {
    clearFirstByte()
    req.signal?.removeEventListener('abort', bridgeAbort)
  }
}

/** 可中断的退避等待:停止键在等待期打断重试(runToolLoop 的 aborted 判定看 signal,错误形态不重要) */
function sleepAbortable(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms)
    timer.unref?.()
    if (!signal) return
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** 非流式对话:连通测试、主 Bot 入住欢迎、上下文管家摘要 */
export async function chatOnce(req: ChatRequest): Promise<ChatResult> {
  const res = await post(req, false)
  const json = (await res.json()) as NonStreamMessage
  const choice = json.choices?.[0]
  const message = choice?.message
  const toolCalls =
    message?.tool_calls
      ?.filter((tc) => tc.function?.name)
      .map((tc, i) => ({
        id: tc.id || `call_${i}`,
        name: tc.function!.name!,
        arguments: tc.function!.arguments ?? '{}'
      })) ?? null
  return {
    content: message?.content ?? '',
    reasoning: message?.reasoning_content ?? null,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
    finishReason: choice?.finish_reason ?? null,
    sawReasoning: typeof message?.reasoning_content === 'string',
    usage: toUsage(json.usage)
  }
}

/** 带超时的 AbortSignal 组合 */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms)
  timer.unref?.()
  const clear = () => clearTimeout(timer)
  controller.signal.addEventListener('abort', clear, { once: true })
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason)
    } else {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
    }
  }
  return controller.signal
}
