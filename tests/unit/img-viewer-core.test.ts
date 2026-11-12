// 内置图片查看器纯函数断言(2026-11-06):入口分流判定与缩放数学的共用底座
// (渲染层 openFileSmart 分流 / ImgViewerApp 缩放控件 / 主进程读取校验三方同源)
import { describe, expect, it } from 'vitest'
import {
  fitScalePercent,
  isImagePath,
  zoomStepIn,
  zoomStepOut,
  clampZoomPercent,
  IMAGE_VIEWER_MAX_BYTES,
  ZOOM_MIN_PCT,
  ZOOM_MAX_PCT
} from '../../src/shared/img-viewer-core'

describe('isImagePath(入口分流与读取校验同源)', () => {
  it('白名单后缀全过(大小写不敏感)', () => {
    for (const p of ['/tmp/a.png', '/tmp/a.JPG', '~/群岛/图.JPEG', 'C:\\Users\\x\\a.webp', '/tmp/a.bmp', '/tmp/动图.Gif']) {
      expect(isImagePath(p)).toBe(true)
    }
  })

  it('非图片与易混后缀拒绝(.svg 本地文件维持 not-image 口径)', () => {
    for (const p of ['/tmp/a.md', '/tmp/a.svg', '/tmp/a.pngx', '/tmp/a', '/tmp/a.txt', '/tmp/.png备份']) {
      expect(isImagePath(p)).toBe(false)
    }
  })
})

describe('fitScalePercent(适应窗口)', () => {
  it('宽高双侧取小:4000×2500 塞进 800×400 → 16%', () => {
    expect(fitScalePercent(4000, 2500, 800, 400)).toBe(16)
  })

  it('小图允许放大:800×500 塞进 1000×1000 → 125%', () => {
    expect(fitScalePercent(800, 500, 1000, 1000)).toBe(125)
  })

  it('参数异常回落 100 不炸渲染(零尺寸守卫)', () => {
    expect(fitScalePercent(0, 500, 800, 400)).toBe(100)
    expect(fitScalePercent(400, 0, 800, 400)).toBe(100)
    expect(fitScalePercent(400, 500, 0, 400)).toBe(100)
    expect(fitScalePercent(400, 500, 800, 0)).toBe(100)
  })
})

describe('缩放键步进与钳制', () => {
  it('clampZoomPercent 上下限', () => {
    expect(clampZoomPercent(1)).toBe(ZOOM_MIN_PCT)
    expect(clampZoomPercent(9999)).toBe(ZOOM_MAX_PCT)
    expect(clampZoomPercent(50)).toBe(50)
    expect(clampZoomPercent(Number.NaN)).toBe(100)
  })

  it('步进 ×1.25 / ÷1.25(取整)', () => {
    expect(zoomStepIn(100)).toBe(125)
    expect(zoomStepOut(100)).toBe(80)
    expect(zoomStepIn(80)).toBe(100)
  })

  it('下限附近步进不抹零:5% 缩小仍钉在 5%', () => {
    expect(zoomStepOut(ZOOM_MIN_PCT)).toBe(ZOOM_MIN_PCT)
    expect(zoomStepIn(ZOOM_MAX_PCT)).toBe(ZOOM_MAX_PCT)
  })
})

describe('上限常量(与方案拍板一致)', () => {
  it('原图 32MB;缩放 5%–400%', () => {
    expect(IMAGE_VIEWER_MAX_BYTES).toBe(32 * 1024 * 1024)
    expect(ZOOM_MIN_PCT).toBe(5)
    expect(ZOOM_MAX_PCT).toBe(400)
  })
})
