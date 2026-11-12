// shared 展示名按界面语言取用(性格八型/头像造型与眼型):中文底稿同时是居民工具的输入协议,不动
import { i18next } from './index'

/** 当前界面语言是否英文 */
export function isEn(): boolean {
  return i18next.language === 'en'
}

/** 数字格式化 locale(toLocaleString 用):en=en-US,zh=zh-CN */
export function i18nLang(): string {
  return isEn() ? 'en-US' : 'zh-CN'
}

/** 展示名二选一:en 用 nameEn(缺省回落中文) */
export function displayName(item: { name: string; nameEn?: string }): string {
  return isEn() ? item.nameEn ?? item.name : item.name
}
