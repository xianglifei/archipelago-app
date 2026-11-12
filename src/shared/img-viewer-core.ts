// 内置图片查看器(2026-11-06 拍板:独立单例窗 + 原样字节原图 + 适应窗口默认):
// 图片判定与缩放纯函数,渲染层(入口分流/缩放控件)与主进程(读取校验)与单测三方共用(零 electron 依赖)。
// 与内嵌缩略图通道(markdown-image-core.ts)口径分工:那边 8MB/800px 是气泡口径,
// 这边不缩放只设上限,详见 attachments.ts readImageFullForViewer。

/** 查看器原图读取上限:覆盖常见照片与截图(dataURL 膨胀 4/3 后单例窗可控),超出诚实报「太大」 */
export const IMAGE_VIEWER_MAX_BYTES = 32 * 1024 * 1024

/** 查看器格式白名单:与展示/附件通道一致(.png/.jpg/.jpeg/.webp/.bmp + .gif 动图);
 *  本地 .svg 维持 not-image(现状口径,data: 形态罕见不在查看器扩) */
const VIEWER_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

/** 判定是否查看器可开的图片:只认后缀(大小写不敏感);入口分流(openFileSmart)与读取校验同源 */
export function isImagePath(path: string): boolean {
  const lower = path.toLowerCase()
  for (const ext of VIEWER_IMAGE_EXTS) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

/** 缩放百分比上下限:5% 起步(长图全览仍有细节)、400% 封顶(截图看字够用,再大没有意义) */
export const ZOOM_MIN_PCT = 5
export const ZOOM_MAX_PCT = 400

/** 把百分比钳进上下限 */
export function clampZoomPercent(pct: number): number {
  if (!Number.isFinite(pct)) return 100
  return Math.min(ZOOM_MAX_PCT, Math.max(ZOOM_MIN_PCT, Math.round(pct)))
}

/** 适应窗口:图完整塞进画布的整数百分比(允许小图放大到 100% 以上;参数异常回落 100 不炸渲染) */
export function fitScalePercent(natW: number, natH: number, boxW: number, boxH: number): number {
  if (!(natW > 0) || !(natH > 0) || !(boxW > 0) || !(boxH > 0)) return 100
  const scale = Math.min(boxW / natW, boxH / natH)
  return clampZoomPercent(scale * 100)
}

/** 缩放键步进:×1.25 / ÷1.25(取整,5% 以下步进会抹成 0,钳制兜住) */
export function zoomStepIn(pct: number): number {
  return clampZoomPercent(pct * 1.25)
}

export function zoomStepOut(pct: number): number {
  return clampZoomPercent(pct / 1.25)
}
