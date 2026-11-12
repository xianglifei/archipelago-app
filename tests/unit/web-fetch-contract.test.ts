import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')

/**
 * F4 重定向守门的源码契约静态断言(运行时行为由批次 D 的 Electron 专项验收,方案 §9)。
 * 两轮返修的教训锚点:net.fetch 与 net.request 的 redirect 默认都是 follow(electron.d.ts 明文),
 * 必须显式 manual + redirect 事件内不调 followRedirect(校验是 async 而 followRedirect 只能同步调)。
 * 阶段 1 单仓解耦:原文件里的 F9 schema 防漂移段(依赖 scripts/verify-schema-core.mjs 与
 * cloud/migrations)已拆到 schema-drift.test.ts——拆仓时本文件随客户端仓走,F9 段随 cloud 仓走。
 */
describe('F4: web_fetch 重定向契约(静态)', () => {
  const src = readFileSync(join(ROOT, 'src/main/web.ts'), 'utf8')

  it('net.request 显式 redirect: manual(默认 follow,凭心智模型断言默认值已栽过一次)', () => {
    expect(src).toContain("redirect: 'manual'")
  })
  it('redirect 事件守门在位(每跳发出前触发,只接收目标不跟随)', () => {
    expect(src).toContain("on('redirect'")
  })
  it('不调 followRedirect:跳转被取消,校验通过后由外层重发', () => {
    expect(src).not.toMatch(/\.followRedirect\(\)/)
  })
  it('跳数上限与每跳 SSRF 校验在位', () => {
    expect(src).toContain('FETCH_MAX_REDIRECTS')
    expect(src).toContain('await assertPublicHost(current.hostname)')
  })
  it('fetchLocal 主路径不再使用自动跟随的 net.fetch', () => {
    const body = src.slice(src.indexOf('async function fetchLocal'), src.indexOf('async function fetchViaSea'))
    expect(body).not.toContain('net.fetch(')
  })
})
