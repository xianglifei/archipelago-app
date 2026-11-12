// 官网页面资源外置工具(2026-11-05):把 index/download/whatsnew 三页内嵌的 base64 图片
// 拆成 website/assets/ 下内容寻址文件(sha256 前 16 位命名),HTML 引用改相对路径。
//
// 背景:设计师交付的单文件形态(曾 17MB,压图后仍 4.3MB)把 48 张图以 base64 内嵌进
// index.html——HTML 是渲染阻塞资源,直连网络下首页 4.3MB 常传不完(2026-11-05 实测
// 60s 仅 1.8~2.2MB 即断流),gzip 对 base64 高熵数据也无效。外置后首页约 110KB,
// 图片走 immutable 长缓存 + 跨页复用(_headers 已加 /assets/* 规则)。
//
// 幂等:重复跑零改动;design-kit build_site.py 重建回单文件态后,重跑本脚本即恢复拆分。
// favicon(<link rel="icon">)刻意保留内嵌:省一次请求,是内嵌的正确用法。
// 附带修复(同样幂等):①index.html CSP img-src 放行 'self'(外置图,漏改=图全挂);
// ②非首屏 <img> 补 loading="lazy" decoding="async"(每页前 2 个视为首屏,不加)。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const siteDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'website')
const assetsDir = path.join(siteDir, 'assets')
const pages = ['index.html', 'download.html', 'whatsnew.html']
const dataUrlRe = /data:image\/(webp|png);base64,([A-Za-z0-9+/=]+)/g

fs.mkdirSync(assetsDir, { recursive: true })

let extracted = 0
let deduped = 0
const written = []

for (const page of pages) {
  const file = path.join(siteDir, page)
  let html = fs.readFileSync(file, 'utf8')
  const before = html

  // favicon 判定用:data URL 紧跟 rel="icon" 之后,回看窗口足够覆盖 <link rel="icon" href="
  html = html.replace(dataUrlRe, (m, ext, b64, offset, whole) => {
    const lookback = whole.slice(Math.max(0, offset - 120), offset)
    if (lookback.includes('rel="icon"')) return m
    const bin = Buffer.from(b64, 'base64')
    const name = `${crypto.createHash('sha256').update(bin).digest('hex').slice(0, 16)}.${ext}`
    const out = path.join(assetsDir, name)
    if (fs.existsSync(out)) {
      if (fs.readFileSync(out).equals(bin)) deduped++
    } else {
      fs.writeFileSync(out, bin)
      written.push(name)
    }
    extracted++
    return `assets/${name}`
  })

  // CSP:外置图必须放行 'self'(幂等:已含则跳过)
  if (page === 'index.html') {
    const cspFrom = 'img-src data:;'
    const cspTo = "img-src 'self' data:;"
    if (html.includes(cspFrom)) html = html.replace(cspFrom, cspTo)
  }

  // 非首屏 img 懒加载:每页前 2 个 <img> 视为首屏(首屏背景画 + 导航 logo)不加,其余补
  let imgSeen = 0
  html = html.replace(/<img\b[^>]*>/g, (tag) => {
    imgSeen++
    if (imgSeen <= 2 || /\bloading=/.test(tag)) return tag
    return tag.replace(/^<img\b/, '<img loading="lazy" decoding="async"')
  })

  if (html !== before) {
    fs.writeFileSync(file, html)
    console.log(`✓ ${page}:已更新`)
  } else {
    console.log(`· ${page}:无改动(已是拆分态)`)
  }
}

console.log(
  `共外置 ${extracted} 处引用(其中跨文件去重命中 ${deduped} 次),` +
    `落盘 ${written.length} 个新文件,assets/ 现有 ${fs.readdirSync(assetsDir).length} 个`
)

// 自检:除 favicon 外不允许残留内嵌图
let leftover = 0
for (const page of pages) {
  const html = fs.readFileSync(path.join(siteDir, page), 'utf8')
  for (const m of html.matchAll(dataUrlRe)) {
    const i = m.index ?? 0
    if (html.slice(Math.max(0, i - 120), i).includes('rel="icon"')) continue
    leftover++
    console.error(`✗ ${page} 残留内嵌图(前缀 ${m[0].slice(0, 60)}…)`)
  }
}
if (leftover > 0) process.exit(1)
console.log('✓ 自检通过:三页无残留内嵌图(仅 favicon 按设计保留)')
