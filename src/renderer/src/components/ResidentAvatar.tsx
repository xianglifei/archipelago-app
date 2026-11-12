import { useState } from 'react'
import { Users } from 'lucide-react'
import type { Bot, BotAppearance } from '@shared/types'
import { AVATAR_SHAPES, EYE_GAIN, EYE_ORIGIN } from '@shared/avatar'
import { bodyUrl, eyeUrl } from '../avatars/images'

// 居民头像:底座 PNG + 眼睛 PNG 双层叠加。
// 眼睛定位(2026-10-26 定稿,Qundao_A_Developer_Handoff_09):中心取每底座 center,
// 宽度 = 34% × EYE_GAIN[眼型],按 EYE_ORIGIN(alpha 加权双眼中点)translate 对齐——
// 眼睛画布中心≠视觉中心,不对称眼型不再偏;旋转恒 0,切眼型不重置位置。
// 无 appearance 或图片加载失败 → 回退旧样式(color 底 + 名字首字),children(如未读角标)照常叠加。
// size 档位:small 28 / 默认 32 / big 38 / lg 40(2026-10-23 评审:侧栏与对话顶部统一档)/ xl 100(大预览)。

export type AvatarSize = 'small' | 'md' | 'big' | 'lg' | 'xl'

export function appearanceShape(shape: number): (typeof AVATAR_SHAPES)[number] | undefined {
  return AVATAR_SHAPES.find((s) => s.id === shape)
}

export default function ResidentAvatar({
  appearance,
  fallbackName,
  fallbackColor,
  size = 'md',
  className = '',
  children,
  title
}: {
  appearance: BotAppearance | null | undefined
  fallbackName: string
  fallbackColor?: string | null
  size?: AvatarSize
  className?: string
  children?: React.ReactNode
  title?: string
}) {
  const [broken, setBroken] = useState(false)
  const sizeClass = size === 'md' ? '' : ` ${size}`
  const shape = appearance ? appearanceShape(appearance.shape) : undefined
  const body = shape ? bodyUrl(shape.id, appearance!.variant) : ''
  const eye = shape ? eyeUrl(appearance!.eye) : ''

  if (!shape || !body || broken) {
    return (
      <span className={`avatar${sizeClass} ${className}`.trim()} style={{ background: fallbackColor ?? '#c4c4c4' }} title={title}>
        {fallbackName.slice(0, 1)}
        {children}
      </span>
    )
  }
  const [cx, cy] = shape.center
  const eyeId = appearance!.eye
  const gain = EYE_GAIN[eyeId] ?? 1
  const [ox, oy] = EYE_ORIGIN[eyeId] ?? [50, 50]
  return (
    // 二轮评审:不再默认拼「造型 · 配色 · 眼睛」的 title 提示(用户没见过这套编码,观感突兀);
    // 只在调用方显式传 title 时显示
    <span className={`avatar r-avatar${sizeClass} ${className}`.trim()} title={title}>
      <img className="r-avatar-body" src={body} alt="" draggable={false} onError={() => setBroken(true)} />
      {eye && (
        <img
          className="r-avatar-eyes"
          src={eye}
          alt=""
          draggable={false}
          style={{
            left: `${cx}%`,
            top: `${cy}%`,
            width: `${34 * gain}%`,
            transform: `translate(${-ox}%, ${-oy}%)`,
            transformOrigin: `${ox}% ${oy}%`
          }}
        />
      )}
      {children}
    </span>
  )
}

// 群头像:前 3 位成员透明素材自然叠放(无底板,仅一圈外框);全都没外观时回退群图标
export function GroupAvatarStack({
  members,
  size = 'md',
  className = ''
}: {
  members: Bot[]
  size?: AvatarSize
  className?: string
}) {
  const top = members.slice(0, 3)
  if (!top.some((m) => m.appearance)) {
    return (
      <span className={`avatar group-avatar ${size === 'md' ? '' : size} ${className}`.trim()}>
        <Users size={size === 'lg' ? 18 : 15} />
      </span>
    )
  }
  return (
    <span className={`avatar group-avatar ${size === 'md' ? '' : size} ${className}`.trim()}>
      <span className="group-stack">
        {top.map((m) => (
          <ResidentAvatar
            key={m.id}
            appearance={m.appearance}
            fallbackName={m.name}
            fallbackColor={m.color}
          />
        ))}
      </span>
    </span>
  )
}
