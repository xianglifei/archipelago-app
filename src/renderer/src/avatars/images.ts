// 头像图片映射(0.7):124 张 PNG 经 Vite 资产管线打包(hash 文件名 + asar 内可直接引用)
import { AVATAR_VARIANT_LETTERS } from '@shared/avatar'

const bodyModules = import.meta.glob<string>('../assets/avatars/bodies/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
})
const eyeModules = import.meta.glob<string>('../assets/avatars/eyes/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
})

/** 底座图 URL;shape 1-28 / variant 0-3,越界返回空串(上层回退首字头像) */
export function bodyUrl(shape: number, variant: number): string {
  const letter = AVATAR_VARIANT_LETTERS[variant]
  if (!letter) return ''
  return (
    bodyModules[
      `../assets/avatars/bodies/${String(shape).padStart(2, '0')}_${letter}.png`
    ] ?? ''
  )
}

/** 眼睛图 URL;未知编号返回空串(不叠眼睛层,只显底座) */
export function eyeUrl(eye: string): string {
  return eyeModules[`../assets/avatars/eyes/${eye}.png`] ?? ''
}
