// 居民正文内嵌本地图片(2026-11-05 拍板:方案 A 内嵌缩略图 + 点击系统打开):
// markdown img 的 src 三分流纯函数,渲染层与单测共用(零 electron 依赖)。
// 拍板口径:只渲染本机路径的图;远程 http(s) 图 CSP 不放行(img-src 'self' data:),
// 降级为普通链接文本,不裂图。

export type MarkdownImageClass =
  | { kind: 'data' } // data: URL,渲染层直用
  | { kind: 'remote' } // http(s),降级链接
  | { kind: 'local'; path: string } // 本机路径(绝对 / ~ / file://),走 IPC 读文件
  | { kind: 'unsupported' } // 其他协议/相对路径,降级链接

/** 展示侧图片读取上限(ZCode 同款 8MB):超出诚实报「太大」,不做缩放降级 */
export const IMAGE_DISPLAY_MAX_BYTES = 8 * 1024 * 1024

const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/

/** file:// URL → 本机路径;/C:/ 形式剥掉前导斜杠,URI 转义解码一次 */
function fileUrlToPath(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'file:') return null
    if (url.hostname && url.hostname !== 'localhost') return null // 网络路径不管
    let p: string
    try {
      p = decodeURIComponent(url.pathname)
    } catch {
      p = url.pathname
    }
    if (/^\/[a-zA-Z]:\//.test(p)) return p.slice(1) // file:///C:/… → C:/…
    return p
  } catch {
    return null
  }
}

/** 本地路径里的 URI 转义(%20 空格等,markdown 链接常见写法)解一次,解不了原样 */
function decodeLocalEscapes(p: string): string {
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

export function classifyMarkdownImageSrc(src: string): MarkdownImageClass {
  const s = src.trim()
  if (!s) return { kind: 'unsupported' }

  if (s.startsWith('data:')) return { kind: 'data' }
  if (/^https?:\/\//i.test(s)) return { kind: 'remote' }

  if (/^file:\/\//i.test(s)) {
    const p = fileUrlToPath(s)
    return p ? { kind: 'local', path: p } : { kind: 'unsupported' }
  }
  // 带 scheme 的其余协议(mailto:/tel:/app: 等)不是本机文件;注意避开 Windows 盘符 C:\
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/i.test(s) && !WIN_DRIVE_RE.test(s)) return { kind: 'unsupported' }

  // unix 绝对路径 / Windows 盘符路径 / ~ 家目录(展开交给主进程,渲染层不知 home)
  if (s.startsWith('/') || s.startsWith('\\') || WIN_DRIVE_RE.test(s) || s.startsWith('~/') || s.startsWith('~\\')) {
    return { kind: 'local', path: decodeLocalEscapes(s) }
  }
  return { kind: 'unsupported' }
}
