// W1/W2 修复的行为锁定(2026-11-04,doc/修复方案 - Windows 客户端首版代码审查 - 2026-11-04.md):
// 直接调用生产分类函数(零 electron 依赖的 shell-classify-core),显式注入 win32/posix 平台语义——
// 在 mac 宿主上验证 Windows 分支,不依赖宿主平台碰巧相同。
// 注意:realpathSafe 对 mac 文件系统上不存在的 win32 路径退化为 normalize(生产同款行为),
// junction 场景留 Windows 真机专项验证;posix 分支用真实临时目录覆盖 symlink 逃逸。
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyCommandFor, extractRedirectTargets } from '../../src/main/shell-classify-core'

const WS = 'C:\\Users\\Alice\\群岛\\Momo-123456'
const WD = WS

// posix 分支用真实临时目录(覆盖 ~ 展开/symlink 穿透两类需要文件系统佐证的行为)
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'qd-classify-'))
const posixWs = path.join(tmpRoot, 'ws')

describe('W1: Windows 重定向目标从原始命令解析(归一化不再破坏路径)', () => {
  const cases: { cmd: string; verdict: 'auto' | 'ask'; note: string }[] = [
    // review 原始示例:旧实现提取出 `c:`/废字符串放行,实际覆盖 Documents
    { cmd: 'echo overwritten > C:\\Users\\Alice\\Documents\\important.txt', verdict: 'ask', note: 'review 原始示例' },
    { cmd: 'echo x > "C:\\Users\\Alice\\My Docs\\a.txt"', verdict: 'ask', note: '带空格带引号的区外绝对路径' },
    { cmd: 'echo x > D:\\out.txt', verdict: 'ask', note: '不同盘符' },
    { cmd: 'echo x > \\\\server\\share\\a.txt', verdict: 'ask', note: 'UNC 路径' },
    { cmd: 'echo x > ..\\..\\outside.txt', verdict: 'ask', note: '.. 越界' },
    { cmd: 'echo x > /c/Users/Alice/Documents/a.txt', verdict: 'ask', note: 'Git Bash 风格绝对路径' },
    { cmd: 'echo x 2> C:\\Users\\Alice\\err.log', verdict: 'ask', note: 'fd 重定向写区外文件' },
    { cmd: 'echo x > out.txt', verdict: 'auto', note: '区内相对目标' },
    { cmd: 'echo x > "sub dir\\a.txt"', verdict: 'auto', note: '区内带引号相对路径' },
    { cmd: `echo x > ${WS}\\sub.txt`, verdict: 'auto', note: '区内绝对路径' },
    { cmd: 'echo x > C:\\Users\\Alice\\AppData\\Local\\Temp\\a.txt', verdict: 'ask', note: '区外但真实存在的常见目录风格' },
    { cmd: 'echo x > NUL', verdict: 'auto', note: 'CMD 丢弃目标' },
    { cmd: 'echo x > $null', verdict: 'auto', note: 'PS 丢弃目标' },
    { cmd: 'echo x > /dev/null', verdict: 'auto', note: 'Git Bash 丢弃目标' },
    { cmd: 'echo x >> C:\\Users\\Alice\\Documents\\a.txt', verdict: 'auto', note: '>> 追加维持既有放行策略' },
    { cmd: 'dir > out.txt 2>&1', verdict: 'auto', note: '2>&1 fd 合并不当文件覆盖' },
    { cmd: 'echo x > $(Get-Location)\\a.txt', verdict: 'ask', note: '命令替换目标拿不准,保守 ask' },
    { cmd: 'echo x > *.txt', verdict: 'ask', note: 'glob 目标拿不准' }
  ]
  for (const c of cases) {
    it(`win32: ${c.note} → ${c.verdict}`, () => {
      expect(classifyCommandFor(c.cmd, WS, WD, 'win32').verdict).toBe(c.verdict)
    })
  }

  it('win32: 盘符相对目标(C:Users\\x)与 PowerShell 解释一致落在工作区内 → auto', () => {
    // C:Users\out.txt 是 drive-relative:同盘 workdir 下解析为 workdir\Users\out.txt,与 PS 实际行为一致
    expect(classifyCommandFor('echo x > C:Users\\out.txt', WS, WD, 'win32').verdict).toBe('auto')
  })
})

