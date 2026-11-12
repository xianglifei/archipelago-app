// 界面语言(2026-10-30 双语):机器级文件而非账号库——登录屏/向导在业务库挂载前就要用,
// 且语言是这台机器的偏好,不随账号分区走(与 update-machine-id 同模式)。
// 文件缺失的两种人:全新安装按系统语言自动设一次;存量用户升级一律冻结中文(界面零变化)。
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { accountsRoot, machineRoot } from './paths'
import { legacyDataExists } from './account-migration'
import type { UiLanguage } from '@shared/types'

let cached: UiLanguage | null = null
const listeners = new Set<(lang: UiLanguage) => void>()

function langFile(): string {
  return path.join(machineRoot(), 'ui-language')
}

function persist(lang: UiLanguage): void {
  cached = lang
  try {
    fs.writeFileSync(langFile(), lang, { mode: 0o600 })
  } catch {
    // 写不进只影响跨启动记忆,本会话仍按内存值走
  }
}

export function getUiLanguage(): UiLanguage {
  if (cached) return cached
  try {
    const raw = fs.readFileSync(langFile(), 'utf-8').trim()
    if (raw === 'zh' || raw === 'en') {
      cached = raw
      return raw
    }
  } catch {
    // 无文件=首次遇到本功能,走下面的初始化
  }
  const existingUser = fs.existsSync(accountsRoot()) || legacyDataExists(machineRoot())
  const initial: UiLanguage = existingUser
    ? 'zh'
    : app.getLocale().toLowerCase().startsWith('zh')
      ? 'zh'
      : 'en'
  persist(initial)
  return initial
}

export function setUiLanguage(lang: UiLanguage): UiLanguage {
  if (lang !== 'zh' && lang !== 'en') return getUiLanguage()
  if (getUiLanguage() === lang) return lang
  persist(lang)
  for (const fn of listeners) {
    try {
      fn(lang)
    } catch {
      // 单个订阅者失败不拦别人
    }
  }
  return lang
}

/** 主进程侧订阅(应用菜单/About 面板重建等);返回退订函数 */
export function onUiLanguageChanged(fn: (lang: UiLanguage) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
