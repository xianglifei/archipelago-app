// 官网部署 + 下载地址同步(qundao.app / www.qundao.app,Workers static assets)
//
// 做三件事:
//   1. 确定最新正式版 DMG 直链(--url 优先;否则按 package.json 版本从更新源推导),HEAD 探活——
//      不允许把官网下载按钮指向 404
//   2. 把 website/download.html 的 Mac 下载按钮 href 指到该直链,并同步按钮下方状态行的
//      版本号标注「v<版本> · Apple Silicon」(版本从 DMG 文件名解析,Windows 先占号时也比
//      package.json 权威);设计稿激活态标记已在,若设计稿重建把按钮还原成「待配置」态,
//      这里会响亮报错并给出恢复指引
//   3. 组装 website/.site/(index.html/download.html/whatsnew.html/_headers)并 wrangler deploy,
//      部署后按域探活(见第 6 节口径)并校验线上下载页已含目标直链、新功能页已上最新内容
//
// 用法:
//   npm run website:deploy                      # 按 package.json 版本推导直链
//   node scripts/website-deploy.mjs --url <url> # 发版链/release.mjs 用:传刚上传的直链
//   node scripts/website-deploy.mjs --no-write  # 只部署不改仓库文件(要求当前 href 已是目标直链)
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const siteDir = path.join(root, 'website')
const stageDir = path.join(siteDir, '.site')

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}

