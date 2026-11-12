import { AVATAR_EYES, AVATAR_SHAPES } from '@shared/avatar'
import type { BotAppearance } from '@shared/types'
import ResidentAvatar from './ResidentAvatar'
import { eyeUrl } from '../avatars/images'
import { useTranslation } from '../i18n'
import { displayName } from '../i18n/localized'

// 头像选择器(2026-10-23 评审改版):只负责右侧选区——上半造型网格(仅底座,不叠眼睛)、
// 下半眼睛网格(仅眼睛本身);配色已整体取消(全部原色),预览由调用方在左侧自行渲染。
// 二轮评审:造型与眼睛不联动——切造型保持已选眼睛(默认列表第一只),只有用户自己点眼睛才变。
// 造型名/眼睛名不落界面文字,只留 title 悬停提示。
export default function AvatarPicker({
  value,
  onChange
}: {
  value: BotAppearance
  onChange: (next: BotAppearance) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="avatar-picker">
      <div className="ap-shapes">
        {AVATAR_SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`ap-cell ${value.shape === s.id ? 'on' : ''}`}
            title={displayName(s)}
            aria-label={t('avatar.shapeAria', { name: displayName(s) })}
            aria-pressed={value.shape === s.id}
            onClick={() => onChange({ shape: s.id, variant: 0, eye: value.eye })}
          >
            <ResidentAvatar appearance={{ shape: s.id, variant: 0, eye: '' }} fallbackName={displayName(s)} />
          </button>
        ))}
      </div>

      <div className="ap-eyes">
        {AVATAR_EYES.map((e) => (
          <button
            key={e.id}
            type="button"
            className={`ap-cell ap-eye-cell ${value.eye === e.id ? 'on' : ''}`}
            title={displayName(e)}
            aria-label={t('avatar.eyeAria', { name: displayName(e) })}
            aria-pressed={value.eye === e.id}
            onClick={() => onChange({ ...value, variant: 0, eye: e.id })}
          >
            <img className="ap-eye-img" src={eyeUrl(e.id)} alt="" draggable={false} />
          </button>
        ))}
      </div>
    </div>
  )
}
