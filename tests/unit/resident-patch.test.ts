import { describe, it, expect } from 'vitest'
import { parseResidentPatch } from '../../src/main/resident-patch-core'

// update_resident 字段解析冒烟(2026-11-05 issue #30 空串清空):
// role/persona 空串/纯空格=显式清空回「未设」、null/缺省=不改、name 空=拒绝、
// archetype 不在八型=拒绝、同值(含已空再传空)当没改、全没传=至少要改一项。
// 空值语义与 invite(空=不设)在此分家:update 的空是岛主的明确指令

const target = { name: 'Momo', role: '研究员', persona: '擅长写代码,说话干脆', archetype: 'sunshine' }

describe('parseResidentPatch 空串清空(#30)', () => {
  it('role 传空串/纯空格 = 显式清空,patch.role 为空串(而非被当成没传)', () => {
    const r1 = parseResidentPatch({ to: 'Momo', role: '' }, target)
    expect(r1.error).toBeUndefined()
    expect(r1.patch.role).toBe('')
    const r2 = parseResidentPatch({ to: 'Momo', role: '   ' }, target)
    expect(r2.error).toBeUndefined()
    expect(r2.patch.role).toBe('')
  })

  it('persona 传空串同样清空;与 role 一起清也只算这两个字段', () => {
    const r = parseResidentPatch({ to: 'Momo', persona: '' }, target)
    expect(r.error).toBeUndefined()
    expect(r.patch.persona).toBe('')
    expect(r.patch.role).toBeUndefined()
    expect(r.patch.name).toBeUndefined()
  })

  it('null 与缺省一样视为没传(防模型把 null 当清空误触)', () => {
    const r = parseResidentPatch({ to: 'Momo', role: null, persona: null, name: 'Nova' }, target)
    expect(r.error).toBeUndefined()
    expect(r.patch.role).toBeUndefined()
    expect(r.patch.persona).toBeUndefined()
    expect(r.patch.name).toBe('Nova')
  })

  it('非空值照常 trim 落 patch', () => {
    const r = parseResidentPatch({ to: 'Momo', role: '  写手  ', persona: ' 擅长排版 ' }, target)
    expect(r.error).toBeUndefined()
    expect(r.patch.role).toBe('写手')
    expect(r.patch.persona).toBe('擅长排版')
  })
})

describe('parseResidentPatch 拒绝口径', () => {
  it('什么都没传报「至少要改一项」', () => {
    const r = parseResidentPatch({ to: 'Momo' }, target)
    expect(r.error).toBe('至少要改一项:名字(name)、角色(role)、人设(persona)或性格(archetype)。')
    expect(Object.keys(r.patch)).toHaveLength(0)
  })

  it('name 传空串被拒绝(居民必须有名字),不许清空', () => {
    const r = parseResidentPatch({ to: 'Momo', name: '' }, target)
    expect(r.error).toBe('新名字不能为空;不想改名字就不要传 name。')
  })

  it('archetype 传空串视为没传(八型必选,不存在清空);不在八型报错', () => {
    const onlyEmpty = parseResidentPatch({ to: 'Momo', archetype: '' }, target)
    expect(onlyEmpty.error).toBe('至少要改一项:名字(name)、角色(role)、人设(persona)或性格(archetype)。')
    const bad = parseResidentPatch({ to: 'Momo', archetype: '傲娇' }, target)
    expect(bad.error).toContain('没有「傲娇」这个性格原型')
    const ok = parseResidentPatch({ to: 'Momo', archetype: '温柔' }, target)
    expect(ok.error).toBeUndefined()
    expect(ok.patch.archetype).toBe('gentle')
  })
})

describe('parseResidentPatch 同值去重', () => {
  it('传现值当没改:全部同值时报「没有要改的」,不产生空审批卡', () => {
    const r = parseResidentPatch({ to: 'Momo', name: 'Momo', role: '研究员', persona: '擅长写代码,说话干脆' }, target)
    expect(r.error).toBe('传来的改动都和「Momo」现在的一样,没有要改的。')
    expect(Object.keys(r.patch)).toHaveLength(0)
  })

  it('已空字段再传空串=同值当没改;只有它时报「没有要改的」而非进审批', () => {
    const emptyTarget = { name: 'Nova', role: '', persona: '', archetype: 'gentle' }
    const r = parseResidentPatch({ to: 'Nova', persona: '' }, emptyTarget)
    expect(r.error).toBe('传来的改动都和「Nova」现在的一样,没有要改的。')
  })

  it('同值字段被去重,混着的真改动保留', () => {
    const r = parseResidentPatch({ to: 'Momo', role: '研究员', persona: '' }, target)
    expect(r.error).toBeUndefined()
    expect(r.patch.role).toBeUndefined()
    expect(r.patch.persona).toBe('')
  })
})
