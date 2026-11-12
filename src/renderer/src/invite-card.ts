// 邀请函分享图(2026-11-03 邀请函重做):1080×1620 canvas 自绘,视觉定稿=doc/原型 - 邀请函分享图 - 2026-11-03.html,
// 本文件坐标与该原型 CSS 逐元素 1:1(全绝对定位),改版式先改原型定稿再同步这里。
// 底图为预合成素材(运营插画上移 458px 露出三只小动物 + 底部纯海面渐变延长,交界色实测取样;
// 合成过程见需求文档 §5.2),绘制顺序:底图 → 题字 → 骑缝邮票 → 信纸卡 → 码格/QR → footer。

import QRCode from 'qrcode'
import i18next from 'i18next'
import inviteBg from './assets/invite-bg.webp'

export interface InviteCardInput {
  code: string
  link: string
  islandName: string
  ownerName: string
  artworkUrl?: string
}

const t = (key: string): string => i18next.t(key, { defaultValue: '' })

const W = 1080
const H = 1620

// 邮票锯齿边框(252×300,每 16px 一个 r=5 内凹半圆;与原型 SVG path 同源参数,Path2D 直接吃 SVG d)
const STAMP_TEETH_D =
  'M 0 0 L 3.0 0.0 A 5.0 5.0 0 0 0 13.0 0.0 L 19.0 0.0 A 5.0 5.0 0 0 0 29.0 0.0 L 35.0 0.0 A 5.0 5.0 0 0 0 45.0 0.0 L 51.0 0.0 A 5.0 5.0 0 0 0 61.0 0.0 L 67.0 0.0 A 5.0 5.0 0 0 0 77.0 0.0 L 83.0 0.0 A 5.0 5.0 0 0 0 93.0 0.0 L 99.0 0.0 A 5.0 5.0 0 0 0 109.0 0.0 L 115.0 0.0 A 5.0 5.0 0 0 0 125.0 0.0 L 131.0 0.0 A 5.0 5.0 0 0 0 141.0 0.0 L 147.0 0.0 A 5.0 5.0 0 0 0 157.0 0.0 L 163.0 0.0 A 5.0 5.0 0 0 0 173.0 0.0 L 179.0 0.0 A 5.0 5.0 0 0 0 189.0 0.0 L 195.0 0.0 A 5.0 5.0 0 0 0 205.0 0.0 L 211.0 0.0 A 5.0 5.0 0 0 0 221.0 0.0 L 227.0 0.0 A 5.0 5.0 0 0 0 237.0 0.0 L 241.0 0.0 A 5.0 5.0 0 0 0 251.0 0.0 L 252.0 0.0 L 252.0 3.0 A 5.0 5.0 0 0 0 252.0 13.0 L 252.0 19.0 A 5.0 5.0 0 0 0 252.0 29.0 L 252.0 35.0 A 5.0 5.0 0 0 0 252.0 45.0 L 252.0 51.0 A 5.0 5.0 0 0 0 252.0 61.0 L 252.0 67.0 A 5.0 5.0 0 0 0 252.0 77.0 L 252.0 83.0 A 5.0 5.0 0 0 0 252.0 93.0 L 252.0 99.0 A 5.0 5.0 0 0 0 252.0 109.0 L 252.0 115.0 A 5.0 5.0 0 0 0 252.0 125.0 L 252.0 131.0 A 5.0 5.0 0 0 0 252.0 141.0 L 252.0 147.0 A 5.0 5.0 0 0 0 252.0 157.0 L 252.0 163.0 A 5.0 5.0 0 0 0 252.0 173.0 L 252.0 179.0 A 5.0 5.0 0 0 0 252.0 189.0 L 252.0 195.0 A 5.0 5.0 0 0 0 252.0 205.0 L 252.0 211.0 A 5.0 5.0 0 0 0 252.0 221.0 L 252.0 227.0 A 5.0 5.0 0 0 0 252.0 237.0 L 252.0 243.0 A 5.0 5.0 0 0 0 252.0 253.0 L 252.0 259.0 A 5.0 5.0 0 0 0 252.0 269.0 L 252.0 275.0 A 5.0 5.0 0 0 0 252.0 285.0 L 252.0 289.0 A 5.0 5.0 0 0 0 252.0 299.0 L 252.0 300.0 L 249.0 300.0 A 5.0 5.0 0 0 0 239.0 300.0 L 233.0 300.0 A 5.0 5.0 0 0 0 223.0 300.0 L 217.0 300.0 A 5.0 5.0 0 0 0 207.0 300.0 L 201.0 300.0 A 5.0 5.0 0 0 0 191.0 300.0 L 185.0 300.0 A 5.0 5.0 0 0 0 175.0 300.0 L 169.0 300.0 A 5.0 5.0 0 0 0 159.0 300.0 L 153.0 300.0 A 5.0 5.0 0 0 0 143.0 300.0 L 137.0 300.0 A 5.0 5.0 0 0 0 127.0 300.0 L 121.0 300.0 A 5.0 5.0 0 0 0 111.0 300.0 L 105.0 300.0 A 5.0 5.0 0 0 0 95.0 300.0 L 89.0 300.0 A 5.0 5.0 0 0 0 79.0 300.0 L 73.0 300.0 A 5.0 5.0 0 0 0 63.0 300.0 L 57.0 300.0 A 5.0 5.0 0 0 0 47.0 300.0 L 41.0 300.0 A 5.0 5.0 0 0 0 31.0 300.0 L 25.0 300.0 A 5.0 5.0 0 0 0 15.0 300.0 L 11.0 300.0 A 5.0 5.0 0 0 0 1.0 300.0 L 0.0 300.0 L 0.0 297.0 A 5.0 5.0 0 0 0 0.0 287.0 L 0.0 281.0 A 5.0 5.0 0 0 0 0.0 271.0 L 0.0 265.0 A 5.0 5.0 0 0 0 0.0 255.0 L 0.0 249.0 A 5.0 5.0 0 0 0 0.0 239.0 L 0.0 233.0 A 5.0 5.0 0 0 0 0.0 223.0 L 0.0 217.0 A 5.0 5.0 0 0 0 0.0 207.0 L 0.0 201.0 A 5.0 5.0 0 0 0 0.0 191.0 L 0.0 185.0 A 5.0 5.0 0 0 0 0.0 175.0 L 0.0 169.0 A 5.0 5.0 0 0 0 0.0 159.0 L 0.0 153.0 A 5.0 5.0 0 0 0 0.0 143.0 L 0.0 137.0 A 5.0 5.0 0 0 0 0.0 127.0 L 0.0 121.0 A 5.0 5.0 0 0 0 0.0 111.0 L 0.0 105.0 A 5.0 5.0 0 0 0 0.0 95.0 L 0.0 89.0 A 5.0 5.0 0 0 0 0.0 79.0 L 0.0 73.0 A 5.0 5.0 0 0 0 0.0 63.0 L 0.0 57.0 A 5.0 5.0 0 0 0 0.0 47.0 L 0.0 41.0 A 5.0 5.0 0 0 0 0.0 31.0 L 0.0 25.0 A 5.0 5.0 0 0 0 0.0 15.0 L 0.0 11.0 A 5.0 5.0 0 0 0 0.0 1.0 L 0.0 0.0 Z'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`invite-card: asset load failed ${src.slice(0, 60)}`))
    img.src = src
  })
}

