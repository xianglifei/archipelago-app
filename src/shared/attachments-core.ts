// 附件纯逻辑(2026-10-29 输入框升级;2026-10-30 附件呈现重构迁入 shared 供渲染层共用):
// 不依赖 Electron,供 sessions/groups/渲染层与冒烟测试直跑。
// Electron 侧(intake/对话框/nativeImage 缩放/图片读取)在 main/attachments.ts
import type { MessageAttachment } from '@shared/types'

/** 附件展示名截断(2026-10-30 评审:文件名过长要缩略,扩展名必须可见——这是个 PDF/PNG 用户得能看见):
 * 主名按视觉宽度截到 ≤maxUnits(汉字记 2、其余记 1,默认 20≈10 个汉字),加省略号后拼回扩展名。
 * 隐藏文件(.bashrc 这类点开头)把整个名字当主名,不误当扩展名 */
export function shortAttachmentName(name: string, maxUnits = 20): string {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const main = dot > 0 ? name.slice(0, dot) : name
  const width = (s: string): number => {
    let w = 0
    for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1
    return w
  }
  if (width(main) <= maxUnits) return name
  let out = ''
  let w = 0
  for (const ch of main) {
    const cw = ch.charCodeAt(0) > 0xff ? 2 : 1
    if (w + cw > maxUnits - 1) break
    out += ch
    w += cw
  }
  return `${out}…${ext}`
}

/** 路径截断(文件夹 chip 用):超宽时保尾不保头——尾巴是文件名,是用户的关注点;前缀 …/ */
export function shortAttachmentPath(p: string, maxUnits = 36): string {
  const width = (s: string): number => {
    let w = 0
    for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1
    return w
  }
  if (width(p) <= maxUnits) return p
  const chars = [...p]
  let acc = 0
  let cut = chars.length
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = chars[i]!.charCodeAt(0) > 0xff ? 2 : 1
    if (acc + cw > maxUnits - 1) break
    acc += cw
    cut = i
  }
  return `…${chars.slice(cut).join('')}`
}

/** 附件 JSON(库列)→ 结构化;损坏或形态不对按无附件处理,只认合法 kind,防旧库脏数据进界面 */
export function parseAttachments(raw: string | null | undefined): MessageAttachment[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as MessageAttachment[]
    if (!Array.isArray(parsed)) return undefined
    const valid = parsed.filter((a) => a && typeof a.path === 'string' && ['file', 'dir', 'image'].includes(a.kind))
    return valid.length > 0 ? valid : undefined
  } catch {
    return undefined
  }
}

/** 附件说明行(注入用户消息正文后,单聊群聊同款):给模型真实路径锚点,读取指引在系统提示里 */
export function attachmentLines(atts: MessageAttachment[] | undefined): string {
  if (!atts || atts.length === 0) return ''
  const lines = atts.map((a) =>
    a.kind === 'dir'
      ? `[附件] 文件夹「${a.name}」:${a.path}`
      : a.kind === 'image'
        ? `[图片] ${a.name}:${a.path}`
        : `[附件] 文件「${a.name}」:${a.path}`
  )
  return `\n${lines.join('\n')}`
}

/** 「模型不支持图片」类错误判定(降级重试用;保持收敛,误吞会白白多跑一轮) */
const IMAGE_UNSUPPORTED_PATTERNS: RegExp[] = [
  /不支持.{0,10}(图片|图像|多模态|视觉)/,
  /(图片|图像|多模态|视觉).{0,10}不(支持|可用|能)/,
  /does not support (image|multimodal|vision)|unsupported (image|content|media) type/i,
  /invalid content type/i
]

export function isImageUnsupportedError(text: string): boolean {
  return IMAGE_UNSUPPORTED_PATTERNS.some((re) => re.test(text))
}
