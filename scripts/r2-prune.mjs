#!/usr/bin/env node
// R2 发版桶保留策略:每个频道、每个平台各保留最新 N 个版本(stable 默认 3,test 等验证频道默认 1),
// Mac(arm64 三件 dmg/zip/blockmap)与 Windows(x64 的 exe/exe.blockmap)分开计数互不影响
// (2026-11-04 双平台约定:Windows 低频推送,不挤占 Mac 保留窗口);清单文件(update.json/latest*.yml)
// 与带 -bN 后缀的手动测试包不匹配文件名规则,永不纳入删除。
// 留旧版的两个用途:回滚时重发清单指向旧产物 + electron-updater 差分更新要拉用户旧版本的 blockmap;
// 删了也不影响更新:旧 blockmap 拿不到时 electron-updater 自动回退全量下载新版 zip。
// 可独立运行做一次性清理,也由 scripts/release.mjs 在上传全部成功后自动调用:
//   node scripts/r2-prune.mjs --channel stable --keep 3 --dry-run
// 列对象走 Cloudflare REST(wrangler 没有 r2 object list 子命令);令牌复用 wrangler 登录态——
// 必须先跑一次 wrangler whoami 强制刷新 OAuth 令牌再读凭据文件,否则可能拿到一小时前过期的旧令牌。
// 删除走 wrangler r2 object delete(R2 DeleteObject 是免费操作)。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const VERSIONED = /^Archipelago-(\d+\.\d+\.\d+)-(arm64|x64)\./

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i] // 降序:新版本在前
}

// 拿 wrangler 的登录凭据;whoami 会顺带把快过期的 OAuth 令牌刷新并写回配置文件
function wranglerCredentials() {
  const r = spawnSync('wrangler', ['whoami'], { encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`wrangler whoami 失败,先确认 wrangler login:${(r.stderr || '').trim().slice(0, 200)}`)
  }
  // eslint-disable-next-line no-control-regex -- 剥离 wrangler 输出的 ANSI 色码,\x1b 正是要匹配的目标字符
  const out = (r.stdout || '').replace(/\u001b\[[0-9;]*m/g, '')
  const configPath = /Credentials are stored in: (.+)/.exec(out)?.[1]?.trim()
  const accountId = /\b[0-9a-f]{32}\b/.exec(out)?.[0]
  const token =
    configPath && fs.existsSync(configPath)
      ? /^oauth_token\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(configPath, 'utf8'))?.[1]
      : null
  if (!configPath || !accountId || !token) {
    throw new Error('无法从 wrangler whoami 输出解析凭据文件路径 / 账号 ID / OAuth 令牌')
  }
  return { accountId, token }
}

async function listChannelObjects({ accountId, token, bucket, prefix }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects?per_page=1000&prefix=${encodeURIComponent(prefix)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success) {
    throw new Error(`列对象失败 HTTP ${res.status}:${JSON.stringify(body?.errors ?? body).slice(0, 300)}`)
  }
  if (body.result.length >= 1000) {
    throw new Error('频道内对象 ≥1000,超出单页列举能力,请先人工检查桶内容')
  }
  return body.result.map((o) => ({ key: o.key, size: o.size }))
}

// 清理一个频道:保留最新 keep 个版本;releasedVersion 为本次刚发布的版本号,无条件保留
// (防低版本号热修复刚上传就被自己的清理逻辑删掉)。返回实际保留/删除的版本列表。
export async function pruneChannel({ bucket, channel, keep, releasedVersion = null, dryRun = false }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep 需要是 ≥1 的整数,当前:${keep}`)
  const prefix = `updates/${channel}/`
  const { accountId, token } = wranglerCredentials()
  const objects = await listChannelObjects({ accountId, token, bucket, prefix })

  // 按平台分桶计数(2026-11-04):key=`版本|平台`,两平台各自留 keep 个,互不挤占
  const byVersionPlatform = new Map()
  for (const o of objects) {
    const m = VERSIONED.exec(o.key.slice(prefix.length))
    if (!m) continue // 清单或未知命名的文件,一律不碰
    const key = `${m[1]}|${m[2]}`
    if (!byVersionPlatform.has(key)) byVersionPlatform.set(key, [])
    byVersionPlatform.get(key).push(o)
  }
  if (byVersionPlatform.size === 0) {
    console.log(`保留策略:${prefix} 下没有版本产物,无需清理`)
    return { kept: [], deleted: [] }
  }

  const keepSet = new Set()
  const kept = []
  for (const platform of ['arm64', 'x64']) {
    const versions = [...byVersionPlatform.keys()]
      .filter((k) => k.endsWith(`|${platform}`))
      .map((k) => k.split('|')[0])
      .sort(compareVersions)
    if (versions.length === 0) continue
    const platformKeep = new Set(versions.slice(0, keep))
    if (releasedVersion) platformKeep.add(releasedVersion) // 本次刚发布的版本号无条件保留(防低版本热修被自家清掉)
    for (const v of versions) {
      const key = `${v}|${platform}`
      if (platformKeep.has(v)) {
        keepSet.add(key)
        kept.push(`${v}(${platform})`)
      }
    }
  }
  const dropped = [...byVersionPlatform.keys()].filter((k) => !keepSet.has(k))
  const dropFiles = dropped.flatMap((v) => byVersionPlatform.get(v))
  const dropBytes = dropFiles.reduce((s, f) => s + f.size, 0)
  if (dropped.length === 0) {
    console.log(`保留策略:${prefix} 保留 ${kept.join('、')},没有超出保留窗口的旧版本`)
    return { kept, deleted: [] }
  }
  console.log(
    `保留策略:${prefix} 保留 ${kept.join('、')} → 删除 ${dropped.map((k) => k.replace('|', '(') + ')').join('、')}(${dropFiles.length} 个文件,约 ${(dropBytes / 1e6).toFixed(0)} MB)`
  )
  if (dryRun) {
    for (const f of dropFiles) console.log(`  [dry-run] 将删除 ${f.key}`)
    console.log('  [dry-run] 未执行删除')
    return { kept, deleted: [] }
  }

  const deleted = []
  for (const f of dropFiles) {
    const r = spawnSync('wrangler', ['r2', 'object', 'delete', `${bucket}/${f.key}`, '--remote'], { encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(`删除失败 ${f.key}:${(r.stderr || r.stdout || '').trim().slice(0, 200)}`)
    }
    deleted.push(f.key)
  }
  console.log(`✓ 已删除 ${deleted.length} 个旧版本文件`)
  return { kept, deleted }
}

// ---- 独立运行入口(一次性清理/验证用):node scripts/r2-prune.mjs --channel test --keep 1 [--dry-run] ----
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
  }
  const channel = arg('channel', 'stable')
  if (!/^[a-z0-9-]+$/.test(channel)) fail(`--channel 只能是小写字母/数字/连字符:${channel}`)
  const keep = Number(arg('keep', channel === 'stable' ? '3' : '1'))
  const bucket = arg('bucket', process.env.R2_BUCKET ?? 'archipelago-releases')
  pruneChannel({ bucket, channel, keep, dryRun: process.argv.includes('--dry-run') }).catch((e) => fail(e.message))
}
