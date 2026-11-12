import { app, BrowserWindow, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as electronUpdater from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import { EV } from '@shared/ipc-channels'
import type { UpdateAsset, UpdateManifest, UpdatePrefs, UpdatePrefsPatch, UpdateState } from '@shared/types'
import { logDiag } from './diag'
import { metaGet, metaSet, nowIso } from './store'
import { currentDataRoot } from './paths'

// 登录屏阶段(0.8 账号即门)业务库未挂载:更新器的状态读写静默跳过,不阻塞启动
function smetaGet<T>(key: string): T | null {
  if (!currentDataRoot()) return null
  try {
    return metaGet<T>(key)
  } catch {
    return null
  }
}

function smetaSet(key: string, value: unknown): void {
  if (!currentDataRoot()) return
  try {
    metaSet(key, value)
  } catch {
    // 忽略:更新偏好不值得为它崩
  }
}

// 灰度分桶 ID 存机器级文件而非账号库:登录屏阶段业务库不可用,放库里每次检查都要现生成,分桶会漂
function machineIdFile(): string {
  return path.join(app.getPath('userData'), 'update-machine-id')
}

function saveMachineId(id: string): void {
  try {
    fs.writeFileSync(machineIdFile(), id, { mode: 0o600 })
  } catch {
    // 写不进就每次现生成,只影响灰度稳定性,不值得为它崩
  }
}

function loadMachineId(): string {
  try {
    const existing = fs.readFileSync(machineIdFile(), 'utf-8').trim()
    if (existing) return existing
  } catch {
    // 无文件走下面兜底
  }
  // 存量用户沿用 0.7 时代落在库里的 ID,保住灰度桶连续性
  const legacy = smetaGet<string>(KEY_MACHINE)
  if (legacy) {
    saveMachineId(legacy)
    return legacy
  }
  const id = randomUUID()
  saveMachineId(id)
  return id
}

// 升级机制(混合架构):
//   决策层(第一阶段,自研):update.json 静态清单 → 可见性/红点/灰度分桶/minVersion 强更/跳过/岛务广播
//   执行层(第二阶段,electron-updater):下载 zip(blockmap 差分)→ sha512 校验 → Squirrel 原地换壳 → 重启
//   兜底:in-place 不可用(只读位置/开发模式)或失败时,自动回退「下载 DMG + 打开安装包」的第一阶段流程
// 两份清单(update.json 与 latest-mac.yml)由 scripts/release.mjs 同一构建产出;下载前比对版本,
// 不一致视为更新源异常(CDN 陈旧/发布残留),直接走 DMG 兜底。

// 更新源:Cloudflare R2 桶 archipelago-releases 的自定义域名(2026-10-23 迁 dl.qundao.app,随域名体系切换)。
// 旧域名 dl.feixing.io 与新域名同桶共存、长期保留:存量客户端烧的是旧域名,只能经旧域名发现携带新 URL 的版本。
// 与 package.json 的 build.publish[0].url 保持一致;scripts/release.mjs 发布前会校验两处一致。
const FEED_URL = 'https://dl.qundao.app/updates/stable/'
const MANIFEST_URL = `${FEED_URL}update.json`

const CHECK_DELAY_MS = 30_000 // 启动后延迟首查,避开启动高峰
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 两次检查的最小墙钟间隔(2026-11-03 起 24h→6h)
const CHECK_TICK_MS = 15 * 60 * 1000 // 对表粒度:睡眠唤醒/断网恢复后最多一个 tick 内补查
const PROGRESS_STEP_BYTES = 512 * 1024 // 进度广播节流

// 状态持久化键(meta 表)
const KEY_PREFS = 'update.prefs'
const KEY_MACHINE = 'update.machineId' // 灰度分桶 ID 的 0.7 旧居;现住机器级文件,首启一次性迁过去
const KEY_LAST = 'update.lastCheck' // { at, manifest }
const KEY_SEEN = 'update.seenVersion'
const KEY_ANNOUNCED = 'update.announcedVersions'
/** in-place 尝试失败过的版本,之后该版本直接走 DMG,避免反复撞同一堵墙 */
const KEY_INPLACE_FAILED = 'update.inplaceFailedVersions'

const DEFAULT_PREFS: UpdatePrefs = { autoCheck: true, autoDownload: false, skippedVersions: [] }

// Windows 首版(2026-11-03)不装配更新器:决策层清单(mac-arm64)与执行层(Squirrel 原地换壳/latest-mac.yml)
// 全是 mac 语义,Windows 侧诚实落「不支持」态,自动检查也不启动;正式 Windows 发版再接 NSIS+latest.yml 差分
const UPDATER_SUPPORTED = process.platform === 'darwin'

let state: UpdateState
let manifest: UpdateManifest | null = null
let checking = false
let downloading = false
let downloadCancelled = false
// 下载尝试代数:新尝试/取消都换代。预检(latest-mac.yml 网络往返)期间取消后立刻重点,
// downloadCancelled 会被新一轮重置,旧续体只看标记会误以为没取消而照常接手下载;靠代数比对兜住。
let downloadEpoch = 0
let downloadAbort: AbortController | null = null
let downloadedVersion: string | null = null
/** 本次运行内已广播过的版本,防止重复弹岛务广播 */
const announcedThisLaunch = new Set<string>()

// electron-updater 执行层:仅打包环境装配(dev 无 app-update.yml)。
// 命名空间导入保持惰性——访问 .autoUpdater 才实例化 MacUpdater。
let updater: electronUpdater.AppUpdater | null = null
let CancellationTokenCtor: typeof electronUpdater.CancellationToken | null = null
/** in-place 下载尝试进行中(路由放行到 update-downloaded/error 收尾前) */
let inplaceActive = false
let inplaceToken: electronUpdater.CancellationToken | null = null
let inplaceLastBroadcast = 0

function emptyState(): UpdateState {
  return {
    currentVersion: '0.0.0',
    status: 'idle',
    devMode: !app.isPackaged,
    version: null,
    releaseDate: null,
    notes: null,
    mandatory: false,
    skipped: false,
    rolloutExcluded: false,
    showBadge: false,
    freshVersion: null,
    lastCheckedAt: null,
    lastError: null,
    downloadProgress: null,
    installMode: null,
    downloadedPath: null,
    downloadUrl: null,
    prefs: { ...DEFAULT_PREFS }
  }
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EV.UpdateState, { state })
}