// curl 多通道:直连 → 本机代理 → 公共解析(1.1.1.1)+ --resolve 兜底
// (本机/代理节点 resolver 不稳或负缓存时,借 1.1.1.1 拿边缘 IP 直连,验证的是我们真正负责的 CF 边缘链路)
function curlCode(url, extra = []) {
  const r = spawnSync('curl', ['-sI', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', ...extra, url], { encoding: 'utf8' })
  return r.stdout
}
function viaProxy(url) {
  return curlCode(url, ['-x', 'http://127.0.0.1:7897'])
}
function resolveAny(url) {
  const m = url.match(/^https:\/\/([a-z0-9.]+)\//)
  if (!m) return '000'
  for (const host of [m[1], 'www.qundao.app']) {
    const dig = spawnSync('dig', ['@1.1.1.1', '+short', '+time=2', '+tries=1', host, 'A'], { encoding: 'utf8' })
    const ip = (dig.stdout || '').split('\n').map((l) => l.trim()).filter((l) => /^\d+\./.test(l))[0]
    if (ip) {
      const c = curlCode(url, ['--resolve', `${m[1]}:443:${ip}`])
      if (c && c !== '000') return c
    }
  }
  return '000'
}
function codeAny(url) {
  return [curlCode(url), viaProxy(url), resolveAny(url)].find((c) => c && c !== '000') ?? '000'
}
function fetchAny(url) {
  for (const extra of [[], ['-x', 'http://127.0.0.1:7897']]) {
    const r = spawnSync('curl', ['-sL', '-m', '10', ...extra, url], { encoding: 'utf8' })
    if (r.stdout) return r.stdout
  }
  const m = url.match(/^https:\/\/([a-z0-9.]+)\//)
  if (m) {
    for (const host of [m[1], 'www.qundao.app']) {
      const dig = spawnSync('dig', ['@1.1.1.1', '+short', '+time=2', '+tries=1', host, 'A'], { encoding: 'utf8' })
      const ip = (dig.stdout || '').split('\n').map((l) => l.trim()).filter((l) => /^\d+\./.test(l))[0]
      if (ip) {
        const r = spawnSync('curl', ['-sL', '-m', '10', '--resolve', `${m[1]}:443:${ip}`, url], { encoding: 'utf8' })
        if (r.stdout) return r.stdout
      }
    }
  }
  return ''
}

// ---- 1. 目标直链 ----
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const feed = pkg.build?.publish?.[0]?.url
if (!feed) fail('package.json 的 build.publish 未配置更新源 URL,无法推导 DMG 直链')
const dmgUrl = arg('url') ?? new URL(`Archipelago-${pkg.version}-arm64.dmg`, feed).toString()
if (!/^https:\/\//.test(dmgUrl)) fail(`DMG 直链必须是 HTTPS:${dmgUrl}`)
console.log(`· 目标下载直链:${dmgUrl}`)

// ---- 2. 探活直链 ----
if (codeAny(dmgUrl) !== '200') fail(`DMG 直链探活失败(非 200):${dmgUrl}——不允许把官网指向不可下载的地址`)
console.log('✓ 直链探活 200')

// ---- 3. 同步下载按钮 href + 状态行版本号 ----
const dlPath = path.join(siteDir, 'download.html')
const html = fs.readFileSync(dlPath, 'utf8')
const dmgName = dmgUrl.split('/').pop() ?? ''
const verMatch = dmgName.match(/^Archipelago-(.+)-arm64\.dmg$/)
if (!verMatch) fail(`无法从 DMG 文件名解析版本号:${dmgName}(期望 Archipelago-<版本>-arm64.dmg)`)
const macVersion = verMatch[1]
const macStatusLabel = `v${macVersion} · Apple Silicon`
const anchorRe = /(<a class="download-action" href=")[^"]+(" aria-describedby="mac-status">)/
const statusRe = /(<p id="mac-status" class="availability">)[^<]*(<\/p>)/
if (!anchorRe.test(html)) {
  fail(
    'website/download.html 里找不到激活态 Mac 下载按钮(<a class="download-action" href=…>)。' +
      '多半是设计稿重建(build_site.py)把按钮还原成了「待配置」disabled 态——' +
      '按 design-kit/website-2026-11-02/本地修改记录.md 恢复激活态标记(文案「下载 Mac 版 ↓」的 a 标签 + meta 去「待配置」)后重试;' +
      '状态行文字随意恢复,本脚本会自动重写为「v<版本> · Apple Silicon」。'
  )
}
if (!statusRe.test(html)) {
  fail('website/download.html 里找不到 Mac 状态行(<p id="mac-status" class="availability">)——检查 download.html 结构是否被改动。')
}
if (process.argv.includes('--no-write')) {
  console.log('已指定 --no-write,跳过写入(要求当前 href 已是目标直链、状态行已是最新版本号)')
  if (!html.includes(dmgUrl)) fail(`--no-write 但当前 href 不是目标直链 ${dmgUrl}`)
  if (!html.includes(macStatusLabel)) fail(`--no-write 但 Mac 状态行不是「${macStatusLabel}」`)
} else {
  const next = html
    .replace(anchorRe, `$1${dmgUrl}$2`)
    .replace(statusRe, `$1${macStatusLabel}$2`)
  if (next !== html) {
    fs.writeFileSync(dlPath, next)
    console.log('✓ 下载按钮 href 与状态行版本号已更新并写回 website/download.html(记得随收尾提交)')
  } else {
    console.log('· 下载按钮 href 与状态行版本号已是最新,无需改动')
  }
}

// ---- 4. 组装部署目录(三页 + _headers + assets/ 外置图 + 落地页插画;README/wrangler.jsonc 不部署;
//      whatsnew-archive.html 档案页刻意不上线——「更多版本历史」入口隐藏期,线上不可达) ----
fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(stageDir)
for (const name of ['index.html', 'download.html', 'whatsnew.html', '_headers', 'invite-hero.webp']) {
  fs.copyFileSync(path.join(siteDir, name), path.join(stageDir, name))
}
// 图片资源目录(2026-11-05 起三页图片外置,scripts/website-extract-assets.mjs 维护)
fs.cpSync(path.join(siteDir, 'assets'), path.join(stageDir, 'assets'), { recursive: true })

// ---- 5. 部署 ----
// 落地页 worker 纯 JS:语法错=落地页整页空白(2026-10-26 usage 事故同类红线),部署前必检
const check = spawnSync('node', ['--check', 'website/invite-landing.js'], { cwd: root, encoding: 'utf-8' })
if (check.status !== 0) fail(`website/invite-landing.js 语法检查失败:\n${check.stderr || check.stdout}`)
const r = spawnSync('npx', ['wrangler', 'deploy', '-c', 'website/wrangler.jsonc'], { cwd: root, stdio: 'inherit' })
if (r.status !== 0) fail('wrangler deploy 失败(website/wrangler.jsonc:assets=website/.site,双 Custom Domain)')

// ---- 6. 探活 ----
// 页面(apex/www/下载页):必须 200(任何通道)。
// sea/api/usage:对齐 cloud postflight 口径——拿到非 5xx 的 HTTP 响应即算活(根路径 404 是 worker 正常应答);
// 它们不通=存量域受影响,必须立即回查 cloud。
const pages = ['https://qundao.app/', 'https://qundao.app/download', 'https://qundao.app/whatsnew', 'https://www.qundao.app/']
const siblings = ['https://sea.qundao.app/', 'https://api.qundao.app/', 'https://usage.qundao.app/']
function pageOk(u) {
  return codeAny(u) === '200'
}
function siblingOk(u) {
  const c = codeAny(u)
  return c !== '000' && !c.startsWith('5')
}
for (let attempt = 1; attempt <= 3; attempt++) {
  const badPages = pages.filter((u) => !pageOk(u))
  const badSib = siblings.filter((u) => !siblingOk(u))
  console.log(`· 探活:${badPages.length + badSib.length === 0 ? '全通' : '未全通'}(attempt ${attempt}/3,新域名证书就绪可能需几分钟)`)
  if (badPages.length + badSib.length === 0) break
  if (attempt === 3) {
    if (badSib.length) fail(`存量域探活未通:${badSib.join(' ')}——sea/api/usage 受影响,立即回查 cloud 部署与 DNS!`)
    fail(`官网探活未通:${badPages.join(' ')}(新域名证书就绪可能需几分钟;稍后手动复查 https://qundao.app/ )`)
  }
  await new Promise((res) => setTimeout(res, 20000))
}

// ---- 7. 线上内容校验:下载页必须已含目标直链;新功能页必须已上最新内容 ----
const served = fetchAny('https://qundao.app/download') || fetchAny('https://www.qundao.app/download.html')
if (!served.includes(dmgUrl)) fail('线上 download.html 未包含目标直链(可能吃到 CDN 旧缓存,等 max-age=300 过期后复查)')
if (!served.includes(macStatusLabel)) fail(`线上 download.html 未包含 Mac 版本号标注「${macStatusLabel}」(可能吃到 CDN 旧缓存,等 max-age=300 过期后复查)`)
const servedWn = fetchAny('https://qundao.app/whatsnew') || fetchAny('https://www.qundao.app/whatsnew.html')
if (!servedWn.includes('新功能')) fail('线上 whatsnew 页未包含「新功能」内容(可能吃到 CDN 旧缓存,等 max-age=300 过期后复查)')
console.log(`✓ 官网部署完成:qundao.app / www.qundao.app 全通,下载页已指向最新 DMG(标注 ${macStatusLabel}),新功能页已上线`)