describe('W1: POSIX 分支回归 + ~/ 展开修复', () => {
  beforeAllSetup()
  it('区内相对/带引号 → auto;区外绝对/.. 越界 → ask', () => {
    expect(classifyCommandFor('echo x > out.txt', posixWs, posixWs, 'posix').verdict).toBe('auto')
    expect(classifyCommandFor("echo x > 'my file.txt'", posixWs, posixWs, 'posix').verdict).toBe('auto')
    expect(classifyCommandFor('echo x > /tmp/qd-a.txt', posixWs, posixWs, 'posix').verdict).toBe('ask')
    expect(classifyCommandFor('echo x > ../../outside.txt', posixWs, posixWs, 'posix').verdict).toBe('ask')
  })
  it('~/ 展开后落在工作区外 → ask(存量漏审批顺手修)', () => {
    // 工作区在 ~/.../ws 下,~/a.txt 展开为主目录根 → 区外
    const r = classifyCommandFor('echo x > ~/a.txt', posixWs, posixWs, 'posix')
    expect(r.verdict).toBe('ask')
  })
  it('工作区内 symlink 指向区外 → ask(realpath 穿透)', () => {
    const link = path.join(posixWs, 'escape')
    try {
      symlinkSync(tmpRoot, link) // 指向工作区的父目录(区外)
      expect(classifyCommandFor('echo x > escape/a.txt', posixWs, posixWs, 'posix').verdict).toBe('ask')
    } finally {
      rmSync(link)
    }
  })
  it('/dev/null 与 fd 合并 → auto', () => {
    expect(classifyCommandFor('echo x > /dev/null', posixWs, posixWs, 'posix').verdict).toBe('auto')
    expect(classifyCommandFor('ls > out.txt 2>&1', posixWs, posixWs, 'posix').verdict).toBe('auto')
  })
})

describe('W2: PowerShell 删除别名与参数缩写', () => {
  const asks = [
    'del -Recurse -Force C:/test', // review 原始示例
    'ri -Recurse -Force C:/test',
    'rmdir -Recurse -Force C:/test',
    'ri -r -fo C:/test',
    'Remove-Item -Force -Recurse C:/test', // 参数顺序倒置
    'erase -Recurse C:/x',
    'rd -Force C:/x'
  ]
  for (const cmd of asks) {
    it(`win32: ${cmd} → ask`, () => {
      expect(classifyCommandFor(cmd, WS, WD, 'win32').verdict).toBe('ask')
    })
  }
  it('win32: 既有规则不回归(reg delete/format/ExecutionPolicy/CMD del /s/POSIX rm -rf)', () => {
    for (const cmd of [
      'reg delete HKLM\\SOFTWARE\\X /f',
      'format D:',
      'Set-ExecutionPolicy Bypass',
      'del /s /q C:\\x',
      'rm -rf /tmp/x'
    ]) {
      expect(classifyCommandFor(cmd, WS, WD, 'win32').verdict, cmd).toBe('ask')
    }
  })
  it('win32: 只读命令保持 auto(-readonly 不误伤)', () => {
    for (const cmd of ['Get-ChildItem', 'pwd', 'Get-Content a.txt', 'attrib -readonly +r C:\\x.txt']) {
      expect(classifyCommandFor(cmd, WS, WD, 'win32').verdict, cmd).toBe('auto')
    }
  })
  it('darwin: Windows 模式不掺入(ri/del -Recurse 在 mac 清单下不拦)', () => {
    // ri/del 在 mac 上不是危险命令;确认平台分清单没有串
    expect(classifyCommandFor('del -Recurse -Force x', posixWs, posixWs, 'posix').verdict).toBe('auto')
  })
})

describe('W1 辅助: extractRedirectTargets 纯提取', () => {
  it('丢弃目标与 fd 合并识别', () => {
    expect(extractRedirectTargets('echo x > NUL', 'win32')).toEqual([{ kind: 'discard' }])
    expect(extractRedirectTargets('a 2>&1', 'win32')).toEqual([])
    expect(extractRedirectTargets('a >> b.txt', 'win32')).toEqual([])
  })
  it('引号内空格路径完整提取', () => {
    expect(extractRedirectTargets('echo x > "C:\\a b\\c.txt"', 'win32')).toEqual([
      { kind: 'file', target: 'C:\\a b\\c.txt' }
    ])
  })
})

/** posix 用例的临时工作区 */
function beforeAllSetup(): void {
  mkdirSync(posixWs, { recursive: true })
  writeFileSync(path.join(posixWs, 'a.txt'), 'x')
}

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响结论
  }
})
