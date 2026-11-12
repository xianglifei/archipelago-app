// 头像素材管线(0.7):从设计稿 HTML 提取 28 造型×4 配色底座 + 12 眼睛 PNG,
// 缩到 256px(macOS sips)并 pngquant 有损压缩,产出到 renderer 资产目录;
// 512 原档同时归档到 doc/design-assets/avatars-512/。
// 仅维护者重建素材用:依赖本机 pngquant(GPL,不在本仓依赖中,需 brew install pngquant 或 npm i -g pngquant-bin)
// 与本机设计原稿;产物已入库,开发者与构建无需运行本脚本。
// 用法: node scripts/prepare-avatars.mjs [--src ~/Downloads/Qundao_UI_v2.html]
// 产物入库后无需 CI 重跑;重新生成时整个目录会被覆盖。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const srcArg = args.indexOf('--src')
const SRC =
  srcArg >= 0 && args[srcArg + 1]
    ? args[srcArg + 1].replace(/^~(?=\/)/, os.homedir())
    : path.join(os.homedir(), 'Downloads', 'Qundao_UI_v2.html')

const OUT_AVATARS = path.join(root, 'src/renderer/src/assets/avatars')
const OUT_ARCHIVE = path.join(root, 'doc/design-assets/avatars-512')
const PNGQUANT = path.join(root, 'node_modules/.bin/pngquant')

const html = fs.readFileSync(SRC, 'utf8')

function grab(startMarker, endMarker) {
  const i = html.indexOf(startMarker)
  if (i < 0) throw new Error(`start not found: ${startMarker}`)
  const j = html.indexOf(endMarker, i)
  if (j < 0) throw new Error(`end not found: ${endMarker}`)
  return html.slice(i + startMarker.length, j).replace(/[;\s]+$/, '')
}

const assets = JSON.parse(grab('const ASSET_INDEX=', 'const EYE_INDEX'))
const eyes = JSON.parse(grab('const EYE_INDEX=', 'const FACE_ANCHORS'))
const faceAnchors = JSON.parse(grab('const FACE_ANCHORS=', 'const DEFAULT_EYES'))
const defaultEyes = JSON.parse(grab('const DEFAULT_EYES=', 'const BRAND_ICON'))

fs.rmSync(OUT_AVATARS, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT_AVATARS, 'bodies'), { recursive: true })
fs.mkdirSync(path.join(OUT_AVATARS, 'eyes'), { recursive: true })
fs.rmSync(OUT_ARCHIVE, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT_ARCHIVE, 'bodies'), { recursive: true })
fs.mkdirSync(path.join(OUT_ARCHIVE, 'eyes'), { recursive: true })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qundao-avatars-'))
let totalIn = 0
let totalOut = 0

function processPng(dataUri, outName, resize) {
  const b64 = dataUri.slice(dataUri.indexOf(',') + 1)
  const buf = Buffer.from(b64, 'base64')
  totalIn += buf.length
  const raw = path.join(tmp, `${outName.replaceAll('/', '__')}.raw.png`)
  fs.writeFileSync(raw, buf)
  // 512 原档归档(保留设计师交付原样)
  fs.writeFileSync(path.join(OUT_ARCHIVE, path.dirname(outName), `${path.basename(outName)}.png`), buf)

  const outPath = path.join(OUT_AVATARS, `${outName}.png`)
  if (resize) {
    execFileSync('sips', ['-Z', String(resize), raw, '--out', outPath, '-s', 'format', 'png'], {
      stdio: 'ignore'
    })
  } else {
    fs.copyFileSync(raw, outPath)
  }
  execFileSync(PNGQUANT, ['--quality=70-90', '--strip', '--force', '--output', outPath, outPath], {
    stdio: 'ignore'
  })
  totalOut += fs.statSync(outPath).size
}

for (const [id, a] of Object.entries(assets)) {
  a.images.forEach((dataUri, i) => {
    processPng(dataUri, `bodies/${id.padStart(2, '0')}_${'ABCD'[i]}`, 256)
  })
}
for (const [id, e] of Object.entries(eyes)) {
  processPng(e.src, `eyes/${id}`, 0)
}

// 目录数据(锚点/默认眼睛/HEX)供 shared/avatar.ts 生成参考,一并归档
fs.writeFileSync(
  path.join(OUT_ARCHIVE, 'manifest.json'),
  JSON.stringify(
    {
      source: path.basename(SRC),
      bodies: Object.entries(assets).map(([id, a]) => ({
        id: Number(id),
        name: a.name,
        colors: a.colors
      })),
      eyes: Object.entries(eyes).map(([id, e]) => ({ id, name: e.name })),
      faceAnchors,
      defaultEyes
    },
    null,
    2
  )
)

const count = Object.keys(assets).length * 4 + Object.keys(eyes).length
console.log(
  `${count} 个 PNG 处理完成 → ${path.relative(root, OUT_AVATARS)}(总计 ${(totalOut / 1048576).toFixed(1)}MB,原 ${(totalIn / 1048576).toFixed(1)}MB);512 原档归档至 doc/design-assets/avatars-512/`
)
fs.rmSync(tmp, { recursive: true, force: true })
