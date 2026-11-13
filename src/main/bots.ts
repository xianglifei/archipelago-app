import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { Bot, BotAppearance, BotPatch, CreateBotInput } from '@shared/types'
import { EV } from '@shared/ipc-channels'
import { MAIN_BOT_APPEARANCE, isValidAppearance, randomAppearance } from '@shared/avatar'
import { archetypeError, getArchetype, MAIN_BOT_ARCHETYPE } from '@shared/archetypes'
import { getDb, nowIso } from './store'
import { getModelConfig } from './space'
import { audit } from './audit'
// 与 sessions 互相 import(它要 getBot/listBots,我们要 getOrCreateSession/insertMessage)——
// 双方都只在运行期调用对方导出,加载期无交叉执行,循环引用安全(同 tools ↔ groups 约定)
import { getOrCreateSession, insertMessage } from './sessions'

// M2:Bot 是身份不是进程;删除为软删除、记忆归档不删(M2.3)

const MAIN_COLOR = '#0d9488'
const PALETTE = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#ec4899', '#10b981', '#f97316', '#6366f1', '#14b8a6']

interface BotRow {
  id: string
  name: string
  role: string
  persona: string
  archetype: string
  provider_id: string
  model_id: string
  is_main: number
  color: string
  appearance: string | null
  permission: string
  workspace_path: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

/** appearance 列存 JSON 字符串;损坏/非法数据静默回退 null(渲染端用 color+首字兜底) */
function parseAppearance(raw: string | null): BotAppearance | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return isValidAppearance(value) ? value : null
  } catch {
    return null
  }
}

/** 工作区目录(M4.1 起,2026-10-28 迁主目录):~/群岛/<名字>-<ID 前缀>,Finder 可见;入住即建 */
import { defaultWorkspacePath, ensureWorkspaceDir } from './workspace'
export { defaultWorkspacePath }

