// 时间展示统一入口:库与状态里存的都是 UTC ISO(new Date().toISOString()),
import { i18next } from '../i18n'
// 直接对字符串切片显示会差出时区(中国 +8 小时);这里解析后按本机时区格式化为「MM-DD HH:mm」,
// 解析失败(非 ISO 串)原样返回
export function formatStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // 双语(2026-10-30):en 走 Intl 自然格式「Oct 30, 2:05 PM」;zh 维持数字式「10-30 14:05」
  if (i18next.language === 'en') {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(d)
  }
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
