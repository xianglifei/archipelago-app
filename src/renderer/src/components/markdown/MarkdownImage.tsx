// 居民正文内嵌图(2026-11-05 拍板:方案 A 内嵌缩略图;2026-11-06 点击改内置查看器):
// markdown img 的 src 经 classifyMarkdownImageSrc 三分流——本机路径走 IPC 读成 dataURL
// 内嵌显示(CSP img-src 'self' data: 本来就放行,零 CSP 改动);远程图降级为链接不裂图;
// 失败(文件没了/隐私墙/超 8MB)诚实占位卡。交互口径与用户附件缩略图同款:title=路径 + 点击 openFileSmart(进查看器)。
import { useEffect, useState } from 'react'
import type { ImageReadResult } from '@shared/types'
import { classifyMarkdownImageSrc } from '@shared/markdown-image-core'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { openFileSmart } from '../../utils/open-file'

/** 路径 → 结果的会话级缓存(LRU):流式渲染每 chunk 重建组件,不缓存会反复 IPC;
 *  成败都缓存(失败一次性占位,与 FilesOpen 的诚实语义一致);上限 20 条防 dataURL 常驻内存 */
const CACHE_LIMIT = 20
const imageCache = new Map<string, Promise<ImageReadResult>>()

function fetchImage(p: string): Promise<ImageReadResult> {
  const hit = imageCache.get(p)
  if (hit) {
    // 触达提升为最近使用
    imageCache.delete(p)
    imageCache.set(p, hit)
    return hit
  }
  const pending = api.imageRead(p)
  imageCache.set(p, pending)
  if (imageCache.size > CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value
    if (oldest !== undefined) imageCache.delete(oldest)
  }
  return pending
}

function failTextKey(reason: string): string {
  switch (reason) {
    case 'not-found':
      return 'chat.imageMissing'
    case 'no-access':
      return 'chat.imageNoAccess'
    case 'too-large':
      return 'chat.imageTooLarge'
    default:
      return 'chat.imageUnavailable'
  }
}

function BrokenImage({ path, reason }: { path: string; reason: string }) {
  const { t } = useTranslation()
  // 长路径保尾截断(文件名一端);不能用 CSS direction:rtl——中性字符(/ ~)会被 RTL 段落方向重排
  const shownPath = path.length > 44 ? `…${path.slice(-43)}` : path
  return (
    <span className="md-img-broken" title={path}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M4 4l16 16" strokeWidth="1.7" />
      </svg>
      <span className="md-img-broken-text">{t(failTextKey(reason))}</span>
      <span className="md-img-broken-path">{shownPath}</span>
    </span>
  )
}

/** react-markdown img 组件映射的实体;src 为空渲染原文不吞内容 */
export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const { t } = useTranslation()
  const cls = classifyMarkdownImageSrc(src ?? '')
  const localPath = cls.kind === 'local' ? cls.path : null
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failReason, setFailReason] = useState<string | null>(null)

  useEffect(() => {
    if (!localPath) return
    let disposed = false
    // 路径变化先清旧态(2026-11-06 codex 审查修复:React 复用同一组件实例时,上一张图的
    // dataUrl/failReason 会残留——A 图失败后换成成功的 B 图仍显示「不可用」)
    setDataUrl(null)
    setFailReason(null)
    fetchImage(localPath)
      .then((r) => {
        if (disposed) return
        if (r.ok) {
          setDataUrl(r.dataUrl)
          setFailReason(null)
        } else {
          setFailReason(r.reason)
          setDataUrl(null)
        }
      })
      .catch(() => {
        // IPC 层reject(桥断等罕见情形):按不可用占位,不留悬挂 promise
        if (!disposed) setFailReason('unavailable')
      })
    return () => {
      disposed = true
    }
  }, [localPath])

  if (cls.kind === 'data') {
    return <img className="md-img-inline" src={src} alt={alt ?? ''} />
  }
  if (cls.kind !== 'local') {
    // 远程图(拍板不渲染)与其他非常规 src:降级为链接,不裂图
    return (
      <a href={src} target="_blank" rel="noreferrer noopener">
        {alt || src}
      </a>
    )
  }
  if (failReason) return <BrokenImage path={cls.path} reason={failReason} />
  if (!dataUrl) {
    return (
      <span className="md-img-loading" role="status" aria-label={t('chat.imageLoading')}>
        <span className="md-img-shimmer" />
      </span>
    )
  }
  return (
    <button
      type="button"
      className="md-img"
      title={`${cls.path} · ${t('chat.imageOpenHint')}`}
      onClick={() => void openFileSmart(cls.path)}
    >
      <img src={dataUrl} alt={alt ?? ''} draggable={false} />
    </button>
  )
}
