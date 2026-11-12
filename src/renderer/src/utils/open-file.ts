// 统一打开分流(2026-11-06 内置 md 阅读器 D2:md 默认应用内打开;同日图片查看器同构接入):
// markdown 文件进独立只读阅读器,图片进独立查看器(单例替换),其余类型维持系统默认应用;
// 返回错误文案,空串 = 成功。
import { isMarkdownPath } from '@shared/md-reader-core'
import { isImagePath } from '@shared/img-viewer-core'
import { api } from '../api'

export async function openFileSmart(path: string): Promise<string> {
  if (isMarkdownPath(path)) {
    await api.mdReaderOpen(path)
    return ''
  }
  if (isImagePath(path)) {
    await api.imgViewerOpen(path)
    return ''
  }
  return api.openPath(path)
}
