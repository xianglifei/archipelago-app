import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TFunction } from 'i18next'
import { chatErrorText } from '../../src/renderer/src/chat-error'
import { getProvider, PROVIDERS } from '../../src/shared/providers'
import { normalizeErrorCode } from '../../src/main/error-code'

const ROOT = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
/** key 原样回显的桩 t:断言「选了哪条词条」而不是中文文案本身(文案可改,分流不许漂) */
const t = ((key: string) => key) as unknown as TFunction

/**
 * BYOK(2026-11-13 拍板)回归:只做 DeepSeek 一个预置、401/402 只在自带 Key 下翻人话、
 * 积分门禁必须带 provider 守卫、切档必须刷存量居民。真库行为见 tests/integration/model-source.test.ts。
 */
describe('BYOK 通道目录(静态)', () => {
  it('只剩群岛通道 + DeepSeek 两条;智谱整条删除', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['archipelago', 'deepseek'])
    expect(getProvider('zhipu')).toBeUndefined()
  })
  it('两条通道模型 id 同名(切通道不用重选模型,不会被 findModel 兜到 128k)', () => {
    const relay = (getProvider('archipelago')?.models ?? []).map((m) => m.id).sort()
    const deepseek = (getProvider('deepseek')?.models ?? []).map((m) => m.id).sort()
    expect(deepseek).toEqual(relay)
  })
  it('智谱遗留只在 store.ts 的历史映射里出现(老库行不许变未知 provider)', () => {
    const files = ['src/main/web.ts', 'src/main/chat.ts', 'src/renderer/src/components/ModelSource.tsx']
    for (const f of files) expect(read(f)).not.toMatch(/zhipu|glm-5/)
    expect(read('src/main/store.ts')).toMatch(/provider_id IN \('zhipu','deepseek'\)/)
  })
})

describe('聊天错误分流(BYOK 硬故障)', () => {
  it('401 只在自带 Key 下翻成人话;群岛通道保持上游原文(那是登录态问题)', () => {
    expect(chatErrorText(t, 'key_invalid', 'raw 401', { byok: true })).toBe('chat.errKeyInvalid')
    expect(chatErrorText(t, 'key_invalid', 'raw 401')).toBe('raw 401')
  })
  it('402 只在自带 Key 下翻成人话', () => {
    expect(chatErrorText(t, 'key_insufficient', 'raw 402', { byok: true })).toBe('chat.errKeyInsufficient')
    expect(chatErrorText(t, 'key_insufficient', 'raw 402')).toBe('raw 402')
  })
  it('既有码不受影响', () => {
    expect(chatErrorText(t, 'insufficient_credits', 'x', { byok: true })).toBe('chat.errInsufficient')
    expect(chatErrorText(t, 'network_error', 'x', { byok: true })).toBe('chat.errNetwork')
    expect(chatErrorText(t, 'upstream_503', 'x')).toBe('chat.errUpstream(upstream_503)')
  })
})

describe('HTTP 状态 → 错误码归一(error-code)', () => {
  it('401/402 按状态归一(厂商自己的 code 不可靠)', () => {
    expect(normalizeErrorCode(401, 'invalid_request_error')).toBe('key_invalid')
    expect(normalizeErrorCode(402, 'invalid_request_error')).toBe('key_insufficient')
  })
  it('429 不覆盖中转站的 upstream_429(覆盖会让既有退避重试失效)', () => {
    expect(normalizeErrorCode(429, 'upstream_429')).toBe('upstream_429')
    expect(normalizeErrorCode(429, 'rate_limit_exceeded')).toBe('rate_limited')
    expect(normalizeErrorCode(429, '')).toBe('rate_limited')
  })
  it('其余状态保持服务端原码(积分不足/上游 5xx/登录类文案都不许被改道)', () => {
    expect(normalizeErrorCode(403, 'insufficient_credits')).toBe('insufficient_credits')
    expect(normalizeErrorCode(503, 'upstream_503')).toBe('upstream_503')
    expect(normalizeErrorCode(500, '')).toBe('')
  })
})

describe('积分门禁与切档的源码契约(静态)', () => {
  it('四处积分判断都带 byok 守卫(漏一处 0 积分的自带 Key 用户就发不出消息)', () => {
    const src = read('src/renderer/src/components/ChatView.tsx')
    expect(src).toContain('const byok = bot.providerId !== ')
    // 预警条(两档)+ 占位条 + 发送置灰 + send() 内的发送前拦截(第四处,原方案稿没列)
    expect(src).toContain('!byok && balance !== null && balance <= 0')
    expect(src).toContain('sendDisabled={!byok && balance !== null && balance <= 0}')
    expect(src).toContain('!byok && balance !== null && balance > 0')
    expect(src).toMatch(
      /if \(!byok && balance !== null && balance <= 0\) \{\n\s+(?:setErrorCode\(undefined\)\n\s+)?setError\(t\('chat\.errExhausted'\)\)/
    )
  })
  it('积分页自带 Key 下不顶低余额预警', () => {
    const src = read('src/renderer/src/components/CreditsTab.tsx')
    expect(src).toContain("const byok = !!providerId && providerId !== 'archipelago'")
    expect(src).toMatch(/const low = !byok &&/)
    expect(src).toMatch(/const exhausted = !byok &&/)
  })
  it('切档在同一事务里刷存量居民并广播(否则设置页显示已切、聊天还走旧通道)', () => {
    const bots = read('src/main/bots.ts')
    expect(bots).toContain('export function applyModelSource(')
    expect(bots).toContain('database.transaction(')
    const ipc = read('src/main/ipc.ts')
    expect(ipc).toContain('applyModelSource(providerId, modelId)')
    expect(ipc).toContain('win.webContents.send(EV.BotsChanged)')
  })
  it('默认配置的写入在 applyModelSource 的事务里,不许在 IPC 里先单独提交(2026-11-13 codex 审查)', () => {
    const bots = read('src/main/bots.ts')
    // 事务内先写 model.default 再刷居民:第二步失败时一起回滚,重试不会被 previous 判断跳过
    expect(bots).toMatch(/database\.transaction\(\(\) => \{\n\s+setModelConfig\(\{ providerId, modelId \}\)/)
    const ipc = read('src/main/ipc.ts')
    expect(ipc).not.toMatch(/setModelConfig\(\{ providerId, modelId \}\)/)
  })
  it('行级 Enter/Space 不抢行内按钮的键盘(否则 Tab 到「修改」按 Enter 会误切档)', () => {
    expect(read('src/renderer/src/components/ModelSource.tsx')).toContain('e.target !== e.currentTarget')
  })
  it('0.9 迁移带一次性闸(没有闸的话设好 Key 重启就回落)', () => {
    const src = read('src/main/store.ts')
    expect(src).toContain("const RELAY_SWITCH_MIGRATION_FLAG = 'migration.0_9.relay_switch'")
    expect(src).toContain('if (!database.prepare(\'SELECT 1 FROM meta WHERE key = ?\').get(RELAY_SWITCH_MIGRATION_FLAG))')
  })
  it('云端模型窗口只对群岛通道生效(两条通道 id 同名,不能按群岛的窗口算自带 Key)', () => {
    expect(read('src/main/steward.ts')).toContain("bot.providerId === 'archipelago' ? cloudModelWindow(bot.modelId) : null")
  })
})
