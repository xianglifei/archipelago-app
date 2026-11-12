import { nativeImage } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'

export function postalImageMime(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop()
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic' } as Record<string, string>)[ext ?? ''] ?? null
}

/** Display-only thumbnail. Original postal bytes are never resized or replaced. */
export function postalImageThumb(bytes: Buffer): string | undefined {
  try {
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return undefined
    const size = image.getSize()
    const thumb = Math.max(size.width, size.height) > 320
      ? image.resize(size.width >= size.height ? { width: 320, quality: 'good' } : { height: 320, quality: 'good' })
      : image
    return `data:image/jpeg;base64,${thumb.toJPEG(70).toString('base64')}`
  } catch { return undefined }
}

const thumbnails = new Map<string, string | undefined>()
export function postalImageThumbAt(path: string, name: string): string | undefined {
  if (!postalImageMime(name) || !existsSync(path)) return undefined
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) return undefined
    const key = `${path}:${stat.size}:${stat.mtimeMs}`
    if (thumbnails.has(key)) return thumbnails.get(key)
    const result = postalImageThumb(readFileSync(path))
    if (thumbnails.size >= 512) thumbnails.delete(thumbnails.keys().next().value!)
    thumbnails.set(key, result)
    return result
  } catch { return undefined }
}
