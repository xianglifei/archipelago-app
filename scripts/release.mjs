#!/usr/bin/env node
// 发布脚本(升级机制:第一阶段 update.json/DMG + 第二阶段 electron-updater zip 原地更新):
//   1. 校验更新源与产物:build.publish 与 src/main/updater.ts 两处 URL 一致且非占位域名
//   1.5 cloud 部署联动门禁:对比 cloud/ 源码指纹与本机部署台账(scripts/cloud-deploy-state.mjs),
//       (拆仓后本仓不含 cloud 源码;历史指纹门禁已摘,现行门禁=下方 1.5b 能力版本门禁。)
//       确认无关用 --cloud-pending-ok 显式跳过。这是机制不是提醒:换任何 session/agent 发版都会撞上同一道门。
//   2. 校验 CHANGELOG.md 已把 [未发布] 归档为当前版本小节,并取其中 <!--user-notes--> 块作为更新日志
//      (该块是面向用户的清洗版:新增在前修复在后、每行一条、只说做了什么,不写原因/历史/技术手段;
//       仓库详细版仅供开发参考,绝不原样透出到客户端「检查更新」窗口)
//   3. 生成 dist/update.json(静态升级清单:版本/notes/sha512/灰度/最低版本)
//   4. 上传(设置 R2_BUCKET 时自动执行,如 R2_BUCKET=archipelago-releases,走 wrangler)
//      顺序固定:先传安装包(含 zip blockmap、latest-mac.yml),最后传 update.json——清单是开关,永远指向完整产物
//      latest-mac.yml 上传前校验其引用的产物与本次一致:dist/ 混入其他架构/旧版本构建残留的 yml 会把更新源指向不存在的文件
//      Cache-Control 按文件分:两份清单 no-cache(latest-mac.yml 被 electron-updater 直接轮询,吃 CDN 缓存会让更新滞后),
//      dmg/zip/blockmap 文件名带版本,长缓存 immutable
//   5. 保留策略清理(scripts/r2-prune.mjs):上传全部成功后,该频道只保留最新 N 版(stable 默认 3、其他频道 1),
//      删除更旧版本的三件产物,防止桶随发版次数无限增长;清单文件永不动,清理失败只警告不阻断发版
//   6. 官网下载地址同步(仅 stable 频道,scripts/website-deploy.mjs):把 qundao.app 下载页的 Mac 按钮
//      指到刚上传的 DMG 直链并重新部署(Workers static assets,website/wrangler.jsonc),同步失败即拦下
//      发版收尾;确属无关的应急出口 --website-skip。href 改动写回 website/download.html,随收尾提交
//   7. GitHub Release 留档(仅 stable 频道):gh release create v<版本> 附本版 DMG,notes 复用第 2 步提取的
//      user-notes 块。R2 保留策略(第 5 步)只留最近 3 版,GitHub Release 是历史版本的永久档案
//      (私有库,资产下载需仓库读权限——组织成员/Read 协作者可下,对外分发仍走官网/R2)。
//      创建失败即拦下发版收尾;应急出口 --github-skip。幂等:release 已存在则跳过
//
// 用法:
//   npm run release                        # 全量发布
//   npm run release -- --rollout 30        # 30% 灰度(按机器稳定哈希分桶)
//   npm run release -- --min-version 0.2.0 # 低于此版本的用户强制升级
//   npm run release -- --channel test      # 传到 updates/test/(端到端验证原地更新用;app 内两处 URL 需同步指向该频道)
//   npm run release -- --keep 5            # 覆盖保留版本数(默认 stable 3、其他频道 1)
//   npm run release -- --no-prune          # 跳过发版后的旧版本清理
//   npm run release -- --cloud-pending-ok  # cloud 有未部署改动但确认与本版无关时,显式跳过 1.5 门禁
//   npm run release -- --pending-ok        # 应急:RELEASE-PENDING.md 有未完成前置事项仍强行发版(不推荐)
//   npm run release -- --website-skip      # 官网下载地址同步失败且确认与本版无关时,跳过第 6 步(不推荐)
//   npm run release -- --github-skip       # GitHub Release 留档失败且确认与本版无关时,跳过第 7 步(不推荐)
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pruneChannel } from './r2-prune.mjs'
import { evaluateGate } from './capability-gate-core.mjs'
import { parsePending, archiveDone } from './release-pending.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