function fromRow(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    persona: row.persona,
    // 历史空值兜底:主 Bot=小太阳,普通居民=温柔(不应出现,防的是异常库)
    archetype: row.archetype || (row.is_main === 1 ? MAIN_BOT_ARCHETYPE : 'gentle'),
    providerId: row.provider_id,
    modelId: row.model_id,
    isMain: row.is_main === 1,
    color: row.color,
    appearance: parseAppearance(row.appearance),
    // 权限两档(2026-10-27):存量一次性迁移 full→auto,其余(readonly/workspace/旧空值)→semi
    permission: row.permission === 'full' || row.permission === 'auto' ? 'auto' : 'semi',
    workspacePath: row.workspace_path?.trim() || defaultWorkspacePath(row.name, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listBots(): Bot[] {
  const rows = getDb()
    .prepare('SELECT * FROM bots WHERE deleted_at IS NULL ORDER BY is_main DESC, created_at ASC')
    .all() as BotRow[]
  return rows.map(fromRow)
}

export function getBot(id: string): Bot | null {
  const row = getDb()
    .prepare('SELECT * FROM bots WHERE id = ? AND deleted_at IS NULL')
    .get(id) as BotRow | undefined
  return row ? fromRow(row) : null
}

function insertBot(bot: Bot): Bot {
  getDb()
    .prepare(
      `INSERT INTO bots (id, name, role, persona, archetype, provider_id, model_id, is_main, color, appearance, permission, workspace_path, created_at, updated_at)
       VALUES (@id, @name, @role, @persona, @archetype, @providerId, @modelId, @isMain, @color, @appearance, @permission, @workspacePath, @createdAt, @updatedAt)`
    )
    .run({
      id: bot.id,
      name: bot.name,
      role: bot.role,
      persona: bot.persona,
      archetype: bot.archetype,
      providerId: bot.providerId,
      modelId: bot.modelId,
      isMain: bot.isMain ? 1 : 0,
      color: bot.color,
      appearance: bot.appearance ? JSON.stringify(bot.appearance) : null,
      permission: bot.permission,
      workspacePath: bot.workspacePath,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt
    })
  return bot
}

/** 主 Bot「Momo」:首次开场时自动入住(M2.2),始终存在、不可删除(红线 6.3) */
export function ensureMainBot(): Bot {
  const existing = getDb()
    .prepare('SELECT * FROM bots WHERE is_main = 1 AND deleted_at IS NULL')
    .get() as BotRow | undefined
  if (existing) return fromRow(existing)

  const fallback = getModelConfig()
  const ts = nowIso()
  const id = randomUUID()
  const bot = insertBot({
    id,
    name: 'Momo',
    role: '岛务长',
    persona: '你是岛上第一位居民,负责调度整座岛:帮岛主安排事务、介绍和邀请新居民、协调居民之间的分工。热情可靠,办事有始有终。',
    archetype: MAIN_BOT_ARCHETYPE,
    providerId: fallback?.providerId ?? 'archipelago',
    modelId: fallback?.modelId ?? 'deepseek-flash',
    isMain: true,
    color: MAIN_COLOR,
    appearance: MAIN_BOT_APPEARANCE,
    permission: 'semi',
    workspacePath: defaultWorkspacePath('Momo', id),
    createdAt: ts,
    updatedAt: ts
  })
  ensureWorkspaceDir(bot.workspacePath) // 入住即建:主目录「群岛」文件夹里立刻可见
  return bot
}

/** 重名检查:活着的居民里不允许同名(已送别居民的名字可以复用);exceptId 供改名时排除自己 */
function assertNameAvailable(name: string, exceptId?: string): void {
  const dup = getDb()
    .prepare('SELECT id FROM bots WHERE name = ? AND deleted_at IS NULL AND id != ?')
    .get(name, exceptId ?? '') as { id: string } | undefined
  if (dup) throw new Error(`岛上已经有叫「${name}」的居民了,不能重名`)
}

/** 邀请居民(M2.1):providerId/modelId 留空则继承全局默认(M11.6);archetype 缺省=温柔(手动邀请默认档) */
export function createBot(input: CreateBotInput): Bot {
  const name = input.name.trim()
  if (!name) throw new Error('居民需要一个名字')
  assertNameAvailable(name)
  if (input.appearance && !isValidAppearance(input.appearance)) throw new Error('这个外观组合不存在')
  const archetype = input.archetype?.trim() || 'gentle'
  const archError = archetypeError(archetype, false)
  if (archError) throw new Error(archError)
  const fallback = getModelConfig()
  const ts = nowIso()
  const id = randomUUID()
  const bot = insertBot({
    id,
    name,
    role: input.role.trim(),
    persona: input.persona.trim(),
    archetype,
    providerId: input.providerId.trim() || fallback?.providerId || 'archipelago',
    modelId: input.modelId.trim() || fallback?.modelId || 'deepseek-flash',
    isMain: false,
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)]!,
    appearance: input.appearance ?? randomAppearance(),
    permission: 'semi',
    workspacePath: defaultWorkspacePath(name, id),
    createdAt: ts,
    updatedAt: ts
  })
  ensureWorkspaceDir(bot.workspacePath) // 入住即建:主目录「群岛」文件夹里立刻可见
  return bot
}

