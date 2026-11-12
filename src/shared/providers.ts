import type { ModelInfo, ProviderInfo } from './types'

// 0.9 起客户端只走群岛通道(积分计费,注册即送):baseUrl 在主进程按环境覆盖(auth.seaRelayBaseUrl,
// 本地联调 SEA_BASE_URL=http://127.0.0.1:8787),key=登录会话令牌(不落 secrets.json)。
// 智谱/DeepSeek 自带 Key 通道保留定义作逃生舱(极端故障时热修版临时打开),UI 已全部隐藏。
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
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    models: [
      { id: 'glm-5.3', label: 'GLM-5.3(旗舰)', contextWindow: 1_000_000 },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash(轻快,约旗舰 1/10 价格)', contextWindow: 1_000_000 }
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