// 发布频道:R2 上传前缀 updates/<channel>/;正式为 stable,test 供原地更新端到端验证
const channel = arg('channel', 'stable')
if (!/^[a-z0-9-]+$/.test(channel)) fail(`--channel 只能是小写字母/数字/连字符:${channel}`)

// ---- 1. 更新源校验 ----
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const feed = pkg.build?.publish?.[0]?.url
if (!feed) fail('package.json 的 build.publish 未配置更新源 URL')
if (!feed.endsWith('/')) fail(`build.publish.url 需要以 / 结尾:${feed}`)
if (!feed.endsWith(`/updates/${channel}/`)) {
  fail(`build.publish.url(${feed})与发布频道 ${channel} 不匹配:两处 URL 需指向 updates/${channel}/,否则 app 会从错误频道拉更新。`)
}
let host
try {
  host = new URL(feed).hostname
} catch {
  fail(`build.publish.url 不是合法 URL:${feed}`)
}
if (host.endsWith('.example')) {
  fail(`更新源还是占位域名(${feed})。请先在 Cloudflare R2 绑定真实域名,并同步替换 package.json build.publish 与 src/main/updater.ts 两处。`)
}
const updaterSrc = fs.readFileSync(path.join(root, 'src/main/updater.ts'), 'utf8')
const feedInCode = /FEED_URL = '([^']+)'/.exec(updaterSrc)?.[1]
if (feedInCode !== feed) {
  fail(`src/main/updater.ts 的 FEED_URL(${feedInCode ?? '未找到'})与 package.json build.publish.url(${feed})不一致,请先对齐。`)
}

// ---- 1.5(已摘除)cloud 源码指纹门禁 ----
// 2026-11-12 cloud 拆仓(xianglifei/archipelago-cloud)后本仓不再持有 cloud 源码,「源码指纹比对」失去比较对象,
// 指纹门禁正式移除;线上服务端兼容性由下方 1.5b 能力版本门禁承担(方案 §6.2,拆仓当日已部署生产并核验)。