function loadPrefs(): UpdatePrefs {
  return { ...DEFAULT_PREFS, ...smetaGet<Partial<UpdatePrefs>>(KEY_PREFS) }
}

function savePrefs(next: UpdatePrefs): void {
  smetaSet(KEY_PREFS, next)
}

/** 轻量 semver 比较:只比 major.minor.patch,前缀 v 可选;解析失败视为不可比(返回 0) */
function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! > pb[i]! ? 1 : -1
  }
  return 0
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** 灰度:按本机稳定 ID 与版本号哈希分桶,同一台机器对同一版本结果恒定 */
function inRollout(version: string, rollout: number): boolean {
  if (rollout >= 100) return true
  if (rollout <= 0) return false
  const bucket = createHash('sha256').update(`${loadMachineId()}:${version}`).digest().readUInt32BE(0) % 100
  return bucket < rollout
}

function validateManifest(m: unknown): asserts m is UpdateManifest {
  const cand = m as UpdateManifest | null
  if (!cand || typeof cand.version !== 'string' || typeof cand.downloads !== 'object') {
    throw new Error('清单格式不正确')
  }
  if (!parseSemver(cand.version)) throw new Error(`清单版本号不合法:${cand.version}`)
  const asset = cand.downloads['mac-arm64']
  if (!asset || typeof asset.url !== 'string' || !/^https:\/\//.test(asset.url)) {
    throw new Error('清单缺少 mac-arm64 安装包地址')
  }
}

/**
 * 由 manifest + 偏好 + meta 重算派生字段(可用性/强制/跳过/灰度/红点/广播)。
 * 不动 status/downloadProgress 等过程字段,除版本切换时重置下载态。
 */
