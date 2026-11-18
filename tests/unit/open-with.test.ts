import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 「打开 ▾」指定应用打开(open-with.ts,自 ipc.ts 拆出可测):失败码口径 + /Applications 名单白名单。
// execFile 打桩——单测不真开应用;平台与名单走可注入依赖,不依赖真机 darwin 环境(CI linux 同样全跑)。
const execMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execMock }))

// 相对导入:裸 'src/main/…' 形态只对老模块稳定解析(机制未明),新文件一律走相对路径(同 integration 惯例)
import { openWithApp } from '../../src/main/open-with'

beforeEach(() => {
  execMock.mockReset()
  execMock.mockImplementation(
    (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
      cb(null)
      return { on: () => undefined } // 真实 child.on('error') 兜底的替身
    }
  )
})

describe('openWithApp(校验层:平台/参数/名单,全在 exec 之前)', () => {
  it('非 darwin 一律 unsupported-platform', async () => {
    await expect(openWithApp('/tmp/x.md', 'Safari', { platform: 'win32' })).resolves.toBe('unsupported-platform')
    await expect(openWithApp('/tmp/x.md', 'Safari', { platform: 'linux' })).resolves.toBe('unsupported-platform')
  })

  it('空路径/空应用名 → bad-path,不碰 execFile', async () => {
    const deps = { platform: 'darwin' as const, apps: ['Safari'] }
    await expect(openWithApp('', 'Safari', deps)).resolves.toBe('bad-path')
    await expect(openWithApp('/tmp/x.md', '   ', deps)).resolves.toBe('bad-path')
    expect(execMock).not.toHaveBeenCalled()
  })

  it('名单外应用名(含 .app 路径形态)→ app-not-found:不给「按任意路径启动应用」留门', async () => {
    const deps = { platform: 'darwin' as const, apps: ['TextEdit'] }
    await expect(openWithApp('/tmp/x.md', '/Volumes/Evil/Mal.app', deps)).resolves.toBe('app-not-found')
    await expect(openWithApp('/tmp/x.md', 'ZZZ 没有的应用', deps)).resolves.toBe('app-not-found')
    expect(execMock).not.toHaveBeenCalled()
  })

  it('路径不存在 → not-found(errno 区分保留)', async () => {
    const missing = path.join(os.tmpdir(), `qd-open-with-不存在-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
    await expect(openWithApp(missing, 'TextEdit', { platform: 'darwin', apps: ['TextEdit'] })).resolves.toBe(
      'not-found'
    )
    expect(execMock).not.toHaveBeenCalled()
  })
})

describe('openWithApp(执行层:open -a 组装与退出回传)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-open-with-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('名单内应用 + 文件存在 → 组装 open -a 应用 路径;回调无错即成功', async () => {
    const p = path.join(dir, 'x.md')
    fs.writeFileSync(p, '# x')
    await expect(openWithApp(p, 'TextEdit', { platform: 'darwin', apps: ['TextEdit'] })).resolves.toBe('')
    expect(execMock).toHaveBeenCalledWith('open', ['-a', 'TextEdit', p], expect.any(Function))
  })

  it('open 退出非零 → open-failed(渲染端 await 得到真结局,不是「发了就算成功」)', async () => {
    const p = path.join(dir, 'y.md')
    fs.writeFileSync(p, '# y')
    execMock.mockImplementationOnce(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(new Error('open: exit 1'))
        return { on: () => undefined }
      }
    )
    await expect(openWithApp(p, 'TextEdit', { platform: 'darwin', apps: ['TextEdit'] })).resolves.toBe('open-failed')
  })
})
