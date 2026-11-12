// 居民头像目录:渲染 = 底座 PNG + 眼睛 PNG 双层叠加。
// 2026-10-26 眼睛定稿(Qundao_A_Developer_Handoff_09,用户校准导出):
// - 每底座 center=[x%, y%](相对含透明边的 512 画布,不再按 alpha 包围盒);
// - 眼睛宽度 = 34% × EYE_GAIN[眼型](不再按底座给定宽,小眼在大底座上不显小);
// - 眼睛按 EYE_ORIGIN(该眼型 PNG 的 alpha 加权双眼中点)对齐,取代旧几何中心 -50%/-50%;
// - 全部旋转 0°,切眼型不重置位置;底图占满头像框(不二次内缩)。
import type { BotAppearance } from './types'

export interface AvatarShape {
  id: number
  name: string
  /** 英文展示名(界面语言=en 时用) */
  nameEn: string
  /** 四配色(A 原色/B/C/D)的代表 HEX,仅作选色器色点展示 */
  colors: [string, string, string, string]
  /** 眼睛中心 [x%, y%],相对头像容器(含透明边) */
  center: [number, number]
  defaultEye: string
}

export const AVATAR_SHAPES: AvatarShape[] = [
  { id: 1, name: '扇贝', nameEn: 'Scallop', colors: ['#FB7D58', '#F7BA82', '#D09EDE', '#7EDEC0'], center: [50, 55], defaultEye: 'L02' },
  { id: 2, name: '海螺', nameEn: 'Conch', colors: ['#E49964', '#A5BAA8', '#C398B0', '#E48C7D'], center: [72, 50], defaultEye: 'E02' },
  { id: 3, name: '海绵', nameEn: 'Sponge', colors: ['#F9A525', '#F9866C', '#97C984', '#7C99D8'], center: [50, 50], defaultEye: 'E03' },
  { id: 4, name: '海胆', nameEn: 'Urchin', colors: ['#9666C3', '#EA8883', '#42C7C4', '#F0BE58'], center: [50, 50], defaultEye: 'L08' },
  { id: 5, name: '海星', nameEn: 'Starfish', colors: ['#F9683B', '#F97570', '#60C6B3', '#779BE4'], center: [50, 55], defaultEye: 'E31' },
  { id: 6, name: '海玻璃', nameEn: 'Sea Glass', colors: ['#45CEC7', '#7EC797', '#EE9BA7', '#93ACEB'], center: [50, 55], defaultEye: 'E02' },
  { id: 7, name: '浮石', nameEn: 'Pumice', colors: ['#918C90', '#BE8A64', '#A0A4AA', '#A09C86'], center: [50, 55], defaultEye: 'E17' },
  { id: 8, name: '水母', nameEn: 'Jellyfish', colors: ['#7D94E9', '#C2AAF1', '#82D8C7', '#F6A6B6'], center: [50, 50], defaultEye: 'L03' },
  { id: 9, name: '章鱼', nameEn: 'Octopus', colors: ['#F96C65', '#FAA970', '#C398E0', '#6ECFC0'], center: [50, 45], defaultEye: 'L08' },
  { id: 10, name: '河豚', nameEn: 'Puffer', colors: ['#F8B644', '#FB9984', '#86DCC4', '#D1AAE4'], center: [50, 50], defaultEye: 'L08' },
  { id: 11, name: '鳐鱼', nameEn: 'Ray', colors: ['#6491DB', '#88CFBE', '#CDAEE0', '#F6977A'], center: [50, 50], defaultEye: 'E06' },
  { id: 12, name: '海兔', nameEn: 'Sea Hare', colors: ['#C28BD6', '#E78997', '#66C1B6', '#F3AE70'], center: [50, 55], defaultEye: 'E31' },
  { id: 13, name: '海葵', nameEn: 'Anemone', colors: ['#F87556', '#FCA568', '#C197DE', '#6DCCBA'], center: [50, 55], defaultEye: 'E03' },
  { id: 14, name: '海葡萄', nameEn: 'Sea Grapes', colors: ['#8DB13D', '#79C186', '#7698E0', '#F67E93'], center: [50, 50], defaultEye: 'E02' },
  { id: 15, name: '椰子', nameEn: 'Coconut', colors: ['#99572E', '#C58F5C', '#AB684A', '#A49E63'], center: [50, 50], defaultEye: 'L02' },
  { id: 16, name: '橡果', nameEn: 'Acorn', colors: ['#C47A3B', '#E86D59', '#6A9A78', '#A57DB9'], center: [50, 55], defaultEye: 'E06' },
  { id: 17, name: '栗子', nameEn: 'Chestnut', colors: ['#B15233', '#D48041', '#C76B69', '#9166A1'], center: [50, 55], defaultEye: 'E31' },
  { id: 18, name: '松果', nameEn: 'Pinecone', colors: ['#904A1F', '#C3752E', '#858F4F', '#9A5A6B'], center: [50, 55], defaultEye: 'E29' },
  { id: 19, name: '蘑菇', nameEn: 'Mushroom', colors: ['#F2704A', '#F38772', '#BC8CD5', '#85C28E'], center: [50, 55], defaultEye: 'E03' },
  { id: 20, name: '莲蓬', nameEn: 'Lotus Pod', colors: ['#82A13A', '#84AD72', '#E0AC41', '#A57CC1'], center: [50, 55], defaultEye: 'L03' },
  { id: 21, name: '翅果', nameEn: 'Samara', colors: ['#D9AA50', '#8DC5A2', '#F5A7BB', '#FDD975'], center: [30, 65], defaultEye: 'L02' },
  { id: 22, name: '鹅卵石', nameEn: 'Pebble', colors: ['#96979E', '#99B39F', '#B59BBD', '#DF9C69'], center: [50, 50], defaultEye: 'E17' },
  { id: 23, name: '漂流木', nameEn: 'Driftwood', colors: ['#B7855F', '#C78951', '#B26C54', '#968975'], center: [50, 60], defaultEye: 'E06' },
  { id: 24, name: '软木塞', nameEn: 'Cork', colors: ['#DA8D52', '#E0AE58', '#E88A5D', '#B0AC73'], center: [50, 50], defaultEye: 'L02' },
  { id: 25, name: '浮标', nameEn: 'Buoy', colors: ['#F24F34', '#42B5A0', '#A47EBE', '#F99D33'], center: [50, 55], defaultEye: 'E30' },
  { id: 26, name: '玻璃浮球', nameEn: 'Glass Float', colors: ['#33BBB4', '#69C07B', '#BEAAD3', '#F5A68B'], center: [50, 53], defaultEye: 'E02' },
  { id: 27, name: '珊瑚枝', nameEn: 'Coral', colors: ['#FA6E66', '#F18C88', '#B493D4', '#71BCA4'], center: [50, 58], defaultEye: 'E31' },
  { id: 28, name: '卷叶', nameEn: 'Curled Leaf', colors: ['#7CA036', '#42A182', '#A7AE37', '#9872A3'], center: [42, 50], defaultEye: 'L08' }
]