function refreshDerived(): void {
  const p = loadPrefs()
  const available = !!manifest && compareVersions(manifest.version, state.currentVersion) > 0
  const version = available ? manifest!.version : null

  state.prefs = p
  state.version = version
  state.releaseDate = version ? manifest!.releaseDate : null
  state.notes = version ? (manifest!.notes ?? null) : null
  state.mandatory =
    !!version && !!manifest!.minVersion && compareVersions(state.currentVersion, manifest!.minVersion) < 0
  state.skipped = !!version && !state.mandatory && p.skippedVersions.includes(version)
  state.rolloutExcluded = !!version && !inRollout(version, manifest!.rollout ?? 100)
  state.downloadUrl = manifest?.downloads['mac-arm64']?.url ?? null

  const visible = !!version && !state.skipped && !state.rolloutExcluded
  const seen = smetaGet<string>(KEY_SEEN)
  state.showBadge = visible && (state.mandatory || seen !== version)

  // 清单版本变化(或本地已升级)时,作废旧版本的下载产物。进行中的同版本下载除外——
  // downloadedVersion 只在完成时才落,下载中恒为旧值,不拦的话每次 refreshDerived
  // (如下载期间打开「关于」触发 markUpdateSeen)都会把后台还在跑的下载打回 idle
  if (downloadedVersion !== version && !(downloading && state.status === 'downloading')) {
    state.downloadedPath = null
    state.installMode = null
    if (state.status === 'downloaded' || state.status === 'downloading') {
      state.status = 'idle'
      state.downloadProgress = null
    }
  }
  if (!available || !visible) state.freshVersion = null

  // 岛务广播:普通版本对这台机器首次可见时广播一次;强制版本每次启动都再广播
  if (visible && state.freshVersion !== version && !announcedThisLaunch.has(version)) {
    if (state.mandatory) {
      announcedThisLaunch.add(version)
      state.freshVersion = version
    } else {
      const announced = smetaGet<string[]>(KEY_ANNOUNCED) ?? []
      if (!announced.includes(version)) {
        smetaSet(KEY_ANNOUNCED, [...announced.slice(-9), version])
        announcedThisLaunch.add(version)
        state.freshVersion = version
      }
    }
  }
}

/** 装配 electron-updater 执行层:事件常驻(退出自动换壳依赖它),下载时机仍由决策层驱动 */
function setupInplaceUpdater(): void {
  if (!app.isPackaged) return
  const autoUpdater = electronUpdater.autoUpdater
  autoUpdater.autoDownload = false // 下载由决策层路由决定
  autoUpdater.autoInstallOnAppQuit = true // 就绪(下载+校验完成)后正常退出也自动换壳,下次启动即新版
  const bridge = (level: string, msg: unknown, rest: unknown[]): void => {
    logDiag(`update.eu.${level}`, rest.length ? [String(msg), ...rest.map(String)] : String(msg))
  }
  autoUpdater.logger = {
    info: (msg: unknown, ...rest: unknown[]) => bridge('info', msg, rest),
    warn: (msg: unknown, ...rest: unknown[]) => bridge('warn', msg, rest),
    error: (msg: unknown, ...rest: unknown[]) => bridge('error', msg, rest),
    debug: (msg: unknown, ...rest: unknown[]) => bridge('debug', msg, rest)
  }

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    if (!inplaceActive || state.status !== 'downloading') return
    // 首事件必广播(慢网凑满 512KB 门槛可能要几十秒,数字不动像卡死),其后按字节步长节流
    if (
      inplaceLastBroadcast > 0 &&
      p.transferred - inplaceLastBroadcast < PROGRESS_STEP_BYTES &&
      p.transferred < p.total
    )
      return
    inplaceLastBroadcast = p.transferred
    state.downloadProgress = { received: p.transferred, total: p.total }
    broadcast()
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    if (!inplaceActive) return
    inplaceActive = false
    inplaceToken = null
    // 非本次目标的陈旧事件(理论少见),忽略并保持现状
    if (!state.version || compareVersions(info.version, state.version) !== 0) return
    downloadedVersion = state.version
    state.installMode = 'inplace'
    state.downloadedPath = null // zip 在 electron-updater 缓存里,不暴露给用户打开
    const total = state.downloadProgress?.total ?? manifest?.downloads['mac-arm64']?.size ?? 0
    state.downloadProgress = { received: total, total }
    state.status = 'downloaded'
    broadcast()
  })

  // 取消收尾(2026-11-06 codex 审查修复):electron-updater 取消走的是 update-cancelled
  // 事件 + promise rejection,内部对 CancellationError 明确跳过 dispatchError——不监听它,
  // 取消后 downloading/inplaceActive 永远为真,重试被守卫挡死。此处兜底收尾(与
  // cancelUpdateDownload 的就地收尾互为保险,先到者生效,幂等)
  autoUpdater.on('update-cancelled', () => {
    if (!inplaceActive) return
    inplaceActive = false
    inplaceToken = null
    if (downloadCancelled) {
      downloading = false
      state.status = 'idle'
      state.downloadProgress = null
      broadcast()
    }
  })

  autoUpdater.on('error', (err: Error) => {
    logDiag('update.eu.event-error', String(err))
    if (!inplaceActive) return // 决策层自检等非执行中报错,只记日志
    inplaceActive = false
    inplaceToken = null
    if (downloadCancelled) {
      downloading = false
      state.status = 'idle'
      state.downloadProgress = null
      broadcast()
      return
    }
    // in-place 尝试失败:记住该版本不再自动尝试,本轮直接转 DMG 兜底
    const version = state.version
    if (version) {
      const failed = smetaGet<string[]>(KEY_INPLACE_FAILED) ?? []
      if (!failed.includes(version)) smetaSet(KEY_INPLACE_FAILED, [...failed.slice(-4), version])
    }
    downloading = false
    const asset = manifest?.downloads['mac-arm64']
    if (version && asset) {
      logDiag('update.inplace.fallback-dmg', { version })
      void startDmgDownload(version, asset)
    } else {
      state.status = 'error'
      state.lastError = `自动更新失败:${String(err)}`
      state.downloadProgress = null
      broadcast()
    }
  })

  updater = autoUpdater
  CancellationTokenCtor = electronUpdater.CancellationToken
}

