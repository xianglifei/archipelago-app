// 消息附件(2026-10-29 输入框升级):选择/粘贴/拖拽三入口统一 intake,
// 文件/文件夹=原始路径引用(居民用 read_file/list_dir 按需读),
// 图片=nativeImage 先缩(长边 1568)后落岛数据目录副本,消息只存路径+小图 dataURL
// 纯逻辑(解析/说明行/降级判定)在 attachments-core.ts,供 sessions/groups 与冒烟测试共用
import { randomUUID } from 'node:crypto'
import { dialog, nativeImage, type BrowserWindow, type OpenDialogOptions } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AttachmentIntakeItem, ImageFullReadResult, ImageReadResult, MessageAttachment } from '@shared/types'
import { IMAGE_DISPLAY_MAX_BYTES } from '@shared/markdown-image-core'
// isImagePath 别名避开本地同名:本地版是附件管线口径(不含 .gif,「模型只看首帧」拍板),
// shared 版是查看器/分流口径(含 .gif 动图),两者语义刻意不同
import { IMAGE_VIEWER_MAX_BYTES, isImagePath as isViewerImagePath } from '@shared/img-viewer-core'
import { requireDataRoot } from './paths'
import { uiStr } from './ui-strings'

export { attachmentLines, isImageUnsupportedError } from '@shared/attachments-core'

/** 直读内联进 LLM 的图片(OpenAI 兼容 image_url 分段) */
export interface LlmImagePart {
  type: 'image_url'
  image_url: { url: string }
}

/** 会随图片内联变化的语义由 prompts.ts 的系统提示解释;这里只管搬运 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
/** GIF 按文件处理(拍板 2026-10-29):多帧动图模型只取首帧,用户会误以为模型看过了全图 */
const MAX_EDGE = 1568
const JPEG_QUALITY = 85
const MAX_ATTACHMENTS_PER_MESSAGE = 20

function attachmentsDir(): string {
  const dir = path.join(requireDataRoot(), 'attachments')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf(path.sep) + 1) || p
}

function isImagePath(p: string): boolean {
  return IMAGE_EXTS.has(path.extname(p).toLowerCase())
}

/** 图片字节 → 缩放落盘副本 + 小图 dataURL;nativeImage 解不了的格式抛错(调用方降级为文件引用) */
function stageImageBytes(bytes: Buffer, ext: string, name: string): MessageAttachment {
  const img = nativeImage.createFromBuffer(bytes)
  if (img.isEmpty()) throw new Error(`不支持的图片格式:${name}`)
  const { width, height } = img.getSize()
  let scaled = img
  if (width > MAX_EDGE || height > MAX_EDGE) {
    // 只给长边,nativeImage 自动保纵横比
    scaled = img.resize(
      width >= height ? { width: MAX_EDGE, quality: 'good' } : { height: MAX_EDGE, quality: 'good' }
    )
  }
  let out = scaled.toJPEG(JPEG_QUALITY)
  let outExt = '.jpg'
  // 重编码反而更大(常见于小 PNG)且原图本来就不大:原样保留
  if (bytes.length <= out.length && bytes.length <= 1_500_000) {
    out = bytes
    outExt = ext || '.png'
  }
  const file = path.join(attachmentsDir(), `${randomUUID()}${outExt}`)
  fs.writeFileSync(file, out)
  const thumbBytes = scaled.resize({ width: 320, quality: 'good' }).toJPEG(70)
  return {
    kind: 'image',
    path: file,
    name,
    size: out.length,
    thumb: `data:image/jpeg;base64,${thumbBytes.toString('base64')}`
  }
}

/** 无路径的图片字节(截图/网页复制):从 dataURL 落盘成副本 */
function stageImageDataUrl(dataUrl: string, name: string): MessageAttachment {
  const m = /^data:image\/(png|jpeg|jpg|webp|bmp);base64,(.+)$/i.exec(dataUrl.trim())
  if (!m) throw new Error(`不是可识别的图片:${name}`)
  const ext = `.${m[1]!.toLowerCase().replace('jpeg', 'jpg')}`
  return stageImageBytes(Buffer.from(m[2]!, 'base64'), ext, name)
}