// 2026-10-23 二轮评审:眼睛排序重排——星芒高光(L08)置首、无辜亮眼(E31)第二,
// 其余顺延;首项即编辑器/邀请页的默认眼(造型切换不再联动换眼)。
export const AVATAR_EYES: { id: string; name: string; nameEn: string }[] = [
  { id: 'L08', name: '星芒高光', nameEn: 'Star Glow' },
  { id: 'E31', name: '无辜亮眼', nameEn: 'Innocent' },
  { id: 'E02', name: '开心大眼', nameEn: 'Happy' },
  { id: 'E03', name: '笑弯眼', nameEn: 'Crescent' },
  { id: 'E04', name: '挤眼笑', nameEn: 'Wink Smile' },
  { id: 'E06', name: '眨眼', nameEn: 'Blink' },
  { id: 'E11', name: '恳求泪眼', nameEn: 'Pleading' },
  { id: 'E17', name: '半眯侧望', nameEn: 'Side Glance' },
  { id: 'E29', name: '圆眼镜', nameEn: 'Round Specs' },
  { id: 'E30', name: '墨镜', nameEn: 'Shades' },
  { id: 'L02', name: '亮点眼', nameEn: 'Sparkle' },
  { id: 'L03', name: '白胶囊', nameEn: 'Capsule' }
]

/** 眼睛宽度倍率(2026-10-26 定稿):眼睛宽 = 头像宽 × 34% × gain。
 *  小眼素材(L08/L02/L03)不放大,宽眼素材(墨镜 E30 ×1.6)放大补足视觉分量。 */
export const EYE_GAIN: Record<string, number> = {
  L08: 1,
  L02: 1,
  L03: 1,
  E31: 1.28,
  E06: 1.28,
  E02: 1.18,
  E11: 1.18,
  E03: 1.32,
  E04: 1.24,
  E17: 1.42,
  E29: 1.5,
  E30: 1.6
}

/** 眼睛 PNG 的视觉原点 [ox%, oy%] = alpha 加权左右半区中点的等权平均,相对其画布。
 *  定位用 translate(-ox%, -oy%) + transform-origin: ox% oy%(取代旧几何中心 -50%/-50%,
 *  眼睛画布中心 ≠ 双眼视觉中心,不对称眼型会偏)。数据源自交接包 pairCenterPx/sourceWH 预计算。 */
export const EYE_ORIGIN: Record<string, [number, number]> = {
  L08: [50.1, 50.13],
  L02: [49.89, 50.2],
  L03: [50.19, 49.49],
  E31: [50.48, 50.37],
  E02: [49.67, 49.92],
  E03: [49.94, 45.75],
  E04: [50.69, 51.39],
  E06: [49.1, 49.04],
  E11: [49.73, 51.83],
  E17: [49.61, 45.41],
  E29: [49.28, 51.4],
  E30: [49.8, 45.86]
}

export const AVATAR_VARIANT_LETTERS = ['A', 'B', 'C', 'D'] as const

/** Momo 钦定外观:章鱼 · A 原色 · 星芒高光(设计稿) */
export const MAIN_BOT_APPEARANCE: BotAppearance = { shape: 9, variant: 0, eye: 'L08' }

export function isValidAppearance(value: unknown): value is BotAppearance {
  if (!value || typeof value !== 'object') return false
  const a = value as BotAppearance
  return (
    Number.isInteger(a.shape) &&
    a.shape >= 1 &&
    a.shape <= AVATAR_SHAPES.length &&
    Number.isInteger(a.variant) &&
    a.variant >= 0 &&
    a.variant <= 3 &&
    AVATAR_EYES.some((e) => e.id === a.eye)
  )
}

function hash32(input: string): number {
  let h = 5381
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0
  return h >>> 0
}

/** 稳定兜底:同一 id 永远映射同一外观(存量回填用,避免每次启动变脸)。
 *  2026-10-23 评审:配色体系整体取消,一律原色(variant A)。 */
export function appearanceFromId(id: string): BotAppearance {
  const h = hash32(id)
  const shape = AVATAR_SHAPES[h % AVATAR_SHAPES.length]!
  return { shape: shape.id, variant: 0, eye: shape.defaultEye }
}

/** 随机外观:邀请新居民时的默认值(造型随机、原色、眼睛取列表第一只=L08) */
export function randomAppearance(): BotAppearance {
  const shape = AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)]!
  return { shape: shape.id, variant: 0, eye: AVATAR_EYES[0]!.id }
}