export function initUpdater(): void {
  state = emptyState()
  state.currentVersion = app.getVersion()
  state.prefs = loadPrefs()

  // Windows 首版:状态置 unsupported,不装配 electron-updater、不启动自动检查
  if (!UPDATER_SUPPORTED) {
    state.status = 'unsupported'
    refreshDerived()
    broadcast()
    return
  }

  // 回填上次检查结果,启动即有红点/版本信息,不必等网络
  const cached = smetaGet<{ at: string; manifest: unknown }>(KEY_LAST)
  if (cached?.at) state.lastCheckedAt = cached.at
  if (cached?.manifest) {
    try {
      validateManifest(cached.manifest)
      manifest = cached.manifest
    } catch {
      manifest = null
    }
  }
  setupInplaceUpdater()
  refreshDerived()
  broadcast()

  if (!app.isPackaged) return // 开发模式只保留手动检查,便于联调
  if (!state.prefs.autoCheck) return
  setTimeout(() => {
    void checkForUpdates()
    // 对表式周期检查而非 setInterval 长间隔:macOS 睡眠冻结定时器,长间隔的语义是
    // 「清醒运行时长」,合盖过夜的用户实际触发周期远大于名义值;对表用墙钟,唤醒后
    // 最多一个 tick 即补查。lastCheckedAt 仅成功时更新,失败(如断网)下个 tick 自然重试。
    setInterval(() => {
      const last = Date.parse(state.lastCheckedAt ?? '')
      if (Number.isNaN(last) || Date.now() - last >= CHECK_INTERVAL_MS) void checkForUpdates()
    }, CHECK_TICK_MS)
  }, CHECK_DELAY_MS)
}

export function getUpdateState(): UpdateState {
  return state
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!UPDATER_SUPPORTED) return state
  if (checking) return state
  // 正在下载/已就绪时不打扰过程状态:入口即拦(中途置 checking 会把进度条打断且收不回)
  if (state.status === 'downloading' || state.status === 'downloaded') return state
  checking = true
  state.status = 'checking'
  state.lastError = null
  broadcast()
  try {
    const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`清单请求失败(HTTP ${res.status})`)
    const next = await res.json()
    validateManifest(next)
    manifest = next
    state.lastCheckedAt = nowIso()
    smetaSet(KEY_LAST, { at: state.lastCheckedAt, manifest })
    // 网络往返期间用户可能已点了下载(status 已转 downloading):只回收自己仍持有的 checking
    if (state.status === 'checking') state.status = 'idle'
    refreshDerived()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (state.version) {
      // 已知有新版本时,检查失败保留旧结果,不打扰用户
      if (state.status === 'checking') state.status = 'idle'
    } else if (state.status === 'checking') {
      state.status = 'error'
      state.lastError = msg
    }
  } finally {
    checking = false
    broadcast()
    maybeAutoDownload()
  }
  return state
}

function downloadTarget(version: string): string {
  return path.join(app.getPath('downloads'), `Archipelago-${version}-arm64.dmg`)
}