/** 有真实路径的文件/文件夹:stat 分类;图片(非 GIF)落成缩放副本,其余原路径引用 */
function classifyPath(p: string): MessageAttachment {
  const stat = fs.statSync(p) // 调用方已保证存在;这里抛错由 intake 统一兜
  const name = baseName(p)
  if (stat.isDirectory()) return { kind: 'dir', path: p, name }
  if (isImagePath(p)) return stageImageBytes(fs.readFileSync(p), path.extname(p).toLowerCase(), name)
  return { kind: 'file', path: p, name, size: stat.size }
}

/**
 * 三入口统一分流:粘贴/拖拽进来的项要么带真实路径(Finder 复制/拖入),
 * 要么是无路径图片字节(截图)。分类不了的路径(不存在)静默跳过并打日志。
 * 返回就绪的附件列表(图片已完成缩放落盘)。
 */
export function intakeAttachments(items: AttachmentIntakeItem[]): MessageAttachment[] {
  const out: MessageAttachment[] = []
  for (const item of items.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    try {
      if ('path' in item && item.path) {
        out.push(classifyPath(item.path))
      } else if ('dataUrl' in item && item.dataUrl) {
        const name = item.name?.trim() || `截图-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`
        out.push(stageImageDataUrl(item.dataUrl, name))
      }
    } catch (err) {
      // 单个失败不拖垮整批(如 Finder 复制的临时文件已消失、解不了的图片格式)
      console.warn('[attachments] 跳过一项:', err instanceof Error ? err.message : err)
    }
  }
  return out
}

/** 回形针选择模式(2026-11-04 W4):mac 保留文件+文件夹混选;Windows 原生对话框不支持混选
 *  (openFile+openDirectory 同给时实际只能选目录),拆 file/dir 两模式,由渲染层回形针二选一入口分流。
 *  mode 由主进程枚举校验(ipc.ts),不透传渲染层提交的任意 dialog options。 */
export type AttachPickMode = 'mixed' | 'file' | 'dir'

/** 回形针:原生对话框 → 统一 intake */
export async function pickAttachments(
  win: BrowserWindow | null,
  mode: AttachPickMode = 'mixed'
): Promise<MessageAttachment[]> {
  if (!win) return []
  const properties: OpenDialogOptions['properties'] =
    mode === 'dir'
      ? ['openDirectory', 'multiSelections']
      : mode === 'file'
        ? ['openFile', 'multiSelections']
        : ['openFile', 'openDirectory', 'multiSelections']
  const title = uiStr(mode === 'dir' ? 'pickFolderTitle' : mode === 'file' ? 'pickFileTitle' : 'pickMixedTitle')
  const result = await dialog.showOpenDialog(win, { properties, title })
  if (result.canceled) return []
  return intakeAttachments(result.filePaths.map((p) => ({ path: p })))
}

// ---- LLM 侧:图片内联 / 读取(说明行与降级判定在 attachments-core.ts) ----

/** 读图片副本为 dataURL(内联给多模态模型);读不到跳过并打日志,不拦回合 */
export function readImageDataUrl(att: MessageAttachment): LlmImagePart | null {
  try {
    const bytes = fs.readFileSync(att.path)
    const ext = path.extname(att.path).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg'
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } }
  } catch (err) {
    console.warn('[attachments] 图片内联读取失败,按路径引用降级:', err instanceof Error ? err.message : err)
    return null
  }
}

// ---- 展示侧:居民正文内嵌图(2026-11-05 方案 A,分流见 shared/markdown-image-core.ts) ----

/** 展示缩放长边:气泡内上限 260 CSS px,留足 2x~3x 屏;GIF 例外原样(动图) */
const DISPLAY_EDGE = 800

function extMime(ext: string): string {
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.gif') return 'image/gif'
  return 'image/jpeg'
}

