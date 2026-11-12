// 设备指纹:重装/清数据后识别同一物理机(doc/方案 - 设备指纹识别同一物理机 - 2026-11-03.md,五点拍板实施)。
// 采集 macOS IOPlatformUUID(主板固化,重装系统/重装 App 均不变)/Windows MachineGuid(系统安装时生成,
// 重装系统会换,语义略弱于 mac,诚实可接受),派生=盐化 sha256 前 32 hex;
// 原始 UUID 不出本机,只随 /devices/bind 上报派生值,服务端用它认领同账号旧设备行。
// 采集失败(非 macOS/Windows/命令缺失)返回 null,行为退化为按 device_id 幂等,不阻断登录。
// 独立成文件而非并入 auth.ts:零 electron 依赖,单测可直接导入(同 turn-guard 拆法)。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const FINGERPRINT_SALT = 'archipelago.device.v1'

/** 派生纯函数(导出供单测同源):同 IOPlatformUUID 恒同输出、32 位小写 hex;输入归一大小写防采集端差异 */
export function deriveDeviceFingerprint(ioPlatformUuid: string): string {
  return createHash('sha256').update(FINGERPRINT_SALT + ioPlatformUuid.trim().toLowerCase()).digest('hex').slice(0, 32)
}

let fingerprintCache: string | null | undefined

/** 设备指纹(进程内缓存,首次采集 ~20ms);采集失败缓存 null 不重试,下次启动再试 */
export async function deviceFingerprint(): Promise<string | null> {
  if (fingerprintCache !== undefined) return fingerprintCache
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('reg', [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
        '/v',
        'MachineGuid'
      ])
      const match = /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/.exec(stdout)
      fingerprintCache = match ? deriveDeviceFingerprint(match[1]!) : null
    } else {
      const { stdout } = await execFileAsync('ioreg', ['-d2', '-c', 'IOPlatformExpertDevice'])
      const match = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(stdout)
      fingerprintCache = match ? deriveDeviceFingerprint(match[1]!) : null
    }
  } catch {
    fingerprintCache = null
  }
  return fingerprintCache
}
