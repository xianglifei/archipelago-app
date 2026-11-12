// 邮局首拉与批量已读回归(#27/#28,2026-11-04):
//   #28 启动/登录就绪后立即收信(不等 120s 轮询)、无新信也追平通讯录且「有变化才广播」;
//   #27 进邮局批量标已读=一个事务+一次广播+逐封回执,已读的再标不广播。
// 复用 post-boot-safety 的 mock 骨架(不变量:登录门前一切库访问静默)。
import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const state = vi.hoisted(() => ({
  db: null as any,
  token: '' as string,
  uid: '11111111-1111-4111-8111-111111111111',
  sends: 0,
  fetchLog: [] as string[],
  inboxLetters: [] as any[],
  contacts: [] as any[]
}))

vi.mock('../../src/main/store', () => ({
  getDb: () => {
    if (!state.db) throw new Error('尚未登录,账号数据未挂载')
    return state.db
  }
}))
vi.mock('../../src/main/paths', () => ({ requireDataRoot: () => { throw new Error('尚未登录,账号数据未挂载') } }))
vi.mock('../../src/main/auth', () => ({
  currentSeaToken: () => state.token || null,
  currentIslandUid: () => (state.token ? state.uid : null),
  currentIslandArtworkId: () => null,
  SEA_BASE_URL: 'https://example.invalid'
}))
vi.mock('../../src/main/chat', () => ({ notifyIfBlurred: vi.fn() }))
vi.mock('../../src/main/space', () => ({ getSpace: () => ({ ownerName: '合成岛主' }) }))
vi.mock('../../src/main/ui-strings', () => ({ uiStr: (key: string) => key }))
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: () => { state.sends += 1 } } }] },
  net: {
    fetch: async (url: string) => {
      state.fetchLog.push(url)
      const path = url.replace('https://example.invalid', '')
      if (path.startsWith('/post/inbox')) {
        return Response.json({ ok: true, data: { cursor: 1, hasMore: false, letters: state.inboxLetters } })
      }
      if (path === '/post/contacts') return Response.json({ ok: true, data: { contacts: state.contacts } })
      return Response.json({ ok: true, data: {} })
    }
  },
  powerMonitor: { on: vi.fn() },
  dialog: {}
}))
import { initPostPoller, postMarkReadMany, postOnAuthChanged, postOverview, postPullNow, pullInbox, POST_DDL } from '../../src/main/post'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(POST_DDL + 'CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)')
  return db
}

function inboxFetches(): number {
  return state.fetchLog.filter((u) => u.includes('/post/inbox')).length
}

describe('post kickoff pull & batch read (#27/#28)', () => {
  it('cold start logged out: init is silent, no fetch happens until login is ready', () => {
    state.db = null
    state.token = ''
    expect(() => initPostPoller()).not.toThrow()
    expect(state.fetchLog).toEqual([])
  })

  it('login ready → kickoff pulls immediately; welcome letter lands with exactly one broadcast (#28)', async () => {
    state.db = freshDb()
    state.token = 'synthetic'
    state.inboxLetters = [
      {
        id: 9001,
        kind: 'letter',
        refId: null,
        fromIsland: 'system',
        fromArtworkId: 'station',
        subject: null,
        body: '欢迎来到群岛',
        senderKind: 'officer',
        senderName: '首席联络官（群岛联络站）',
        status: 'sent',
        createdAt: 123,
        attachments: []
      }
    ]
    state.contacts = []
    const sendsBefore = state.sends
    postOnAuthChanged(true) // 登录出口:立即首拉,不等 120s
    await vi.waitFor(() => expect(inboxFetches()).toBe(1))
    await vi.waitFor(() => expect(state.sends).toBe(sendsBefore + 1))
    expect(postOverview().unread).toBe(1)
    expect(postOverview().letters.map((l) => l.remoteId)).toContain(9001)
  })

  it('postMarkReadMany: one transaction + one broadcast + one receipt per letter; re-mark is a no-op (#27)', async () => {
    const overview = postOverview()
    const unreadIds = overview.letters.filter((l) => l.readAt === null).map((l) => l.id)
    expect(unreadIds.length).toBe(1)
    const sendsBefore = state.sends
    const receiptsBefore = state.fetchLog.filter((u) => u.includes('/read')).length
    postMarkReadMany([unreadIds[0]!, unreadIds[0]!, 'not-exist']) // 重复 id 与不存在 id 都安全
    expect(state.sends).toBe(sendsBefore + 1) // 整批只广播一次(旧实现 N 封 N 次广播)
    await vi.waitFor(() =>
      expect(state.fetchLog.filter((u) => u.includes('/read')).length).toBe(receiptsBefore + 1)
    )
    expect(postOverview().unread).toBe(0)
    const sendsAfter = state.sends
    postMarkReadMany(unreadIds) // 已读的再标:不广播、不回执
    await new Promise((r) => setTimeout(r, 10))
    expect(state.sends).toBe(sendsAfter)
    expect(state.fetchLog.filter((u) => u.includes('/read')).length).toBe(receiptsBefore + 1)
  })

  it('empty inbox still syncs contacts; broadcasts on contact change, silent when nothing changes (#28)', async () => {
    const db = freshDb()
    state.db = db // 换新库模拟「服务端通讯录有、本地没有」
    state.inboxLetters = []
    state.contacts = [{ islandUid: 'island-b', islandName: '灯塔岛', ownerName: '小周', since: 5 }]
    const sendsBefore = state.sends
    await pullInbox()
    await vi.waitFor(() => expect(postOverview().contacts.map((c) => c.islandUid)).toContain('island-b'))
    expect(state.sends).toBe(sendsBefore + 1) // 通讯录从无到有 → 广播(旧实现 letters 为空提前 return,永不追平)
    const sendsAfter = state.sends
    await pullInbox() // 再拉一轮:无任何变化
    expect(state.sends).toBe(sendsAfter) // 不广播
    db.close()
  })

  it('postPullNow is throttled within 30s of the last pull', async () => {
    const before = inboxFetches()
    await postPullNow()
    expect(inboxFetches()).toBe(before) // 刚拉过:节流跳过,不补打云端
  })
})
