// 文档站部署 + 线上探活(docs.qundao.app,Cloudflare Workers 静态资产)
//
// 做四件事:
//   1. 构建静态产物(docs/ → docs/out/),产物不存在就响亮失败——不部署空站
//   2. wrangler deploy(assets-only 配置,见 docs/wrangler.jsonc)
//   3. 按域探活:根路径必须 301 → /docs;文档首页 / 一个深层页 / 搜索索引 / llms.txt / robots / sitemap,
//      外加一条 404 必须真的是 404
//   4. 校验线上内容真的是本次产物(标题、关键正文、搜索索引类型),不是 CDN 旧缓存
//
// 用法:
//   npm run docs:deploy                 # 构建 + 部署 + 探活
//   node scripts/docs-deploy.mjs --skip-build   # 产物已构建,只部署(CI 里构建与部署分两步时用)
//   node scripts/docs-deploy.mjs --dry-run      # 只构建并检查产物,不部署(PR 预检)
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docsDir = path.join(root, 'docs')
const outDir = path.join(docsDir, 'out')
const siteUrl = 'https://docs.qundao.app'

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

const has = (name) => process.argv.includes(`--${name}`)

// curl 多通道:直连 → 本机代理 → 公共解析(1.1.1.1)+ --resolve 兜底
// (与 website-deploy.mjs 同口径:验证的是我们真正负责的 CF 边缘链路,不被本机 resolver 干扰)
// 取 HEAD 的状态码与 Location:根路径要验证「301 到 /docs」,只看状态码不够。
// (curl 不跟随重定向,这里拿到的就是边缘的真实响应)
function curlHead(url, extra = []) {
  const r = spawnSync('curl', ['-sI', '-m', '8', ...extra, url], { encoding: 'utf8' })
  const out = r.stdout || ''
  // 走代理时可能先出现一条 CONNECT 的状态行,取最后一条才是目标响应
  const statuses = [...out.matchAll(/^HTTP\/[\d.]+ (\d{3})/gm)]
  const last = statuses[statuses.length - 1]
  return {
    code: last?.[1] ?? '000',
    location: out.match(/^location:\s*(\S+)/im)?.[1] ?? '',
  }
}
function edgeIp(url) {
  const m = url.match(/^https:\/\/([a-z0-9.]+)\//)
  if (!m) return null
  const dig = spawnSync('dig', ['@1.1.1.1', '+short', '+time=2', '+tries=1', m[1], 'A'], { encoding: 'utf8' })
  const ip = (dig.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+\./.test(l))[0]
  return ip ? { host: m[1], ip } : null
}
function headAny(url) {
  for (const extra of [[], ['-x', 'http://127.0.0.1:7897']]) {
    const res = curlHead(url, extra)
    if (res.code !== '000') return res
  }
  const edge = edgeIp(url)
  if (!edge) return { code: '000', location: '' }
  return curlHead(url, ['--resolve', `${edge.host}:443:${edge.ip}`])
}
function codeAny(url) {
  return headAny(url).code
}
function fetchAny(url) {
  for (const extra of [[], ['-x', 'http://127.0.0.1:7897']]) {
    const r = spawnSync('curl', ['-sL', '-m', '12', ...extra, url], { encoding: 'utf8' })
    if (r.stdout) return r.stdout
  }
  const edge = edgeIp(url)
  if (edge) {
    const r = spawnSync('curl', ['-sL', '-m', '12', '--resolve', `${edge.host}:443:${edge.ip}`, url], { encoding: 'utf8' })
    if (r.stdout) return r.stdout
  }
  return ''
}

// ---- 1. 构建 ----
if (has('skip-build')) {
  console.log('· 已指定 --skip-build,跳过构建')
} else {
  console.log('· 构建文档站(docs/)…')
  const r = spawnSync('npm', ['run', 'build'], { cwd: docsDir, stdio: 'inherit' })
  if (r.status !== 0) fail('next build 失败(先看上面的报错;常见原因:MDX 语法错、frontmatter 缺 title)')
}

// 根路径已经没有 index.html:它是 public/_redirects 里的一条 301 → /docs。
// 这条规则没随产物发布,根域名就会 404,所以产物自检要盯住它。
if (!fs.existsSync(path.join(outDir, 'docs.html'))) fail('docs/out/docs.html 不存在——文档首页没被导出,检查 content/docs/index.mdx')
if (!fs.existsSync(path.join(outDir, 'api/search'))) fail('docs/out/api/search 不存在——搜索索引没生成,检查 app/api/search/route.ts')
const redirectsFile = path.join(outDir, '_redirects')
if (!fs.existsSync(redirectsFile)) fail('docs/out/_redirects 不存在——根路径的重定向没随 public/ 拷进产物')
if (!/^\/\s+\/docs\s+301\b/m.test(fs.readFileSync(redirectsFile, 'utf8'))) {
  fail('docs/out/_redirects 里缺少「/ /docs 301」——docs.qundao.app 根路径不会跳到文档首页')
}
console.log(`✓ 产物就绪:${(fs.statSync(path.join(outDir, 'docs.html')).size / 1024).toFixed(0)}KB 文档首页,根路径 301 → /docs`)

if (has('dry-run')) {
  console.log('✓ --dry-run:产物检查通过,未部署')
  process.exit(0)
}

// ---- 2. 部署 ----
const d = spawnSync('npx', ['wrangler', 'deploy', '-c', 'wrangler.jsonc'], { cwd: docsDir, stdio: 'inherit' })
if (d.status !== 0) fail('wrangler deploy 失败(检查 Cloudflare 凭据与 docs/wrangler.jsonc;首次部署域名证书可能需几分钟)')

// ---- 3. 探活 ----
// 根路径必须是 301 → /docs;文档首页与深层页必须是 200;api/search 与 llms.txt 必须是 200;
// 不存在的路径必须是 404(证明 not_found_handling 生效,而不是把首页当兜底返回)
const pages = [`${siteUrl}/docs`, `${siteUrl}/docs/concepts/permissions`]
const assets = [`${siteUrl}/api/search`, `${siteUrl}/llms.txt`, `${siteUrl}/robots.txt`, `${siteUrl}/sitemap.xml`]
const notFound = `${siteUrl}/__docs-deploy-probe-not-found`

let lastProblem = ''
for (let attempt = 1; attempt <= 3; attempt++) {
  const root = headAny(`${siteUrl}/`)
  const badPages = pages.filter((u) => codeAny(u) !== '200')
  const badAssets = assets.filter((u) => codeAny(u) !== '200')
  const nfCode = codeAny(notFound)
  const problems = []
  if (root.code !== '301' || !/\/docs\/?$/.test(root.location)) {
    problems.push(`根路径没跳到 /docs(实际 ${root.code} → ${root.location || '无 Location'},期望 301 → /docs)`)
  }
  if (badPages.length) problems.push(`页面非 200:${badPages.join(' ')}`)
  if (badAssets.length) problems.push(`静态资源非 200:${badAssets.join(' ')}`)
  if (nfCode !== '404') problems.push(`不存在的路径返回 ${nfCode}(期望 404)`)
  lastProblem = problems.join(';')
  console.log(`· 探活:${problems.length === 0 ? '全通' : '未全通'}(attempt ${attempt}/3,新域名证书就绪可能需几分钟)`)
  if (problems.length === 0) break
  if (attempt < 3) await new Promise((res) => setTimeout(res, 20000))
}
if (lastProblem) fail(`文档站探活未通:${lastProblem}`)

// ---- 4. 线上内容校验(防吃到旧缓存 / 部署到了旧产物) ----
const docsHome = fetchAny(`${siteUrl}/docs`)
if (!docsHome.includes('群岛文档')) fail('线上文档首页未包含「群岛文档」——可能吃到旧缓存,等 max-age=300 过期后复查')

const perms = fetchAny(`${siteUrl}/docs/concepts/permissions`)
if (!perms.includes('审批卡')) fail('线上「权限与审批」页未包含关键正文「审批卡」——检查部署产物与 CDN 缓存')

const search = fetchAny(`${siteUrl}/api/search`)
if (!search.includes('"type":"advanced"')) fail('线上搜索索引不是预期结构(缺 advanced 标记)——检查 docs/out/api/search 是否被正确上传')

console.log(`✓ 文档站部署完成:${siteUrl} → /docs 全通,根路径 301、深层页、搜索索引、llms.txt 均已就位`)