function maybeAutoDownload(): void {
  const p = loadPrefs()
  if (!p.autoDownload) return
  if (!state.version || state.skipped || state.rolloutExcluded) return
  if (state.status !== 'idle') return
  void startUpdateDownload()
}

/**
 * 原地更新是否可用:执行层已装配、未对该版本标记过失败、且 .app 所在目录可写
 * (从 DMG/只读位置直接运行时 Squirrel 无法换壳,退 DMG 流程)。
 */
function canInplace(version: string): boolean {
  if (!updater) return false
  if ((smetaGet<string[]>(KEY_INPLACE_FAILED) ?? []).includes(version)) return false
  try {
    // exe = <安装目录>/群岛.app/Contents/MacOS/群岛;Squirrel 换壳写的是 .app 的父目录
    const appDir = path.dirname(path.dirname(path.dirname(app.getPath('exe'))))
    fs.accessSync(path.dirname(appDir), fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** 尝试走 electron-updater 原地更新;返回是否接手(未接手时由调用方落 DMG 流程)。
 * 进入时调用方已置好下载态与守卫,这里只做清单预检,通过且未被取消/换代才接手。 */
async function startInplaceDownload(version: string, epoch: number): Promise<boolean> {
  if (!updater || !CancellationTokenCtor) return false
  try {
    // 两份清单同源同版本才放行,防 CDN 陈旧/发布残留导致决策层与执行层脱节
    const result = await updater.checkForUpdates()
    const feedVersion = result?.updateInfo?.version
    if (!feedVersion || compareVersions(feedVersion, version) !== 0) {
      logDiag('update.inplace.feed-mismatch', { feedVersion: feedVersion ?? null, version })
      return false
    }
  } catch (err) {
    logDiag('update.inplace.check-failed', String(err))
    return false
  }
  // 预检是一次网络往返,归来先验仍在场:被取消或被新一轮尝试取代就不接手,状态由对方收尾
  if (downloadCancelled || epoch !== downloadEpoch) return false
  inplaceActive = true
  inplaceLastBroadcast = 0
  inplaceToken = new CancellationTokenCtor()
  // 完成与失败统一由 update-downloaded/error 事件收尾,这里只兜意外 rejection
  updater.downloadUpdate(inplaceToken).catch(() => {})
  return true
}

export async function startUpdateDownload(): Promise<UpdateState> {
  if (!UPDATER_SUPPORTED) return state
  if (downloading || state.status === 'downloaded') return state
  const version = state.version
  const asset = manifest?.downloads['mac-arm64']
  if (!version || !asset) {
    state.lastError = '没有可下载的新版本'
    state.status = 'error'
    broadcast()
    return state
  }
  // 点击即入下载态:原地更新前有一趟 latest-mac.yml 预检网络往返,状态与守卫先行置位,
  // 界面立刻出 0% 进度条;预检全程 downloading 为真,双击/自动下载触发都进不来
  const epoch = ++downloadEpoch
  downloading = true
  downloadCancelled = false
  state.status = 'downloading'
  state.lastError = null
  state.downloadProgress = { received: 0, total: asset.size }
  broadcast()
  // 优先原地更新(zip+差分+Squirrel 换壳),不可用或未接住再走 DMG 流程
  if (canInplace(version) && (await startInplaceDownload(version, epoch))) return state
  // 预检期间已取消或被新一轮尝试取代:状态已由对方收尾,不再落 DMG
  if (downloadCancelled || epoch !== downloadEpoch) return state
  return startDmgDownload(version, asset)
}

/** 第一阶段 DMG 流程:下载到「下载」文件夹,sha512 校验后由用户手动拖装 */
async function startDmgDownload(version: string, asset: UpdateAsset): Promise<UpdateState> {
  downloading = true
  downloadCancelled = false
  downloadAbort = new AbortController()
  state.status = 'downloading'
  state.lastError = null
  state.downloadProgress = { received: 0, total: asset.size }
  broadcast()

  const target = downloadTarget(version)
  const hash = createHash('sha512')
  const out = fs.createWriteStream(target)
  // 写流错误要在创建当下就接管:目录不可写/磁盘满这类错误可能在网络读取期间就发生,
  // 等到收尾才挂 error 监听会漏——校验只核网络字节,文件没落盘也会被标成已下载
  let writeError: Error | null = null
  out.on('error', (err) => {
    writeError = err
  })
  try {
    const res = await fetch(asset.url, { signal: downloadAbort.signal })
    if (!res.ok || !res.body) throw new Error(`下载失败(HTTP ${res.status})`)
    const total = Number(res.headers.get('content-length')) || asset.size
    let received = 0
    let lastBroadcast = 0
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const buf = Buffer.from(value)
        hash.update(buf)
        out.write(buf)
        if (writeError) throw writeError
        received += buf.length
        if (lastBroadcast === 0 || received - lastBroadcast >= PROGRESS_STEP_BYTES) {
          lastBroadcast = received
          state.downloadProgress = { received, total }
          broadcast()
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    if (writeError) throw writeError
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject)
      out.end(() => resolve())
    })
    if (writeError) throw writeError

    if (asset.size > 0 && received !== asset.size) {
      throw new Error(`安装包大小不符(期望 ${asset.size} 字节,实际 ${received})`)
    }
    if (asset.sha512 && hash.digest('hex') !== asset.sha512.toLowerCase()) {
      throw new Error('安装包校验失败(sha512 不符),已删除,请重新下载')
    }
    downloadedVersion = version
    state.installMode = 'dmg'
    state.downloadedPath = target
    state.downloadProgress = { received, total }
    state.status = 'downloaded'
  } catch (err) {
    fs.rmSync(target, { force: true })
    if (downloadCancelled) {
      state.status = 'idle'
      state.downloadProgress = null
    } else {
      state.status = 'error'
      state.lastError = err instanceof Error ? err.message : String(err)
      state.downloadProgress = null
    }
  } finally {
    downloading = false
    downloadAbort = null
    out.destroy()
    broadcast()
  }
  return state
}

export function cancelUpdateDownload(): UpdateState {
  if (!downloading) return state
  downloadCancelled = true
  ++downloadEpoch // 作废仍在路上的预检续体(它无句柄可撤,只能靠换代让归来后自行退场)
  if (inplaceActive && inplaceToken) {
    // 就地收尾(2026-11-06 codex 审查修复):取消在 electron-updater 侧只发 update-cancelled
    // 不发 error,等事件收尾会把 downloading 卡在真上(重试被挡)。这里直接回 idle;
    // update-cancelled 监听器见 setupUpdater,作为兜底幂等保险
    inplaceToken.cancel()
    inplaceActive = false
    inplaceToken = null
    downloading = false
    state.status = 'idle'
    state.downloadProgress = null
    broadcast()
    return state
  }
  if (downloadAbort) {
    downloadAbort.abort()
    return state
  }
  // 预检窗口(清单校验往返中):无活动句柄可撤,就地收尾回 idle
  downloading = false
  state.status = 'idle'
  state.downloadProgress = null
  broadcast()
  return state
}

/** 重启并安装(in-place 就绪态):Squirrel 换壳后自动拉起新版;非就绪态返回 false */
export function installUpdate(): boolean {
  if (state.status !== 'downloaded' || state.installMode !== 'inplace' || !updater) return false
  logDiag('update.install-quit', { version: state.version })
  updater.quitAndInstall(false, true)
  return true
}

/** 打开已下载的安装包;不可用时退回清单直链(浏览器打开) */
export async function openUpdateInstaller(): Promise<boolean> {
  if (state.downloadedPath && fs.existsSync(state.downloadedPath)) {
    const result = await shell.openPath(state.downloadedPath)
    if (!result) return true
    state.lastError = `打开安装包失败:${result}`
    broadcast()
  }
  if (state.downloadUrl) {
    await shell.openExternal(state.downloadUrl)
    return true
  }
  return false
}

/** 跳过/恢复某版本的提醒 */
export function skipUpdateVersion(version: string): UpdateState {
  const p = loadPrefs()
  const rest = p.skippedVersions.filter((v) => v !== version)
  const next = rest.length === p.skippedVersions.length ? [...p.skippedVersions, version] : rest
  savePrefs({ ...p, skippedVersions: next })
  refreshDerived()
  broadcast()
  return state
}

export function setUpdatePrefs(patch: UpdatePrefsPatch): UpdateState {
  const p = { ...loadPrefs(), ...patch }
  savePrefs(p)
  state.prefs = p
  refreshDerived()
  broadcast()
  maybeAutoDownload()
  return state
}

/** 用户看过「关于」页签,消红点 */
export function markUpdateSeen(): UpdateState {
  if (state.version) smetaSet(KEY_SEEN, state.version)
  refreshDerived()
  broadcast()
  return state
}
