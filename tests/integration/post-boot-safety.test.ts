// 邮局启动安全回归(2026-11-02 v1.2.3 热修):v1.2.2 在 initPostPoller 里提前访问业务库,
// 启动早期账号数据未挂载时抛「尚未登录,账号数据未挂载」弹「群岛启动遇到问题」框(1.2.0→1.2.2 升级实机复现)。
// 不变量:init 只挂定时器;一切库访问必须在 pullInbox 登录守卫之后。
import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
const state = vi.hoisted(() => ({ db: null as any, token: 'synthetic' }))
vi.mock('../../src/main/store', () => ({
  getDb: () => {
    if (!state.db) throw new Error('尚未登录,账号数据未挂载')
    return state.db
  }
}))
vi.mock('../../src/main/paths', () => ({ requireDataRoot: () => { throw new Error('尚未登录,账号数据未挂载') } }))
vi.mock('../../src/main/auth', () => ({ currentIslandUid: () => '11111111-1111-4111-8111-111111111111', currentIslandArtworkId: () => null, currentSeaToken: () => state.token, SEA_BASE_URL: 'https://example.invalid' }))
vi.mock('../../src/main/chat', () => ({ notifyIfBlurred: vi.fn() }))
vi.mock('../../src/main/space', () => ({ getSpace: () => ({ ownerName: '合成岛主' }) }))
vi.mock('../../src/main/ui-strings', () => ({ uiStr: (key: string) => key }))
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: async () => Response.json({ ok: true, data: { cursor: 0, hasMore: false, letters: [] } }) },
  powerMonitor: { on: vi.fn() },
  dialog: {}
}))
import { initPostPoller, pullInbox, POST_DDL } from '../../src/main/post'

describe('post poller boot safety (v1.2.3 hotfix)', () => {
  it('initPostPoller must not touch the account DB — cold start before login stays silent', () => {
    state.db = null // 未登录:账号数据未挂载,getDb 抛错
    expect(() => initPostPoller()).not.toThrow()
  })

  it('pullInbox stays silent when logged out, then runs the legacy notice rename on the first poll after login', async () => {
    state.db = null
    state.token = '' // 登出态:静默返回,也不触发订正
    await expect(pullInbox()).resolves.toBeUndefined()

    state.token = 'synthetic' // 登录完成,账号库挂载:存量转告信署名在首个轮询补订正
    const db = new Database(':memory:')
    db.exec(POST_DDL + 'CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)')
    db.prepare("INSERT INTO post_letters VALUES('local-1',1,'in','system','群岛联络站','letter',NULL,NULL,'转告:x','system','[]','received',NULL,100,NULL)").run()
    db.prepare("INSERT INTO post_letters VALUES('local-2',2,'in','system','首席联络官（群岛联络站）','letter',NULL,NULL,'欢迎','officer','[]','received',NULL,200,NULL)").run()
    state.db = db
    await pullInbox()
    const names = db.prepare('SELECT id, peer_name FROM post_letters ORDER BY id').all() as { id: string; peer_name: string }[]
    expect(names).toEqual([
      { id: 'local-1', peer_name: '系统通知（群岛联络站）' }, // 旧署名已订正
      { id: 'local-2', peer_name: '首席联络官（群岛联络站）' } // 新署名原样保留
    ])
    db.close()
  })

  it('a transient DB failure defers the rename to the next poll instead of surfacing an error', async () => {
    vi.resetModules() // 上一条用例已消费模块级一次性标记,取新鲜模块实例验证「失败后下轮重试」
    const { pullInbox: freshPull } = await import('../../src/main/post')
    state.db = null
    state.token = 'synthetic' // 已登录但库暂不可用(挂载竞态):订正失败静默,下轮重试
    await expect(freshPull()).resolves.toBeUndefined()

    const db = new Database(':memory:')
    db.exec(POST_DDL + 'CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)')
    db.prepare("INSERT INTO post_letters VALUES('local-1',1,'in','system','群岛联络站','letter',NULL,NULL,'转告','system','[]','received',NULL,100,NULL)").run()
    state.db = db
    await freshPull()
    expect((db.prepare("SELECT peer_name FROM post_letters WHERE id='local-1'").get() as { peer_name: string }).peer_name).toBe('系统通知（群岛联络站）')
    db.close()
  })
})