function setShadow(ctx: CanvasRenderingContext2D, color: string, blur: number, offsetY = 0): void {
  ctx.shadowColor = color
  ctx.shadowBlur = blur
  ctx.shadowOffsetY = offsetY
  ctx.shadowOffsetX = 0
}

function clearShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/** 带字距的文本(Chromium ctx.letterSpacing;字距只影响本次绘制,画完复位) */
function spacedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
  if (spacing > 0) {
    c.letterSpacing = `${spacing}px`
    ctx.fillText(text, x, y)
    c.letterSpacing = '0px'
  } else {
    ctx.fillText(text, x, y)
  }
}

function dateLabel(): string {
  const d = new Date()
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

/** 生成分享图 PNG dataURL(1080×1620);QR 指向短链,高容错保证微信压缩后可扫 */
export async function renderInviteCardPng(input: InviteCardInput): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('invite-card: canvas 2d unavailable')

  // 1) 预合成底图(插画上移+海面渐变延长)
  ctx.drawImage(await loadImage(inviteBg), 0, 0, W, H)

  // 2) 题字「—— 邀请函 ——」:宋体 900 白字 + 柔影,两侧短横线
  ctx.textBaseline = 'alphabetic'
  ctx.font = '900 86px "Songti SC", "STSong", "SimSun", serif'
  ctx.fillStyle = '#FFFFFF'
  setShadow(ctx, 'rgba(16,62,62,.45)', 22, 5)
  spacedText(ctx, t('post.cardTitle'), 393, 268, 18)
  clearShadow(ctx)
  ctx.fillStyle = 'rgba(255,255,255,.92)'
  for (const dx of [317, 713]) {
    setShadow(ctx, 'rgba(16,62,62,.40)', 5, 1)
    roundRect(ctx, dx, 233, 50, 3, 2)
    ctx.fill()
    clearShadow(ctx)
  }

  // 3) 邮票组:骑缝贴在信纸卡右上角(票体 252×300 旋转 3°)+ 橙红邮戳压左下
  ctx.save()
  ctx.translate(732 + 126, 726 + 150)
  ctx.rotate((3 * Math.PI) / 180)
  ctx.save()
  setShadow(ctx, 'rgba(20,60,50,.28)', 14, 8)
  ctx.fillStyle = '#FFFFFF'
  ctx.fill(new Path2D(STAMP_TEETH_D))
  ctx.restore()
  clearShadow(ctx)
  if (input.artworkUrl) {
    try {
      const art = await loadImage(input.artworkUrl)
      ctx.drawImage(art, -110, -134, 220, 220)
    } catch {
      // 原画加载失败:留白票体,不阻断分享图
    }
  }
  ctx.fillStyle = '#6D7E76'
  ctx.font = '600 19px -apple-system, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif'
  ctx.fillText('80', 68, -112)
  ctx.font = '400 17px -apple-system, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif'
  spacedText(ctx, t('post.cardPost'), -58, 130, 8)
  ctx.restore()

  // 3b) 邮戳:红褐虚线双圆 + 三行字,压邮票左下角
  ctx.save()
  ctx.translate(732 - 56 + 66, 726 + 300 - 34 - 66 + 34)
  ctx.rotate((-14 * Math.PI) / 180)
  ctx.globalAlpha = 0.78
  ctx.strokeStyle = '#D65A3B'
  ctx.lineWidth = 2.5
  ctx.setLineDash([6, 5])
  ctx.beginPath()
  ctx.arc(0, 0, 62, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(0, 0, 51, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = '#D65A3B'
  ctx.textAlign = 'center'
  ctx.font = '600 21px -apple-system, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif'
  spacedText(ctx, t('post.cardPostMark'), 0, -12, 3)
  ctx.font = '400 13px -apple-system, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif'
  ctx.fillText('QUNDAO POST', 0, 10)
  ctx.fillText(dateLabel(), 0, 30)
  ctx.restore()
  ctx.textAlign = 'left'

  // 4) 信纸卡(米白圆角 + 大柔和投影)
  setShadow(ctx, 'rgba(13,70,70,.30)', 48, 22)
  ctx.fillStyle = '#F7F5EE'
  roundRect(ctx, 70, 856, 940, 694, 36)
  ctx.fill()
  clearShadow(ctx)

  // 5) 邀请语(sheet 内左对齐 x=142)
  ctx.fillStyle = '#1E8B85'
  ctx.font = '600 44px -apple-system, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif'
  let x = 142
  spacedText(ctx, input.islandName, x, 968, 3)
  x += ctx.measureText(input.islandName).width + 3 * input.islandName.length + 12
  ctx.fillStyle = '#B9C9C2'
  ctx.fillText('·', x, 966)
  x += 12 + 18
  ctx.fillStyle = '#1E8B85'
  spacedText(ctx, `${t('post.cardOwner')} ${input.ownerName}`, x, 968, 3)
  ctx.fillStyle = '#3A5450'
  ctx.font = '400 36px -apple-system, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif'
  spacedText(ctx, t('post.cardInviteLine'), 142, 1042, 4)

  // 6) 六格码(120×144,gap 15)
  const chars = input.code.split('')
  for (let i = 0; i < 6; i++) {
    const cx = 142 + i * 135
    setShadow(ctx, 'rgba(30,139,133,.10)', 14, 6)
    ctx.fillStyle = '#FFFFFF'
    roundRect(ctx, cx, 1080, 120, 144, 16)
    ctx.fill()
    clearShadow(ctx)
    ctx.strokeStyle = '#CBE6F5'
    ctx.lineWidth = 1.5
    roundRect(ctx, cx, 1080, 120, 144, 16)
    ctx.stroke()
    const ch = chars[i] ?? ''
    ctx.fillStyle = '#1E8B85'
    ctx.font = '700 80px -apple-system, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif'
    ctx.textAlign = 'center'
    spacedText(ctx, ch, cx + 60, 1186, 0)
    ctx.textAlign = 'left'
  }
  ctx.fillStyle = '#7A9B93'
  ctx.font = '400 22px -apple-system, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif'
  ctx.textAlign = 'center'
  spacedText(ctx, t('post.codeLabel'), 540, 1272, 12)
  ctx.textAlign = 'left'

  // 7) QR 卡 + 右侧说明
  setShadow(ctx, 'rgba(30,139,133,.10)', 14, 6)
  ctx.fillStyle = '#FFFFFF'
  roundRect(ctx, 142, 1308, 190, 190, 16)
  ctx.fill()
  clearShadow(ctx)
  ctx.strokeStyle = '#CBE6F5'
  ctx.lineWidth = 1.5
  roundRect(ctx, 142, 1308, 190, 190, 16)
  ctx.stroke()
  try {
    const qrData = await QRCode.toDataURL(input.link, { width: 400, margin: 0, errorCorrectionLevel: 'H', color: { dark: '#203F3B', light: '#FFFFFF' } })
    ctx.drawImage(await loadImage(qrData), 154, 1320, 166, 166)
  } catch {
    // QR 生成失败:留白卡,码与短链仍在(信息不丢)
  }
  ctx.fillStyle = '#3A5450'
  ctx.font = '600 29px -apple-system, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif'
  spacedText(ctx, t('post.cardQrHint'), 368, 1392, 2)
  ctx.font = '400 24px -apple-system, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif'
  const l2a = t('post.cardQrAltA')
  const l2b = t('post.cardQrAltB')
  const l2c = t('post.cardQrAltC')
  spacedText(ctx, l2a, 368, 1434, 2)
  const wa = ctx.measureText(l2a).width + 2 * l2a.length
  ctx.fillStyle = '#1E8B85'
  spacedText(ctx, l2b, 368 + wa, 1434, 2)
  const wb = ctx.measureText(l2b).width + 2 * l2b.length
  ctx.fillStyle = '#7A9B93'
  spacedText(ctx, l2c, 368 + wa + wb, 1434, 2)

  // 8) footer:海面上的品牌行
  ctx.textAlign = 'center'
  ctx.fillStyle = '#FFFFFF'
  ctx.font = '500 24px -apple-system, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif'
  setShadow(ctx, 'rgba(10,60,60,.45)', 8, 1)
  spacedText(ctx, 'qundao.app', 540, 1590, 6)
  clearShadow(ctx)
  ctx.textAlign = 'left'

  return canvas.toDataURL('image/png')
}
