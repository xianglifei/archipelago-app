import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'

/**
 * BYOK 真库回归(2026-11-13 拍板):用真 better-sqlite3 跑 store 的真实迁移与切档事务。
 * 两个必须钉死的行为:
 * 1. 0.9 群岛通道迁移是一次性闸——设好自带 Key 后重开库不许被写回 archipelago(否则重启即失效);
 * 2. 切档事务必须把存量居民一起刷掉,只改 model.default 的话聊天还走旧通道。
 */
const state = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.dir, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {},
  net: {},
  powerMonitor: { on: vi.fn() },
  dialog: {}
}))

// store 只从 paths 取 requireDataRoot;用真模块展开,避免连带模块的其它导出变 undefined
vi.mock('../../src/main/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/paths')>()
  return { ...actual, requireDataRoot: () => state.dir }
})

import { applyModelSource } from '../../src/main/bots'
import { closeDb, getDb } from '../../src/main/store'

function insertBot(db: Database.Database, id: string, provider: string, model: string, deleted = false): void {
  const ts = new Date().toISOString()
  db.prepare(
    `INSERT INTO bots (id, name, role, persona, provider_id, model_id, is_main, color, created_at, updated_at, deleted_at)
     VALUES (?, ?, '', '', ?, ?, 0, '#000000', ?, ?, ?)`
  ).run(id, id, provider, model, ts, ts, deleted ? ts : null)
}

function botRow(db: Database.Database, id: string): { provider_id: string; model_id: string } {
  return db.prepare('SELECT provider_id, model_id FROM bots WHERE id = ?').get(id) as {
    provider_id: string
    model_id: string
  }
}

function modelDefault(db: Database.Database): { providerId: string; modelId: string } {
  return JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'model.default'").get() as { value: string }).value)
}

function setModelDefault(db: Database.Database, providerId: string, modelId: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('model.default', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify({ providerId, modelId })
  )
}

function dropRelayMigrationFlag(db: Database.Database): void {
  db.prepare("DELETE FROM meta WHERE key = 'migration.0_9.relay_switch'").run()
}

beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-byok-'))
})

afterEach(() => {
  closeDb()
  fs.rmSync(state.dir, { recursive: true, force: true })
})

describe('0.9 群岛通道迁移的一次性闸', () => {
  it('老库升级:zhipu/deepseek 归到群岛通道,并落闸', () => {
    const first = getDb()
    insertBot(first, 'legacy-zhipu', 'zhipu', 'glm-5.3')
    insertBot(first, 'legacy-deepseek', 'deepseek', 'deepseek-flash')
    setModelDefault(first, 'zhipu', 'glm-5.3')
    // 模拟 0.9 之前的老库:闸还没落过
    dropRelayMigrationFlag(first)
    closeDb()

    const upgraded = getDb()
    expect(botRow(upgraded, 'legacy-zhipu')).toEqual({ provider_id: 'archipelago', model_id: 'deepseek-flash' })
    expect(botRow(upgraded, 'legacy-deepseek')).toEqual({ provider_id: 'archipelago', model_id: 'deepseek-flash' })
    expect(modelDefault(upgraded)).toEqual({ providerId: 'archipelago', modelId: 'deepseek-flash' })
    expect(upgraded.prepare('SELECT value FROM meta WHERE key = ?').get('migration.0_9.relay_switch')).toBeTruthy()
  })

  it('设好自带 Key 后重开库仍是自带 Key(重启不回落)', () => {
    const first = getDb()
    insertBot(first, 'momo', 'archipelago', 'deepseek-flash')
    // 走一次真实切档:默认模型 + 存量居民都被刷成 DeepSeek
    insertBot(first, 'resident', 'archipelago', 'deepseek-flash')
    setModelDefault(first, 'deepseek', 'deepseek-v4-pro')
    expect(applyModelSource('deepseek', 'deepseek-v4-pro')).toBe(2)
    closeDb()

    const reopened = getDb()
    expect(modelDefault(reopened)).toEqual({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' })
    expect(botRow(reopened, 'momo')).toEqual({ provider_id: 'deepseek', model_id: 'deepseek-v4-pro' })
    expect(botRow(reopened, 'resident')).toEqual({ provider_id: 'deepseek', model_id: 'deepseek-v4-pro' })
  })
})

describe('切档事务(applyModelSource)', () => {
  it('居民刷新失败时默认配置一起回滚,重试能修好(2026-11-13 codex 审查)', () => {
    const db = getDb()
    insertBot(db, 'momo', 'archipelago', 'deepseek-flash')
    setModelDefault(db, 'archipelago', 'deepseek-flash')
    // 故障注入:让「刷居民」这一步必定抛错,验证两段写要么一起成、要么一起回滚
    db.exec("CREATE TRIGGER boom BEFORE UPDATE ON bots BEGIN SELECT RAISE(ABORT, 'boom'); END")
    expect(() => applyModelSource('deepseek', 'deepseek-v4-pro')).toThrow(/boom/)
    // 默认配置没有单独提交:设置页不会出现「显示已切、聊天还走旧通道」的假状态
    expect(modelDefault(db)).toEqual({ providerId: 'archipelago', modelId: 'deepseek-flash' })
    expect(botRow(db, 'momo')).toEqual({ provider_id: 'archipelago', model_id: 'deepseek-flash' })

    db.exec('DROP TRIGGER boom')
    // 故障解除后重试必须真的生效(两段式写在这里会被 previous 判断跳过,永远修不回来)
    expect(applyModelSource('deepseek', 'deepseek-v4-pro')).toBe(1)
    expect(modelDefault(db)).toEqual({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' })
    expect(botRow(db, 'momo')).toEqual({ provider_id: 'deepseek', model_id: 'deepseek-v4-pro' })
  })

  it('刷全部活着的居民,已送别的不动', () => {
    const db = getDb()
    insertBot(db, 'alive-1', 'archipelago', 'deepseek-flash')
    insertBot(db, 'alive-2', 'archipelago', 'deepseek-flash')
    insertBot(db, 'gone', 'archipelago', 'deepseek-flash', true)

    expect(applyModelSource('deepseek', 'deepseek-v4-pro')).toBe(2)
    expect(botRow(db, 'alive-1')).toEqual({ provider_id: 'deepseek', model_id: 'deepseek-v4-pro' })
    expect(botRow(db, 'alive-2')).toEqual({ provider_id: 'deepseek', model_id: 'deepseek-v4-pro' })
    expect(botRow(db, 'gone')).toEqual({ provider_id: 'archipelago', model_id: 'deepseek-flash' })

    // 切回群岛通道同样整岛生效
    expect(applyModelSource('archipelago', 'deepseek-flash')).toBe(2)
    expect(botRow(db, 'alive-1')).toEqual({ provider_id: 'archipelago', model_id: 'deepseek-flash' })
  })
})
