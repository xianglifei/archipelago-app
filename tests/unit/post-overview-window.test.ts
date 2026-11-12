import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')

/**
 * T10(方案 §3.3,窗口部分):邮局概览取最近 500 封再翻回旧→新、未读全库统计;
 * 「分页中插入/删除/游标边界」半句属批次 D(F8 分页)。
 * SQL 从 src/main/post.ts 源码正则提取后执行(源码防漂移:改源码不改测试必红)。
 * 拆仓备注(2026-11-12):自 cloud 仓 post-header-and-overview.test.ts 的 F8 段迁入(断言对象=本仓 post.ts)。
 */
describe('F8: 邮局概览窗口与未读', () => {
  const src = readFileSync(join(ROOT, 'src/main/post.ts'), 'utf8')
  const windowSql = /prepare\('SELECT \* FROM post_letters (ORDER BY [^']+)'\)/.exec(src)?.[1]
  const unreadSql = /prepare\(\s*"SELECT COUNT\(\*\) AS c FROM post_letters ([^"]+)"\s*\)/.exec(src)?.[1]

  function makeDb() {
    const db = new Database(':memory:')
    db.exec(
      'CREATE TABLE post_letters (id TEXT PRIMARY KEY, remote_id INTEGER, direction TEXT, kind TEXT, subject TEXT, body TEXT, peer_island TEXT, peer_name TEXT, sender_kind TEXT, ref_remote_id INTEGER, attachments TEXT, status TEXT, error TEXT, created_at INTEGER, read_at INTEGER)'
    )
    return db
  }
  function fill(db: Database.Database, n: number) {
    const ins = db.prepare('INSERT INTO post_letters (id, remote_id, direction, kind, status, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (let i = 1; i <= n; i++) ins.run(`L${i}`, i, i % 3 === 0 ? 'out' : 'in', i % 4 === 0 ? 'friend_accept' : i % 2 ? 'letter' : 'friend_request', 'received', 1_000 + i, null)
  }

  it('源码防漂移:postOverview 的两条 SQL 原样可提取', () => {
    expect(windowSql).toBe('ORDER BY created_at DESC, remote_id DESC LIMIT 500')
    expect(unreadSql).toBe("WHERE direction = 'in' AND kind IN ('letter', 'friend_request') AND read_at IS NULL")
  })

  it('501 封:最新一封在窗口内、展示顺序旧→新;对照旧 ASC 窗口丢新信', () => {
    const db = makeDb()
    fill(db, 501)
    const letters = [...(db.prepare(`SELECT * FROM post_letters ${windowSql}`).all() as Array<{ id: string }>)]!.reverse()
    expect(letters).toHaveLength(500)
    expect(letters[499]!.id).toBe('L501')
    expect(letters[0]!.id).toBe('L2')
    const oldAsc = db.prepare('SELECT * FROM post_letters ORDER BY created_at ASC, remote_id ASC LIMIT 500').all() as Array<{ id: string }>
    expect(oldAsc.some((r) => r.id === 'L501')).toBe(false)
  })

  it('未读全库 COUNT:窗口外未读同样计入(口径与 countsUnread 同源)', () => {
    const db = makeDb()
    fill(db, 1200)
    const unread = (db.prepare(`SELECT COUNT(*) AS c FROM post_letters ${unreadSql}`).get() as { c: number }).c
    const manual = (db.prepare("SELECT COUNT(*) AS c FROM post_letters WHERE direction='in' AND kind IN ('letter','friend_request') AND read_at IS NULL").get() as { c: number }).c
    expect(unread).toBe(manual)
    expect(unread).toBeGreaterThan(500) // 旧实现只能数窗口内 500 条
  })
})
