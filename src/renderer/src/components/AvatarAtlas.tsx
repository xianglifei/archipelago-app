import type { Bot } from '@shared/types'
import { AVATAR_EYES, AVATAR_SHAPES, MAIN_BOT_APPEARANCE } from '@shared/avatar'
import ResidentAvatar, { GroupAvatarStack } from './ResidentAvatar'

// 头像图鉴(0.7 自检页,仅 dev):?avatar-atlas 打开。
// 核对 28 造型的眼睛定位是否服帖、12 眼型倍率、群叠放效果,以及回退样式。
// 2026-10-26 起配色取消(全原色 A),每行只显 A;定位数据在 shared/avatar.ts 的 center/EYE_GAIN/EYE_ORIGIN。
export default function AvatarAtlas() {
  const stackBots: Bot[] = [1, 6, 12].map((shape, i) => ({
    id: `atlas-${shape}`,
    name: ['Momo', 'Lumi', 'Nori'][i]!,
    role: '',
    persona: '',
    archetype: i === 0 ? 'sunshine' : 'gentle',
    providerId: '',
    modelId: '',
    isMain: i === 0,
    color: ['#0ea5e9', '#8b5cf6', '#f59e0b'][i]!,
    appearance: { shape, variant: i, eye: AVATAR_SHAPES[shape - 1]!.defaultEye },
    permission: 'semi',
    workspacePath: '',
    createdAt: '',
    updatedAt: ''
  }))

  return (
    <div className="avatar-atlas">
      <h1>头像图鉴 · 眼睛定位自检</h1>
      <p>28 造型 × 默认眼型;眼型倍率 × 章鱼见下节;定位数据改 shared/avatar.ts 的 center / EYE_GAIN / EYE_ORIGIN。</p>
      {AVATAR_SHAPES.map((s) => (
        <section key={s.id} className="atlas-shape">
          <h2>
            {s.id}. {s.name}
            <small>
              center {s.center.join(' / ')} · 默认 {s.defaultEye}
            </small>
          </h2>
          <div className="atlas-row">
            {[0].map((v) => (
              <ResidentAvatar
                key={v}
                appearance={{ shape: s.id, variant: v, eye: s.defaultEye }}
                fallbackName={s.name}
                size="big"
              />
            ))}
          </div>
        </section>
      ))}
      <h1>12 眼睛 × 章鱼 A</h1>
      <div className="atlas-row">
        {AVATAR_EYES.map((e) => (
          <ResidentAvatar key={e.id} appearance={{ shape: 9, variant: 0, eye: e.id }} fallbackName={e.name} size="big" />
        ))}
      </div>
      <h1>群叠放 / Momo 钦定 / 回退样式</h1>
      <div className="atlas-row">
        <GroupAvatarStack members={stackBots} />
        <GroupAvatarStack members={stackBots.slice(0, 2)} />
        <ResidentAvatar appearance={MAIN_BOT_APPEARANCE} fallbackName="Momo" size="xl" />
        <ResidentAvatar appearance={null} fallbackName="Nori" fallbackColor="#8b5cf6" size="xl" />
      </div>
    </div>
  )
}
