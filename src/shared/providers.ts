import type { ModelInfo, ProviderInfo } from './types'

// 两条通道(2026-11-13 BYOK 拍板):
// - 群岛通道:默认档,积分计费。baseUrl 在主进程按环境覆盖(auth.seaRelayBaseUrl,本地联调
//   SEA_BASE_URL=http://127.0.0.1:8787),key=登录会话令牌(不落 secrets.json)。
// - DeepSeek 自带 Key:用户把 Key 存进 secrets.json,聊天不消耗积分。智谱通道已整条删除
//   (只覆盖 DeepSeek 一个预置,不做通用 OpenAI 兼容端点——拍板原话「通用但不精也不好」)。
// 两条通道的模型 id 同名,切通道不用重选模型,存量居民也不会因 id 对不上被兜到 128k 默认窗口。
export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'archipelago',
    label: '群岛通道',
    baseUrl: 'https://api.qundao.app/v1',
    keyUrl: '',
    models: [
      { id: 'deepseek-flash', label: '快速', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', label: '均衡', contextWindow: 1_000_000 }
    ]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro(旗舰)', contextWindow: 1_000_000 },
      { id: 'deepseek-flash', label: 'DeepSeek Flash(轻快低价)', contextWindow: 1_000_000 }
    ]
  }
]

export function getProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/** 查模型;目录里没有的(用户手填)按保守默认窗口处理(M11.2) */
export function findModel(providerId: string, modelId: string): ModelInfo {
  const provider = getProvider(providerId)
  const found = provider?.models.find((m) => m.id === modelId)
  if (found) return found
  return { id: modelId, label: modelId, contextWindow: 128_000 }
}
