// 群岛账号(海域服务)客户端:邮箱验证码登录、账号目录挂载、存量认领、会话令牌保管
// 0.8 登录门口径(doc/需求 - 0.8登录门与账号分区):
//   账号即门——登录成功才挂载 accounts/<account_id>/ 数据根、才打开业务库;
//   岛 = 账号×设备;绑定每次登录幂等重报,防漏绑;登出 = 删 current.json + 卸载数据根。

import { net, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { CreditsSnapshot, RedeemResult, SeaAccountInfo, SeaCodeResult, SeaDeviceInfo, SeaLoginNext, SeaSessionState, WizardGrantInfo } from '@shared/types'
import { getSpace } from './space'
import { deviceFingerprint } from './device-fingerprint'
import { metaGet, metaSet, closeDb } from './store'
import { accountDir, clearDataRoot, currentAccountFile, machineRoot, requireDataRoot, setDataRoot } from './paths'
import { migrateLegacyWorkspaces } from './workspace'
import { closeAllMcp } from './mcp-manager'
import { legacyDataExists, migrateLegacyToAccount, readLegacyIslandInfo, resumeInterruptedMigration } from './account-migration'

// 海域服务地址(主域 sea.qundao.app,sea.feixing.io 为别名共存);
// 本地联调:仓库根目录 SEA_BASE_URL=http://127.0.0.1:8787 npm run dev
export const SEA_BASE_URL = process.env.SEA_BASE_URL || 'https://sea.qundao.app'
const KEY_DEVICE_ID = 'sea.deviceId'

/** 会话落盘形状(账号目录内);token 经 safeStorage 加密(不可用时退化明文,0600 兜底) */
interface StoredSession {
  account: SeaAccountInfo
  tokenEnc: string
  tokenPlain: boolean
  deviceId: string | null
  devices: SeaDeviceInfo[]
}

/** 认领中转:verify 通过但等用户确认认领时,令牌暂存内存(崩溃即丢,重新登录,无悬空态) */
let pendingClaim: { account: SeaAccountInfo; token: string } | null = null

function sessionFile(accountId: string): string {
  return join(accountDir(accountId), 'sea-session.json')
}

function encryptToken(token: string): { tokenEnc: string; tokenPlain: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { tokenEnc: safeStorage.encryptString(token).toString('base64'), tokenPlain: false }
  }
  return { tokenEnc: token, tokenPlain: true }
}

function decryptToken(stored: StoredSession): string {
  if (stored.tokenPlain) return stored.tokenEnc
  try {
    return safeStorage.decryptString(Buffer.from(stored.tokenEnc, 'base64'))
  } catch {
    return ''
  }
}

