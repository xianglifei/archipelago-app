import { type CSSProperties } from 'react'
import { POSTAGE_ARTWORKS, isPostageArtworkId } from '@shared/postage-artworks'
import { Mail } from 'lucide-react'
import paper from '../assets/stamps/stamp-paper.svg'

// 50 幅邮票原画:原图 1254px/共155MB,2026-11-02 拍板压缩为 512px WebP(q92+sharp_yuv,共约6.2MB;
// 64px 展示 8 倍线性冗余,Retina 显示尺寸 128px 下 PSNR 42-44dB 视觉无损)。原图归档:设计师交付目录与 design-kit。
export const postageArtworkImages = import.meta.glob('../assets/stamps/artworks/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
export function postageArtworkUrl(id: string | null | undefined): string | undefined {
  return isPostageArtworkId(id) ? postageArtworkImages[`../assets/stamps/artworks/${POSTAGE_ARTWORKS[id]}`] : undefined
}

export default function PostageStamp({ label, color, artworkId, system = false }: {
  islandUid: string
  label: string
  color?: string
  artworkId?: string | null
  system?: boolean
}) {
  const artwork = system ? undefined : postageArtworkUrl(artworkId)
  return (
    <span className="postage-stamp" aria-hidden="true" style={{ '--stamp-color': color } as CSSProperties}>
      <img className="postage-paper" src={paper} alt="" />
      <span className={`postage-art ${artwork ? '' : 'fallback'}`}>
        {artwork ? <img src={artwork} alt="" /> : system ? <Mail size={22} /> : label}
      </span>
      <span className="postage-brand">ARCHIPELAGO</span>
    </span>
  )
}
