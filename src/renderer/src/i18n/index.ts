// 界面语言运行时(2026-10-30 双语):启动时向主进程取一次机器级语言再初始化,
// 之后订阅 EV.LanguageChanged 即时切换(useTranslation 触发全量重渲染,无需重启)。
// 缺 key 回落 zh(fallbackLng),词典 key 中英 parity 由 en: typeof zh 在 typecheck 强制。
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { EV } from '@shared/ipc-channels'
import type { UiLanguage } from '@shared/types'
import { api } from '../api'
import { zh } from './zh'
import { en } from './en'

export async function initI18n(): Promise<void> {
  let lng: UiLanguage = 'zh'
  try {
    lng = await api.uiLanguageGet()
  } catch {
    // 主进程不可达按中文兜底,不阻塞首屏
  }
  await i18next.use(initReactI18next).init({
    lng,
    fallbackLng: 'zh',
    resources: { zh: { translation: zh }, en: { translation: en } },
    interpolation: { escapeValue: false }, // React 已防注入
    returnEmptyString: false
  })
  document.documentElement.lang = lng === 'en' ? 'en' : 'zh-CN'
  api.on(EV.LanguageChanged, (data) => {
    const lang = (data as { lang: UiLanguage }).lang
    void i18next.changeLanguage(lang)
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
  })
}

export { useTranslation } from 'react-i18next'
export { i18next }
