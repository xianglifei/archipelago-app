import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { deriveDeviceFingerprint } from '../../src/main/device-fingerprint'

// 设备指纹派生纯函数冒烟(2026-11-03 方案 - 设备指纹识别同一物理机):
// 指纹值是认领键,稳定性=重装后仍命中同行的前提;格式必须过服务端 32hex 校验。
// 采集函数(ioreg 子进程)不在单测范围,失败降级路径由代码审查与实机覆盖。

describe('deriveDeviceFingerprint', () => {
  const uuidA = '2C283351-BCBF-5E95-9564-A71CA2CB343D'

  it('同输入恒同输出(认领键稳定性)', () => {
    expect(deriveDeviceFingerprint(uuidA)).toBe(deriveDeviceFingerprint(uuidA))
  })

  it('输出为 32 位小写 hex(过服务端校验)', () => {
    const fp = deriveDeviceFingerprint(uuidA)
    expect(fp).toMatch(/^[0-9a-f]{32}$/)
  })

  it('大小写归一:IOPlatformUUID 输出大小写不同仍同指纹', () => {
    expect(deriveDeviceFingerprint(uuidA)).toBe(deriveDeviceFingerprint(uuidA.toLowerCase()))
  })

  it('不同机器不同指纹(区分度)', () => {
    expect(deriveDeviceFingerprint(uuidA)).not.toBe(deriveDeviceFingerprint('AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000'))
  })

  it('盐化生效:不等于裸 sha256 截断(原始 UUID 不被直接反推口径的最低保障)', () => {
    const bare = createHash('sha256').update(uuidA).digest('hex').slice(0, 32)
    expect(deriveDeviceFingerprint(uuidA)).not.toBe(bare)
  })
})