// ---- 1.5b 能力版本门禁(阶段 2 协议,方案 §6.2 v2;终审:取代指纹门禁的新机制) ----
// 读构建期快照 out/build-manifest.json(绑定产物与需求,不读工作树),比对线上 sea 的
// GET /meta/capabilities:「REQUIRED ≤ 线上」逐项,缺失指名。失败分级(core=capability-gate-core.mjs):
//   incompatible(端点正常但缺能力)= 已知不兼容,唯一可用 --cloud-pending-ok 的类别(豁免留痕含线上 deploy 身份);
//   blocked(不可达/HTTP 错误/响应畸形)= 硬拦,逃生口不适用——与三域名探活同口径。
// 拆仓后本门禁为唯一服务端门禁(指纹门禁已随 cloud 源码迁出而移除,见上方 1.5 说明)。
const gateManifestPath = path.join(root, 'out', 'build-manifest.json')
if (!fs.existsSync(gateManifestPath)) {
  fail('缺 out/build-manifest.json——能力门禁读取构建期快照的能力需求,不读工作树;请先 npm run build(或 npm run dist)再发版。')
}
const gateManifest = JSON.parse(fs.readFileSync(gateManifestPath, 'utf8'))
const gateRequired = gateManifest.requiredCapabilities ?? {}
const gateUrl = 'https://sea.qundao.app/meta/capabilities'
let gateStatus = 0
let gateBody = ''
for (let attempt = 1; attempt <= 2; attempt++) {
  const gr = spawnSync('curl', ['-sS', '-m', '20', '-w', '\n%{http_code}', gateUrl], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  const out = gr.stdout || ''
  const sep = out.lastIndexOf('\n')
  gateStatus = Number(out.slice(sep + 1)) || 0
  gateBody = out.slice(0, sep)
  if (gateStatus === 200) break
  if (attempt === 1) {
    console.log(`… 能力端点首次查询未获 200(HTTP ${gateStatus || '不可达'}),3 秒后重试一次(有限重试,终审第 8 条)`)
    spawnSync('sleep', ['3'])
  }
}
const gate = evaluateGate({ httpStatus: gateStatus, bodyText: gateBody, required: gateRequired })
if (gate.verdict === 'pass') {
  console.log(`✓ 能力门禁通过:线上 ${gate.online.service} v${gate.online.protocolVersion},deploy=${String(gate.online.deploy).slice(0, 8)},需求 ${Object.keys(gateRequired).length} 项全满足`)
  if (gate.online.deploy === 'unknown') console.warn('⚠ 线上 deploy=unknown(部署身份注入链断裂)——不影响本次发版,但请检查 cloud 部署链(服务端 postflight 本应拦下)')
} else if (gate.verdict === 'incompatible') {
  console.error(`✗ 线上 sea 缺少本产物(v${gateManifest.version},构建 ${String(gateManifest.gitSha || '').slice(0, 8)})所需能力:`)
  for (const m of gate.missing) console.error(`  - ${m.name}:需要 ≥ ${m.required},线上 ${m.online ?? '缺失'}`)
  if (process.argv.includes('--cloud-pending-ok')) {
    console.error('⚠ 已按 --cloud-pending-ok 豁免本次能力缺失【豁免留痕】')
    console.error(`   检查目标:${gateUrl};线上 deploy=${JSON.stringify(gate.online.deploy)};缺失 ${gate.missing.length} 项:${gate.missing.map((m) => m.name).join(', ')}`)
    console.error('   豁免意味着本版可能在缺能力的线上运行对应功能劣化/不可用——发版后尽快补部署。')
  } else {
    console.error('  先在服务端仓(xianglifei/archipelago-cloud)执行 npm run deploy 部署新能力(部署链自动核验线上=本地)再发版;')
    console.error('  确认本版不依赖缺失能力:npm run release -- --cloud-pending-ok(豁免会被留痕打印)。')
    fail('能力版本门禁:线上缺本产物所需能力(见上)。')
  }
} else {
  fail(`能力版本门禁:sea 能力端点异常(${gate.reason}:${gate.detail})——非「已知不兼容」,--cloud-pending-ok 不适用;本机需代理出网时先 export https_proxy=http://127.0.0.1:7897。`)
}

// ---- 1.6 发版前置事项清单(RELEASE-PENDING.md) ----
// 各开发 session 登记的「发版前必须完成的配套动作」集中于此(AGENTS.md 约定:需要 cloud 配合/迁移/后台配置的功能,
// 落码 session 必须同步登记一条)。这里强制读取:有未勾选条目即拦下;完成勾 [x],成功发版后自动归档。
const pending = parsePending()
if (!pending.exists) {
  console.warn('⚠ 仓库缺少 RELEASE-PENDING.md(发版前置事项清单)——按 AGENTS.md 约定应存在,请补建,否则各 session 的发版备注无处集中。')
} else if (pending.open.length && !process.argv.includes('--pending-ok')) {
  console.error(`✗ RELEASE-PENDING.md 还有 ${pending.open.length} 条未完成的发版前置事项:`)
  for (const item of pending.open) console.error(`  - ${item}`)
  console.error('  逐条完成并把对应条目勾成 [x] 后再发版;确属应急:npm run release -- --pending-ok(不推荐,事后须补做)。')
  fail('发版前置事项未清空(见上)。')
} else if (!pending.open.length) {
  // 清单为空不是免检:逼发版者主动想一遍「本版真的没有 cloud 配合/后台配置类依赖吗」,登记遗漏在此现形
  console.log('ℹ RELEASE-PENDING.md 无未完成事项——发版者请确认本版确实不需要 cloud 配合/迁移/后台配置;若有而清单为空,说明开发 session 登记遗漏,先补登记再发版。')
}

// ---- 2. 版本与 CHANGELOG 校验 ----
const version = pkg.version
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const section = changelog.split(/^## /m).find((s) => s.startsWith(`[${version}]`))
if (!section) {
  fail(`CHANGELOG.md 里没有 [${version}] 小节——发版前先把 [未发布] 的内容归档为 [${version}] - 日期。`)
}
const userNotes = /<!--user-notes-->\s*\n([\s\S]*?)\s*<!--\/user-notes-->/.exec(section)?.[1]?.trim()
if (!userNotes) {
  fail(
    `CHANGELOG.md 的 [${version}] 小节缺少 <!--user-notes-->…<!--/user-notes--> 用户版更新日志块——` +
      '客户端检查更新窗口只展示该块(对详细版的清洗:新增在前修复在后、每行一条、只说做了什么,不写原因/历史/技术手段),归档版本小节时须同时写好。'
  )
}
const notes = userNotes

// ---- 3. 产物校验与清单生成 ----
const dist = path.join(root, 'dist')
const dmgName = `Archipelago-${version}-arm64.dmg`
const zipName = `Archipelago-${version}-arm64.zip`
for (const name of [dmgName, zipName]) {
  if (!fs.existsSync(path.join(dist, name))) fail(`缺少产物 dist/${name}——先运行 npm run dist`)
}
const dmgPath = path.join(dist, dmgName)
const sha512 = createHash('sha512').update(fs.readFileSync(dmgPath)).digest('hex')

const manifest = {
  channel,
  version,
  releaseDate: new Date().toISOString().slice(0, 10),
  minVersion: arg('min-version', null),
  rollout: Number(arg('rollout', '100')),
  notes,
  downloads: {
    'mac-arm64': {
      url: new URL(dmgName, feed).toString(),
      size: fs.statSync(dmgPath).size,
      sha512
    }
  }
}
if (!Number.isInteger(manifest.rollout) || manifest.rollout < 0 || manifest.rollout > 100) {
  fail('--rollout 需要是 0-100 的整数')
}
fs.writeFileSync(path.join(dist, 'update.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`✓ 已生成 dist/update.json(v${version},灰度 ${manifest.rollout}%)`)

// ---- 4. 上传:先包后清单 ----
const bucket = process.env.R2_BUCKET
const uploads = [dmgName, zipName]
const blockmapName = `${zipName}.blockmap`
if (fs.existsSync(path.join(dist, blockmapName))) {
  uploads.push(blockmapName) // zip 差分块,阶段二 electron-updater 增量更新用
}
const yml = path.join(dist, 'latest-mac.yml')
if (fs.existsSync(yml)) {
  // electron-builder 每次构建都会重写这张 yml;dist/ 里若残留其他架构/旧版本构建的结果,
  // yml 会指向本次根本不上传的产物(0.2.0 曾把 x64 构建写的 yml 传上 R2,指向未上传的 x64 dmg)
  const ymlText = fs.readFileSync(yml, 'utf8')
  const known = new Set([dmgName, zipName])
  const refs = [...new Set([...ymlText.matchAll(/^\s*(?:-\s*url|path):\s*(\S+)\s*$/gm)].map((m) => m[1]))]
  const problems = []
  const ymlVersion = /^version:\s*(\S+)\s*$/m.exec(ymlText)?.[1]
  if (ymlVersion !== version) problems.push(`版本 ${ymlVersion ?? '(缺失)'} ≠ ${version}`)
  for (const ref of refs) if (!known.has(ref)) problems.push(`产物 ${ref}`)
  if (problems.length) {
    fail(`dist/latest-mac.yml 与本次发布不一致(${problems.join(';')})。dist/ 里应是其他架构或旧版本构建的残留——重跑 npm run dist 覆盖后再发,或删掉该 yml(阶段二 electron-updater 启用前不上传不影响阶段一)。`)
  }
  if (!refs.includes(zipName)) {
    console.warn('⚠ latest-mac.yml 未引用 zip 产物:macOS 自动更新(electron-updater)只认 zip,请确认打包目标包含 zip')
  }
  uploads.push('latest-mac.yml') // 第二阶段 electron-updater 用
}
uploads.push('update.json')

const CONTENT_TYPES = {
  dmg: 'application/x-apple-diskimage',
  zip: 'application/zip',
  json: 'application/json',
  yml: 'text/plain'
}

// 两份清单是「开关」,必须每次都回源;安装包/差分块文件名带版本,内容不可变可长缓存
function cacheControlFor(name) {
  if (name === 'update.json' || name === 'latest-mac.yml') return 'no-cache'
  if (/\.(dmg|zip|blockmap)$/.test(name)) return 'public, max-age=31536000, immutable'
  return 'no-cache'
}

// B1(终审版):从 origin URL 解析 owner/name,支持 https / git@ / ssh:// 三种形态并剥 .git 后缀;
// 非标准地址(自建别名等)返回 null,由调用方要求显式 --repo 或 RELEASE_REPO
function githubRepoFromOrigin() {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const m = r.stdout.trim().match(/(?:^|[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

// B1:查远端 tag 指向的提交(annotated tag 取 ^{} peeled 行);tag 不存在或查询失败返回 null
function remoteTagCommit(remote, tag) {
  const r = spawnSync('git', ['ls-remote', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  const line = lines.find((l) => l.endsWith(`refs/tags/${tag}^{}`)) ?? lines.find((l) => l.endsWith(`refs/tags/${tag}`))
  return line ? line.split('\t')[0].trim() : null
}

function putCommand(name) {
  const ct = CONTENT_TYPES[name.split('.').pop()] ?? 'application/octet-stream'
  return [
    'r2',
    'object',
    'put',
    `${bucket}/updates/${channel}/${name}`,
    '--file',
    path.join(dist, name),
    '--content-type',
    ct,
    '--cache-control',
    cacheControlFor(name),
    '--remote'
  ]
}

if (bucket) {
  // ---- 4a. GitHub 留档预检(B1 终审版:预检前移到 R2 上传之前——原实现 gh/tag 检查在收尾的留档步骤里,
  //      失败时版本已经上线;现在任何失败都停在版本公开之前,回退零成本)----
  // 仅 stable 且未 --github-skip 时执行。检查链:gh 可用 → 发布仓解析(--repo 参数 > RELEASE_REPO 环境变量 >
  // origin 解析)→ 远端 tag 已存在(gh release create 遇不存在的 tag 会从默认分支 HEAD 自动创建,可能指错提交)
  // → tag 提交在当前提交历史内(tag 打在别的分支=留档与本次构建不对应)。
  const githubTag = `v${version}`
  const githubArchiveEnabled = channel === 'stable' && !process.argv.includes('--github-skip')
  let githubRepo = null
  if (githubArchiveEnabled) {
    if (spawnSync('gh', ['--version']).status !== 0) {
      fail('未找到 gh CLI——发版收尾需要它创建 GitHub Release 留档,请先安装(brew install gh)并 gh auth login。')
    }
    githubRepo = arg('repo') ?? process.env.RELEASE_REPO ?? githubRepoFromOrigin()
    if (!githubRepo) {
      fail('无法确定发布仓:origin 不是标准 GitHub 地址,且未提供 --repo <owner/name> 参数或 RELEASE_REPO 环境变量。')
    }
    const tagCommit = remoteTagCommit('origin', githubTag)
    if (!tagCommit) {
      fail(`远端 origin 没有 tag ${githubTag}——先打 tag 并推送(git tag ${githubTag} && git push origin ${githubTag})再重跑发版,否则 gh 会从默认分支 HEAD 自动建 tag,可能指错提交。`)
    }
    if (spawnSync('git', ['merge-base', '--is-ancestor', tagCommit, 'HEAD']).status !== 0) {
      fail(`远端 tag ${githubTag}(${tagCommit.slice(0, 8)})不在当前提交历史中——tag 可能打在别的分支上,留档会与本次构建不对应,请先核对再发版。`)
    }
    console.log(`✓ GitHub 留档预检通过:repo=${githubRepo},tag=${githubTag}(${tagCommit.slice(0, 8)})`)
  }

  for (const name of uploads) {
    console.log(`↑ 上传 ${name} …`)
    const r = spawnSync('wrangler', putCommand(name), { stdio: 'inherit' })
    if (r.status !== 0) fail(`wrangler 上传失败:${name}(先确认 wrangler login 已登录且账号有 R2 权限)`)
  }
  console.log(`✓ v${version} 已发布到 R2 桶 ${bucket} 频道 ${channel}(${feed})`)

  // ---- 5. 保留策略清理:新版本完全上线之后再删旧版,清理失败只警告不阻断 ----
  if (process.argv.includes('--no-prune')) {
    console.log('已指定 --no-prune,跳过旧版本清理')
  } else {
    const keep = Number(arg('keep', channel === 'stable' ? '3' : '1'))
    try {
      await pruneChannel({ bucket, channel, keep, releasedVersion: version, dryRun: process.argv.includes('--prune-dry-run') })
    } catch (e) {
      console.warn(`⚠ 保留策略清理失败(不影响本次发版,旧版本下次发版会再试):${e.message}`)
    }
  }

  // ---- 6. 官网下载地址同步(仅正式频道):新 DMG 已公开可下载,把 qundao.app 下载页指到它并重新部署 ----
  // 机制:website/download.html 的下载按钮 href 由 scripts/website-deploy.mjs 更新+部署;
  // 失败即拦下发版收尾——官网下载指向旧版/断链比多一步手工更糟。与本版无关的应急出口:--website-skip
  // (B2 修复:留档原嵌套在本步 else 内,--website-skip 会连带静默跳过留档;现留档为独立第 7 步)
  if (channel !== 'stable') {
    console.log(`频道 ${channel} 非正式版,跳过官网下载地址同步`)
  } else if (process.argv.includes('--website-skip')) {
    console.log('已指定 --website-skip,跳过官网下载地址同步(下版记得补跑 npm run website:deploy;GitHub 留档不受影响,仍按第 7 步执行)')
  } else {
    const wd = spawnSync('node', [path.join(root, 'scripts/website-deploy.mjs'), '--url', new URL(dmgName, feed).toString()], {
      stdio: 'inherit',
      cwd: root,
    })
    if (wd.status !== 0) fail(`官网下载地址同步失败(原因见上方输出;确认与本版无关可加 --website-skip 重跑发版)`)
  }

  // ---- 7. GitHub Release 留档(仅 stable 频道,与第 6 步同级——B2 修复):R2 保留策略只留最近 3 版,
  // 这里把本版 DMG 永久留档。定位更新(拆仓拍板):公开仓的 Release 资产人人可下载,是官网/R2 之外的
  // 第三条公开分发渠道。失败即拦下发版收尾——留档缺口比多一步手工更糟;应急出口 --github-skip。
  // 发布仓与 tag 已在第 4a 步预检(githubRepo/githubTag);幂等语义升级(B1):release 已存在时不再盲目
  // 跳过,核对 DMG 资产在位,缺失则补传(重跑半途失败的场景不会留下永久资产缺口)。
  if (!githubArchiveEnabled) {
    console.log(
      channel !== 'stable'
        ? `频道 ${channel} 非正式版,跳过 GitHub Release 留档`
        : '已指定 --github-skip,跳过 GitHub Release 留档(下版记得补建:gh release create 附本版 DMG)'
    )
  } else {
    const view = spawnSync('gh', ['release', 'view', githubTag, '--repo', githubRepo, '--json', 'assets'], { encoding: 'utf8' })
    if (view.status === 0) {
      let hasDmg = false
      try {
        const parsed = JSON.parse(view.stdout)
        hasDmg = Array.isArray(parsed.assets) && parsed.assets.some((a) => a.name === dmgName)
      } catch {
        // 响应非 JSON:hasDmg 保持 false,走补传(补传幂等,不会重复创建)
      }
      if (hasDmg) {
        console.log(`✓ GitHub Release ${githubTag} 已存在且含 ${dmgName},跳过留档`)
      } else {
        console.log(`· GitHub Release ${githubTag} 已存在但缺 ${dmgName},补传资产…`)
        const up = spawnSync('gh', ['release', 'upload', githubTag, dmgPath, '--repo', githubRepo], { stdio: 'inherit', cwd: root })
        if (up.status !== 0) {
          fail('留档资产补传失败(原因见上方输出)。排查:gh auth login 已登录?本机 GitHub API 被墙先 export https_proxy=http://127.0.0.1:7897?')
        }
      }
    } else {
      console.log(`· 创建 GitHub Release ${githubTag} 并上传 ${dmgName}(体积较大,稍候)…`)
      const r = spawnSync(
        'gh',
        ['release', 'create', githubTag, dmgPath, '--repo', githubRepo, '--title', githubTag, '--notes', notes, '--latest', '--verify-tag'],
        { stdio: 'inherit', cwd: root }
      )
      if (r.status !== 0) {
        fail(
          'GitHub Release 留档失败(原因见上方输出)。排查:gh auth login 已登录?本机 GitHub API 被墙先 export https_proxy=http://127.0.0.1:7897?' +
            '确认与本版无关可加 --github-skip 重跑发版(留档缺口需手工补建)。'
        )
      }
    }
  }

  // ---- 8. 收尾归档(B5 修复:原在 R2 上传成功后立即归档 RELEASE-PENDING,官网同步/留档失败时「已完成」
  // 记录已被清,与「成功发版后归档」约定不符;现移到官网同步与留档全部通过之后——中途任何 fail 退出
  // 均不归档,清单保留原状,失败阶段已在上面的错误信息中指明)----
  if (pending.done.length) {
    archiveDone()
    console.log(`✓ 已归档 RELEASE-PENDING.md 的 ${pending.done.length} 条已完成事项`)
  }
} else {
  console.log('未设置 R2_BUCKET,跳过自动上传。手动上传(顺序勿变,update.json 最后):')
  for (const name of uploads) {
    console.log(
      `  wrangler r2 object put archipelago-releases/updates/${channel}/${name} --file dist/${name} --cache-control "${cacheControlFor(name)}" --remote`
    )
  }
  if (pending.done.length) {
    console.log('⚠ 手动模式未归档 RELEASE-PENDING.md 已完成事项,上传确认成功后请自行清理 [x] 条目(或补跑一次带 R2_BUCKET 的 release)。')
  }
}
