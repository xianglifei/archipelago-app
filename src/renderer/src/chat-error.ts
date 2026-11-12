// 聊天错误码 → 人话(2026-11-03 上游故障修复批):中转站结构化 code 决定文案。
// 背景:上游故障时用户只见「上游返回错误」(服务端 message 原文),既零信息也排不了障——
// code 明明已随事件下发却被丢弃。未识别 code 仍透传主进程 fallback(协议类/登录类文案原样最准)。
// upstream_* 后缀括注 code 留给内测期排障(用户截图即可定位 upstream_503 等),正式期可撤。
// first_byte_timeout / network_error 为客户端本地码(首字超时/本机网络断,2026-11-03 重试机制)。
import type { TFunction } from 'i18next'

export function chatErrorText(t: TFunction, code: string | undefined, fallback: string): string {
  if (code === 'insufficient_credits') return t('chat.errInsufficient')
  if (code === 'rate_limited') return t('chat.errRateLimited')
  if (code === 'first_byte_timeout') return `${t('chat.errTimeout')}(${code})`
  if (code === 'network_error') return t('chat.errNetwork')
  if (code?.startsWith('upstream_')) return `${t('chat.errUpstream')}(${code})`
  return fallback
}