/**
 * 本机路径 → dataURL,给渲染层内嵌显示。校验链:存在(errno 分家:ENOENT=真没了,
 * 其余=隐私墙拦,与 FilesOpen 同口径)→ 图片后缀(GIF 展示侧放行,附件管线不收是
 * 「模型只看首帧」的拍板,展示给岛主无此歧义)→ ≤8MB → 缩放。
 * 缩放:长边超 800 用 nativeImage 缩(保纵横比,重编码 PNG 保透明);够小原样字节返回。
 */
export function readImageForDisplay(rawPath: string): ImageReadResult {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return { ok: false, reason: 'bad-path' }
  let p = rawPath.trim()
  // ~ 展开(渲染层不知 home);Windows 也支持 ~ 前缀(用户 shell 习惯)
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1))
  }
  let st: fs.Stats
  try {
    st = fs.statSync(p)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, reason: 'not-found' }
    return { ok: false, reason: 'no-access' }
  }
  if (!st.isFile()) return { ok: false, reason: 'not-image' }
  const ext = path.extname(p).toLowerCase()
  if (!IMAGE_EXTS.has(ext) && ext !== '.gif') return { ok: false, reason: 'not-image' }
  if (st.size > IMAGE_DISPLAY_MAX_BYTES) return { ok: false, reason: 'too-large' }
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(p)
  } catch {
    return { ok: false, reason: 'no-access' }
  }
  // GIF:nativeImage 只取首帧,原样字节让 <img> 自播动图
  if (ext === '.gif') return { ok: true, dataUrl: `data:image/gif;base64,${bytes.toString('base64')}` }
  try {
    const img = nativeImage.createFromBuffer(bytes)
    if (!img.isEmpty()) {
      const { width, height } = img.getSize()
      if (width > DISPLAY_EDGE || height > DISPLAY_EDGE) {
        const scaled = img.resize(
          width >= height ? { width: DISPLAY_EDGE, quality: 'good' } : { height: DISPLAY_EDGE, quality: 'good' }
        )
        return { ok: true, dataUrl: `data:image/png;base64,${scaled.toPNG().toString('base64')}` }
      }
    } else {
      return { ok: false, reason: 'not-image' } // nativeImage 解不了又不是白名单外的后缀(如损坏文件)
    }
  } catch {
    // 缩放异常落原样兜底,展示优先
  }
  return { ok: true, dataUrl: `data:${extMime(ext)};base64,${bytes.toString('base64')}` }
}

// ---- 查看器侧:内置图片查看器(2026-11-06 拍板,壳与分流见 img-viewer.ts) ----

/**
 * 本机路径 → 原样字节 dataURL,给查看器窗口全分辨率显示。与 readImageForDisplay 分工:
 * 这边不缩放(查看器看的就是原图)、GIF 天然原样(动图保留)、上限 32MB(气泡通道 8MB 不动)。
 * 校验链同口径:存在(errno 分家)→ isImagePath(与渲染层入口分流同源)→ 上限 → 原样字节。
 * 故意不做 nativeImage 解码校验:解码只是缩放的前置,这边不缩放;损坏文件由 <img> 自然裂图,
 * 渲染层 onLoad 不触发即停在读图态,与「展示优先」的既有取舍一致。
 */
export function readImageFullForViewer(rawPath: string): ImageFullReadResult {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return { ok: false, reason: 'bad-path' }
  let p = rawPath.trim()
  // ~ 展开(与 readImageForDisplay 同款;渲染层不知 home)
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1))
  }
  let st: fs.Stats
  try {
    st = fs.statSync(p)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, reason: 'not-found' }
    return { ok: false, reason: 'no-access' }
  }
  if (!st.isFile() || !isViewerImagePath(p)) return { ok: false, reason: 'not-image' }
  if (st.size > IMAGE_VIEWER_MAX_BYTES) return { ok: false, reason: 'too-large' }
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(p)
  } catch {
    return { ok: false, reason: 'no-access' }
  }
  const ext = path.extname(p).toLowerCase()
  return { ok: true, dataUrl: `data:${extMime(ext)};base64,${bytes.toString('base64')}`, size: st.size }
}