function readSessionFile(accountId: string): StoredSession | null {
  try {
    const file = sessionFile(accountId)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as StoredSession
    if (!parsed?.account?.email || !decryptToken(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function writeSessionFile(accountId: string, next: StoredSession): void {
  mkdirSync(accountDir(accountId), { recursive: true })
  writeFileSync(sessionFile(accountId), JSON.stringify(next), { mode: 0o600 })
}

function readCurrentAccountId(): string | null {
  try {
    const file = currentAccountFile()
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { accountId?: string }
    return parsed?.accountId ?? null
  } catch {
    return null
  }
}

function writeCurrentAccountId(accountId: string): void {
  writeFileSync(currentAccountFile(), JSON.stringify({ accountId }), { mode: 0o600 })
}

function clearCurrentAccountId(): void {
  if (existsSync(currentAccountFile())) unlinkSync(currentAccountFile())
}

function toState(stored: StoredSession): SeaSessionState {
  return { account: stored.account, devices: stored.devices, localDeviceId: stored.deviceId }
}

function ensureDeviceId(): string {
  const existing = metaGet<string>(KEY_DEVICE_ID)
  if (existing) return existing
  const id = randomUUID()
  metaSet(KEY_DEVICE_ID, id)
  return id
}

/** 服务端业务错误:携带结构化 code(如 unauthorized),判定会话失效靠它而非文案 */
class SeaError extends Error {
  constructor(
    message: string,
    public code: string | null,
    public status: number | null
  ) {
    super(message)
  }
}

async function sea<T>(path: string, init?: { method?: string; token?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init?.token) headers.authorization = `Bearer ${init.token}`
  let resp: Response
  try {
    resp = await net.fetch(`${SEA_BASE_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    throw new SeaError('连不上群岛海域服务,请检查网络后重试', null, null)
  }
  const payload = (await resp.json().catch(() => null)) as
    | { ok?: boolean; data?: T; error?: { code?: string; message?: string } }
    | null
  if (!resp.ok || !payload?.ok) {
    throw new SeaError(payload?.error?.message || `海域服务请求失败(${resp.status})`, payload?.error?.code ?? null, resp.status)
  }
  return payload.data as T
}


// ---------- 群岛通道(0.9 积分中转) ----------

/** 中转 /v1 端点(随 SEA_BASE_URL 走,本地联调同源) */
export function seaRelayBaseUrl(): string {
  return `${SEA_BASE_URL}/v1`
}

/** 当前登录的会话令牌(群岛通道的 Bearer;登出/换号即失效) */
export function currentSeaToken(): string | null {
  const accountId = readCurrentAccountId()
  if (!accountId) return null
  const stored = readSessionFile(accountId)
  return stored ? decryptToken(stored) || null : null
}

/** 本机岛的岛 ID(服务端签发的 island_uid,请求头 x-island-uid 用于运营对账;拿不到返回 null) */
export function currentIslandUid(): string | null {
  const state = getAuthState()
  if (!state) return null
  const device = state.devices.find((d) => d.id === state.localDeviceId)
  return device?.islands?.[0]?.id ?? null
}

export function currentIslandArtworkId(): string | null {
  const uid = currentIslandUid()
  const accountId = readCurrentAccountId()
  const stored = accountId ? readSessionFile(accountId) : null
  for (const device of stored?.devices ?? []) {
    const island = device.islands.find((entry) => entry.id === uid)
    if (island) return island.artworkId ?? null
  }
  return null
}

// ---- 云端模型目录快照(2026-10-28 B1:窗口口径修复) ----
// 模型目录的唯一事实源是运营后台的 cost_prices(客户端写死目录已是遗留);上下文窗口跟着目录
// 随 GET /v1/models 下发,客户端缓存进账号级 meta KV,供水位线压缩与超长兜底取窗口数。
// 拉取失败不影响使用:沿用上次缓存,再往后回落本地目录/128k(steward.contextWindowOf)。

interface CloudModelEntry {
  /** 下发口径:客户端显示名优先(快速/均衡),未配别名回退模型名 */
  id: string
  /** 真实模型名(两侧口径都可匹配) */
  model: string
  contextWindow: number | null
}

const KEY_CLOUD_MODELS = 'cloud.models.v1'

export async function refreshCloudModels(): Promise<void> {
  const token = currentSeaToken()
  if (!token) return
  try {
    const resp = await net.fetch(`${seaRelayBaseUrl()}/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (!resp.ok) return
    const payload = (await resp.json().catch(() => null)) as
      | { data?: { id?: string; model?: string; context_window?: number | null }[] }
      | null
    const entries = (payload?.data ?? [])
      .filter((e) => typeof e.id === 'string' && e.id !== '')
      .map((e) => ({
        id: e.id!,
        model: typeof e.model === 'string' && e.model ? e.model : e.id!,
        contextWindow: typeof e.context_window === 'number' && e.context_window > 0 ? Math.floor(e.context_window) : null
      }))
    if (entries.length > 0) metaSet(KEY_CLOUD_MODELS, entries)
  } catch {
    // 目录拉取失败静默:沿用上次缓存
  }
}

/** 查模型的上下文窗口:按真实模型名或下发档位名匹配;缓存缺失/未配窗口返回 null(调用方自行兜底) */
export function cloudModelWindow(modelId: string): number | null {
  const entries = metaGet<CloudModelEntry[]>(KEY_CLOUD_MODELS)
  if (!entries || modelId === '') return null
  const hit = entries.find((e) => (e.model === modelId || e.id === modelId) && e.contextWindow !== null)
  return hit?.contextWindow ?? null
}

// 积分快照缓存(0.9.2 自走查 A5 → 截图评审 v6 收紧):
// 只有「本会话内」的内存缓存可作首屏(命中秒开,后台拉新原地更新);不做跨会话持久化——
// 积分数字敏感,重启/隔天再打开若先展示几天前的旧值、几秒后又跳变,落差太大。
// 会话内 TTL 取 10 分钟(口径:5~10 分钟内的缓存可接受)。
const CREDITS_CACHE_TTL_MS = 10 * 60_000
const creditsCache = new Map<string, { at: number; snap: CreditsSnapshot }>()

/** 积分快照(套餐与积分页签与余额预警条的数据源)。
 *  force=false:会话内内存缓存(10min)命中即返回,未命中走网络(调用方展示加载态);
 *  force=true:跳过缓存直接网络(成功后回写缓存)。 */
export async function creditsSnapshot(force = false): Promise<CreditsSnapshot> {
  const token = currentSeaToken()
  if (!token) throw new SeaError('登录已失效,请重新登录', 'unauthorized', 401)
  const accountId = readCurrentAccountId()
  if (!accountId) throw new SeaError('登录已失效,请重新登录', 'unauthorized', 401)
  const hot = creditsCache.get(accountId)
  if (!force && hot && Date.now() - hot.at < CREDITS_CACHE_TTL_MS) return hot.snap
  const snap = await sea<CreditsSnapshot>('/account/credits', { token })
  creditsCache.set(accountId, { at: Date.now(), snap })
  return snap
}

export function invalidateCreditsCache(): void {
  creditsCache.clear()
}

// ---------- 向导预取(0.9.2 自走查 A4) ----------

/** 注册赠送额兜底值(展示用途):与服务端配置一致(2026-10-27 定稿 500 积分/30 天),预取失败时用它,真实赠送以服务端为准 */
const SIGNUP_GRANT_DEFAULT_MILLI = 500_000 // 500 积分 / 30 天
let signupGrantCache: { at: number; milli: number } | null = null

/** 首岛判定 + 注册赠送额:用户还在向导前几步写岛名时异步算好,完成页现场零查询。
 *  判定口径:账号名下任何设备都没有岛 = 第一次建岛(全新账号 devices 为空,向导完成才 bind;老账号换设备必带旧岛)。 */
export async function wizardGrantInfo(): Promise<WizardGrantInfo> {
  const state = getAuthState()
  const firstIsland = !(state?.devices ?? []).some((d) => (d.islands?.length ?? 0) > 0)
  if (signupGrantCache && Date.now() - signupGrantCache.at < 5 * 60_000) {
    return { firstIsland, signupGrantMilli: signupGrantCache.milli }
  }
  let milli = SIGNUP_GRANT_DEFAULT_MILLI
  try {
    const data = await sea<{ signup_grant_milli: number }>('/account/signup-grant')
    signupGrantCache = { at: Date.now(), milli: data.signup_grant_milli }
    milli = data.signup_grant_milli
  } catch {
    // 取不到配置就回默认值:卡片只在 firstIsland 且额度>0 时展示
  }
  return { firstIsland, signupGrantMilli: milli }
}

/** 兑换码核销;成功后清缓存(余额立刻刷新) */
export async function redeemCredits(code: string): Promise<RedeemResult> {
  const token = currentSeaToken()
  if (!token) throw new SeaError('登录已失效,请重新登录', 'unauthorized', 401)
  const result = await sea<RedeemResult>('/account/redeem', { method: 'POST', token, body: { code } })
  invalidateCreditsCache()
  return result
}

// ---------- 服务端行 → 领域类型 ----------

interface ServerDevice {
  id: string
  name: string
  created_at: number
  last_seen_at: number
  islands: { id: string; name: string; owner_name: string; stamp_artwork_id?: string | null }[]
}

function mapDevices(rows: ServerDevice[]): SeaDeviceInfo[] {
  return rows.map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: d.created_at,
    lastSeenAt: d.last_seen_at,
    islands: (d.islands ?? []).map((i) => ({ id: i.id, name: i.name, ownerName: i.owner_name, artworkId: i.stamp_artwork_id ?? null }))
  }))
}

// ---------- 挂载与登录态 ----------

/** 挂载账号目录并打开业务库(登录后/开机解锁时) */
function mount(accountId: string): void {
  closeDb()
  // 切号先作废上一账号的 MCP 连接(连接器表在业务库里,跨账号不复用)
  void closeAllMcp()
  setDataRoot(accountDir(accountId))
  requireDataRoot() // 触发 mkdir + 开库(migrate)
  // 一次性把旧默认工作区(<dataRoot>/workspaces)搬到主目录 ~/群岛(2026-10-28 拍板);
  // meta KV 幂等,冲突/失败保旧位,详见 workspace.migrateLegacyWorkspaces
  try {
    migrateLegacyWorkspaces()
  } catch (err) {
    console.error('[sea] 工作区迁移失败(不影响使用,旧位置照常可用):', err)
  }
  // 挂载即刷新云端模型目录(开机/登录/认领共用此入口;窗口数可能被运营改过);失败静默沿用缓存
  void refreshCloudModels()
  // 回复唤醒崩溃恢复(2026-11-05):库挂载后从落库行重建丢掉的内存队列(信未回/回信未转述),
  // 确保中途退出 App/断网的私信链路重启后居民仍会主动开口;动态 import 防 auth↔chat 循环依赖,
  // 失败静默(恢复幂等,下次挂载再来)
  void import('./chat')
    .then((m) => m.recoverReplyWake())
    .catch(() => undefined)
  // 任务工作目录恢复扫描(2026-11-10 第一批):对照 task_threads / worktree 注册表 / 磁盘目录
  // 三方核对——preparing 残留收敛、ready 校验坏则标 error、finalizing 补跑收尾;
  // 归属不明的目录只报告不删。失败静默(恢复幂等,下次挂载再来)
  void import('./task-workdir')
    .then((m) => m.recoverTaskWorkdirs())
    .catch(() => undefined)
}

/**
 * 开机解析:凭本地令牌解锁则直接挂载返回 app 态;否则登录屏。
 * 附带执行中断迁移恢复(把半迁移收敛到确定态)。
 */
export function resolveBoot(): 'login' | 'app' {
  try {
    resumeInterruptedMigration(machineRoot())
  } catch (err) {
    console.error('[sea] 恢复中断迁移失败', err)
  }
  const accountId = readCurrentAccountId()
  if (!accountId) return 'login'
  const stored = readSessionFile(accountId)
  if (!stored) return 'login'
  mount(accountId)
  return 'app'
}

export function getAuthState(): SeaSessionState | null {
  const accountId = readCurrentAccountId()
  if (!accountId) return null
  const stored = readSessionFile(accountId)
  return stored ? toState(stored) : null
}

export async function refreshAuthState(): Promise<SeaSessionState | null> {
  const accountId = readCurrentAccountId()
  if (!accountId) return null
  const stored = readSessionFile(accountId)
  if (!stored) return null
  try {
    const data = await sea<{ account: SeaAccountInfo; devices: ServerDevice[] }>('/account/me', {
      token: decryptToken(stored)
    })
    writeSessionFile(accountId, { ...stored, account: data.account, devices: mapDevices(data.devices) })
  } catch (err) {
    // 服务端明确拒认(unauthorized=会话失效 / account_inactive=账号停用):清掉本机解锁态;
    // 普通网络故障:保留本地态,下次再试
    if (err instanceof SeaError && (err.code === 'unauthorized' || err.code === 'account_inactive')) {
      await logout()
      return null
    }
  }
  const reread = readSessionFile(accountId)
  return reread ? toState(reread) : null
}

export async function requestCode(email: string): Promise<SeaCodeResult> {
  const data = await sea<{ expires_in: number; dev_code?: string }>('/auth/request-code', {
    method: 'POST',
    body: { email }
  })
  return { expiresIn: data.expires_in, devCode: data.dev_code }
}

/**
 * 验证登录并决定去向:
 * - enter:该账号目录已在本机(老账号回访)→ 挂载+重绑,重载进主界面
 * - claim:本机有未认领的存量岛 → 返回岛信息,等认领确认(令牌暂存内存)
 * - wizard:全新账号 → 建目录挂载,重载进建岛向导
 */
export async function verifyLogin(email: string, code: string): Promise<SeaLoginNext> {
  // 一次验证一条去向:旧认领暂存(若有)即刻作废,杜绝换邮箱后残留上一个账号的令牌
  pendingClaim = null
  const data = await sea<{
    account: SeaAccountInfo
    token: string
    is_new_account: boolean
    devices: ServerDevice[]
  }>('/auth/verify', { method: 'POST', body: { email, code } })

  const account = data.account
  const dir = accountDir(account.id)
  if (existsSync(dir)) {
    completeLogin(account, data.token, mapDevices(data.devices))
    await rebindIsland()
    return { next: 'enter', account }
  }
  if (legacyDataExists(machineRoot())) {
    pendingClaim = { account, token: data.token }
    return { next: 'claim', account, island: readLegacyIslandInfo(machineRoot()) }
  }
  mkdirSync(dir, { recursive: true })
  completeLogin(account, data.token, mapDevices(data.devices))
  // 全新账号还没有岛(wizard 未完成),绑定推迟到 wizardComplete
  return { next: 'wizard', account }
}

/** 认领确认:迁移 → 落盘会话 → 挂载 → 重绑 */
export async function confirmClaim(): Promise<SeaLoginNext> {
  if (!pendingClaim) throw new Error('没有待认领的登录,请重新验证')
  const { account, token } = pendingClaim
  migrateLegacyToAccount(machineRoot(), account.id)
  completeLogin(account, token, [])
  pendingClaim = null
  await rebindIsland()
  return { next: 'enter', account }
}

/**
 * 拒绝认领:本机存量岛留给以后的账号认领,当前账号新建空目录走建岛向导。
 * 根上平铺数据原样不动(仍可被下一个新账号认领)。
 */
export async function declineClaim(): Promise<SeaLoginNext> {
  if (!pendingClaim) throw new Error('没有待认领的登录,请重新验证')
  const { account, token } = pendingClaim
  pendingClaim = null
  mkdirSync(accountDir(account.id), { recursive: true })
  completeLogin(account, token, [])
  return { next: 'wizard', account }
}

function completeLogin(account: SeaAccountInfo, token: string, devices: SeaDeviceInfo[]): void {
  writeSessionFile(account.id, { account, ...encryptToken(token), deviceId: null, devices })
  writeCurrentAccountId(account.id)
  mount(account.id)
  // deviceId 落进该账号的 meta(此时库已挂载),并回写会话文件
  const deviceId = ensureDeviceId()
  const stored = readSessionFile(account.id)
  if (stored) writeSessionFile(account.id, { ...stored, deviceId })
}

/**
 * 岛绑定:每次登录幂等重报(服务端按 账号+local_space_id upsert)。
 * 失败只警告不回滚——下次登录自动补齐,不存在「登了但没关联」的悬空态。
 */
export async function rebindIsland(): Promise<void> {
  const accountId = readCurrentAccountId()
  if (!accountId) return
  const stored = readSessionFile(accountId)
  if (!stored) return
  const space = getSpace()
  if (!space) return // 向导未完成,尚无岛可绑
  try {
    const data = await sea<{
      account: SeaAccountInfo
      devices: ServerDevice[]
      local: { device: { id: string }; island: { id: string; name: string; owner_name: string } }
    }>('/devices/bind', {
      method: 'POST',
      token: decryptToken(stored),
      body: {
        device_id: stored.deviceId ?? ensureDeviceId(),
        device_name: hostname(),
        fingerprint: await deviceFingerprint(), // 0013:重装后服务端按指纹认领旧设备行;采集失败为 null 走原幂等
        island: { local_space_id: space.id, name: space.name, owner_name: space.ownerName }
      }
    })
    // 采纳服务端签发的设备 id(权威)回写 meta 与会话:否则客户端自造 id 永远匹配不上服务端设备行,
    // x-island-uid 断供,旧版服务端还会每次重绑插一行重复设备。
    metaSet(KEY_DEVICE_ID, data.local.device.id)
    writeSessionFile(accountId, { ...stored, deviceId: data.local.device.id, account: data.account, devices: mapDevices(data.devices) })
  } catch (err) {
    console.warn('[sea] 岛绑定重报失败(下次登录自动补齐)', err)
  }
}

export async function logout(): Promise<void> {
  const accountId = readCurrentAccountId()
  if (accountId) {
    const stored = readSessionFile(accountId)
    if (stored) {
      // 服务端吊销尽力而为,失败也照常清本机(令牌到期自然失效)
      await sea('/auth/logout', { method: 'POST', token: decryptToken(stored) }).catch(() => undefined)
      const file = sessionFile(accountId)
      if (existsSync(file)) unlinkSync(file)
    }
  }
  clearCurrentAccountId()
  pendingClaim = null
  void closeAllMcp()
  closeDb()
  clearDataRoot()
}
