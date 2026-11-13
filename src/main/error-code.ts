// 非 2xx 响应的错误码归一(2026-11-13 BYOK)。纯函数单放:llm.ts 会连带加载 electron / auth,
// 单测不该为了一条码表把它们全拖进来(同 upstream-retry.ts 的拆法)。
//
// 自带 Key 的两类硬故障按 HTTP 状态归一,因为厂商的 error.code 五花八门(DeepSeek 的 402 也回
// invalid_request_error),只有状态码稳定;归一后渲染端才有一个稳定分流点——各一句人话 +
// 「换 Key / 切回群岛通道」两个逃生按钮(chat-error.ts)。
//
// 429 只在没有结构化 code 时补 rate_limited:中转站会带 upstream_429(上游限速,**可重试**,
// 见 upstream-retry.ts 的码表),把它覆盖成 rate_limited(平台自身拦截,不重试)会让既有的
// 退避重试失效(2026-11-13 codex 审查)。其余状态保持服务端原码不动。
export function normalizeErrorCode(status: number, code: string): string {
  if (status === 401) return 'key_invalid'
  if (status === 402) return 'key_insufficient'
  if (status === 429 && !code.startsWith('upstream_')) return 'rate_limited'
  return code
}
