import path from 'node:path'
import fs from 'node:fs'
import { requireDataRoot } from './paths'

// M9 雏形:API Key 存本地 JSON,权限 600;Bot 与渲染端永远拿不到值,只在主进程内使用
interface SecretsFile {
  providers: Record<string, string>
}

function secretsPath(): string {
  return path.join(requireDataRoot(), 'secrets.json')
}

function readAll(): SecretsFile {
  const file = secretsPath()
  if (!fs.existsSync(file)) return { providers: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as SecretsFile
    return { providers: parsed.providers ?? {} }
  } catch {
    return { providers: {} }
  }
}

export function getApiKey(providerId: string): string | undefined {
  const key = readAll().providers[providerId]
  return key && key.length > 0 ? key : undefined
}

export function setApiKey(providerId: string, apiKey: string): void {
  const all = readAll()
  all.providers[providerId] = apiKey
  const file = secretsPath()
  fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // macOS 上 writeFileSync 的 mode 已生效,chmod 失败可忽略
  }
}