/** 居民档案(M2.3/2.4):名字/角色/人设/性格/模型/权限/工作区/外观都可改;主 Bot 不可删除(红线 6.3) */
export function updateBot(id: string, patch: BotPatch): Bot {
  const bot = getBot(id)
  if (!bot) throw new Error('居民不存在')
  if (patch.appearance !== undefined && patch.appearance !== null && !isValidAppearance(patch.appearance)) {
    throw new Error('这个外观组合不存在')
  }
  // 0.9.2 自走查(D2):名字必填——空名 patch 直接拒绝,不许静默回落旧名假装保存成功
  if (patch.name !== undefined && !patch.name.trim()) {
    throw new Error('名字是必填项，每位居民都得有个名字')
  }
  let archetype = bot.archetype
  if (patch.archetype !== undefined && patch.archetype.trim()) {
    const archError = archetypeError(patch.archetype, bot.isMain)
    if (archError) throw new Error(archError)
    archetype = patch.archetype.trim()
  }
  const next: Bot = {
    ...bot,
    name: patch.name?.trim() || bot.name,
    role: patch.role !== undefined ? patch.role.trim() : bot.role,
    persona: patch.persona !== undefined ? patch.persona.trim() : bot.persona,
    archetype,
    providerId: patch.providerId?.trim() || bot.providerId,
    modelId: patch.modelId?.trim() || bot.modelId,
    appearance: patch.appearance !== undefined ? patch.appearance : bot.appearance,
    permission: patch.permission ?? bot.permission,
    workspacePath: patch.workspacePath?.trim() || bot.workspacePath,
    updatedAt: nowIso()
  }
  if (next.name !== bot.name) assertNameAvailable(next.name, id)
  getDb()
    .prepare(
      'UPDATE bots SET name = ?, role = ?, persona = ?, archetype = ?, provider_id = ?, model_id = ?, appearance = ?, permission = ?, workspace_path = ?, updated_at = ? WHERE id = ?'
    )
    .run(
      next.name,
      next.role,
      next.persona,
      next.archetype,
      next.providerId,
      next.modelId,
      next.appearance ? JSON.stringify(next.appearance) : null,
      next.permission,
      next.workspacePath,
      next.updatedAt,
      id
    )
  // 性格切换留审计痕(0.8 拍板:档案页可选显示「曾经是 xx 型」的数据来源)
  if (next.archetype !== bot.archetype) {
    const label = (aid: string): string => getArchetype(aid)?.name ?? aid
    audit(id, 'archetype', { from: label(bot.archetype), to: label(next.archetype) })
  }
  // 改名触达居民本人(#11,2026-10-31):档案页改名原本只落数据,居民不知情仍以旧名自称。
  // 向 TA 的单聊插一条 user 消息(岛主口吻的岛务通知)——进上下文、时间线可见可审计,
  // 下一回合起 TA 知道自己被改名;不触发回合(不烧积分),等下次被叫醒自然读到。
  // 居民经 update_resident 改别人名字也走这里,同享通知(正好补上「被改的一方不知情」的同款缺口)
  if (next.name !== bot.name) {
    const session = getOrCreateSession(id)
    insertMessage(
      session.id,
      'user',
      `(岛务通知:你的名字被岛主从「${bot.name}」改成了「${next.name}」。从现在起你就是「${next.name}」——被问到名字时用新名字作答,别再自称「${bot.name}」。)`
    )
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EV.ChatSync, { botId: id })
  }
  // 改指工作区:顺手把目标目录建出来(手输路径常指向尚不存在的目录,建完即可写)
  if (next.workspacePath !== bot.workspacePath) ensureWorkspaceDir(next.workspacePath)
  return next
}

/** 整岛切换模型来源(2026-11-13 BYOK):全局默认 + 全部存量居民在同一事务里刷成新通道/新模型。
 *  存量居民的 provider/model 是建行时写死的(bots.ts 的 ensureMainBot/createBot),只改
 *  model.default 不会跟随——设置页显示已切换、聊天还走旧通道,用户会以为开关是假的。
 *  本轮没有 per-bot 模型 UI,心智就是「整座岛换大脑」;将来做 per-bot 覆盖时再引入
 *  follow_default 位。返回实际刷到的居民数(测试与日志用)。 */
export function applyModelSource(providerId: string, modelId: string): number {
  const database = getDb()
  const run = database.transaction(() =>
    database
      .prepare('UPDATE bots SET provider_id = ?, model_id = ?, updated_at = ? WHERE deleted_at IS NULL')
      .run(providerId, modelId, nowIso()).changes
  )
  return run()
}

/** 送别居民(M2.3):软删除,记录保留 */
export function softDeleteBot(id: string): void {
  const bot = getBot(id)
  if (!bot) return
  if (bot.isMain) throw new Error(`${bot.name} 是第一位居民,不能被送别`)
  getDb().prepare('UPDATE bots SET deleted_at = ? WHERE id = ?').run(nowIso(), id)
}
