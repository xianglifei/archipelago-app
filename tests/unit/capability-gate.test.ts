// @ts-expect-error 纯 JS 门禁核心模块(与 CLI 同源,无 .d.ts)
import { evaluateCapabilitiesResponse, compareCapabilities, evaluateGate } from '../../scripts/capability-gate-core.mjs'
import { describe, expect, it } from 'vitest'

const body = (data: unknown) => JSON.stringify({ ok: true, data })
const ONLINE = {
  protocolVersion: 1,
  service: 'archipelago-sea',
  environment: 'production',
  deploy: 'a'.repeat(40),
  deployedAt: '2026-11-12T00:00:00Z',
  capabilities: { 'post.letters': 1, 'relay.stream': 2 },
}
const REQUIRED = { 'post.letters': 1, 'relay.stream': 1 }

describe('evaluateCapabilitiesResponse:HTTP/形状分级(终审第 8 条)', () => {
  it('200 合法载荷 → ok,online 为 data 载荷', () => {
    const r = evaluateCapabilitiesResponse(200, body(ONLINE))
    expect(r.verdict).toBe('ok')
  })
  it('000(超时/DNS/代理)→ blocked endpoint-unreachable', () => {
    const r = evaluateCapabilitiesResponse(0, '')
    expect(r).toMatchObject({ verdict: 'blocked', reason: 'endpoint-unreachable' })
  })
  it('5xx → blocked endpoint-error(服务端错误不得豁免)', () => {
    expect(evaluateCapabilitiesResponse(502, 'bad gateway')).toMatchObject({ verdict: 'blocked', reason: 'endpoint-error' })
  })
  it('404 → blocked endpoint-error(非预期状态)', () => {
    expect(evaluateCapabilitiesResponse(404, 'Not Found')).toMatchObject({ verdict: 'blocked', reason: 'endpoint-error' })
  })
  it('200 但响应体是 HTML(回落静态资产页)→ blocked malformed', () => {
    expect(evaluateCapabilitiesResponse(200, '<!doctype html><html></html>')).toMatchObject({ verdict: 'blocked', reason: 'malformed' })
  })
  it('200 合法 JSON 但无 data 载荷 → blocked malformed', () => {
    expect(evaluateCapabilitiesResponse(200, JSON.stringify({ ok: true }))).toMatchObject({ verdict: 'blocked', reason: 'malformed' })
  })
  it('收紧(终检补):ok:false / service 不符 / 小数能力值 → blocked malformed', () => {
    expect(evaluateCapabilitiesResponse(200, JSON.stringify({ ok: false, data: ONLINE }))).toMatchObject({ verdict: 'blocked', reason: 'malformed' })
    expect(evaluateCapabilitiesResponse(200, body({ ...ONLINE, service: 'wrong-service' }))).toMatchObject({ verdict: 'blocked', reason: 'malformed' })
    expect(evaluateCapabilitiesResponse(200, body({ ...ONLINE, capabilities: { x: 1.5 } }))).toMatchObject({ verdict: 'blocked', reason: 'malformed' })
  })
  it('protocolVersion 缺失/capabilities 非对象/含非正数值 → blocked malformed', () => {
    expect(evaluateCapabilitiesResponse(200, body({ service: 'x', capabilities: {} }))).toMatchObject({ verdict: 'blocked', reason: 'malformed' })
    expect(evaluateCapabilitiesResponse(200, body({ protocolVersion: 1, service: 'x' }))).toMatchObject({ verdict: 'blocked', reason: 'malformed' })
    expect(evaluateCapabilitiesResponse(200, body({ protocolVersion: 1, service: 'x', capabilities: { a: -1 } }))).toMatchObject({ verdict: 'blocked', reason: 'malformed' })
  })
})

describe('compareCapabilities:需求 ≤ 线上', () => {
  it('全满足 → ok', () => {
    expect(compareCapabilities(REQUIRED, ONLINE.capabilities).verdict).toBe('ok')
  })
  it('线上值更高 → 满足(升版向后兼容语义)', () => {
    expect(compareCapabilities({ 'relay.stream': 2 }, ONLINE.capabilities).verdict).toBe('ok')
  })
  it('缺项 → missing 逐项指名(required 与 online)', () => {
    const r = compareCapabilities({ 'post.letters': 1, 'skills.catalog': 1 }, ONLINE.capabilities)
    expect(r).toEqual({ verdict: 'missing', missing: [{ name: 'skills.catalog', required: 1, online: null }] })
  })
  it('线上值低于需求 → missing(回滚低于已发布需求语义)', () => {
    const r = compareCapabilities({ 'relay.stream': 2 }, { 'relay.stream': 1 })
    expect(r).toEqual({ verdict: 'missing', missing: [{ name: 'relay.stream', required: 2, online: 1 }] })
  })
})

describe('evaluateGate:三分级汇总', () => {
  it('满足 → pass(附 online 供留痕)', () => {
    const r = evaluateGate({ httpStatus: 200, bodyText: body(ONLINE), required: REQUIRED })
    expect(r.verdict).toBe('pass')
  })
  it('缺能力 → incompatible(唯一允许 --cloud-pending-ok 的类别)', () => {
    const r = evaluateGate({ httpStatus: 200, bodyText: body(ONLINE), required: { ...REQUIRED, 'skills.catalog': 1 } })
    expect(r.verdict).toBe('incompatible')
  })
  it('端点不可达 → blocked(逃生口不适用)', () => {
    const r = evaluateGate({ httpStatus: 0, bodyText: '', required: REQUIRED })
    expect(r.verdict).toBe('blocked')
  })
  it('畸形响应 → blocked(逃生口不适用)', () => {
    const r = evaluateGate({ httpStatus: 200, bodyText: '<html>gateway</html>', required: REQUIRED })
    expect(r.verdict).toBe('blocked')
  })
})
