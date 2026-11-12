import type { BotSkillEntry, IslandSkillDetail, IslandSkillSummary, OfficialSkillCard } from '@shared/types'
import {
  IMPORT_ASSET_MAX_FILE_BYTES,
  IMPORT_ASSET_MAX_TOTAL_BYTES,
  sanitizeSkillDirName,
  validateImportedSkillDraft,
  type ScannedAssetFile
} from '@shared/skill-import-core'
import fs from 'node:fs'
import path from 'node:path'
import { isWithin, realpathSafe } from './path-fence'
import { requireDataRoot } from './paths'
import { getBot, listBots } from './bots'
import { getDb, nowIso } from './store'
import { OFFICIAL_CREATOR_ID, currentCatalog } from './official-catalog'
import {
  officialPromptLines,
  pickLearnable,
  resolveByName,
  skillPromptLines,
  validateSkillDraft,
  type PromptSkillItem,
  type ResolveResult
} from './skills-core'

// 技能系统 DB 层与编排(2026-10-29 第一期):三张表的读写 + 提示词装配 + 档案页签数据。
// 纯逻辑(校验/解析/装配)在 skills-core.ts;归属铁律在这里落死:creator_bot_id 只取
// 调用者本人,技能参数里传什么都不认(拍板 §10-1「归属由存储判定,模型说了不算」)。
// 2026-11-05 二期:origin 列(official=精选推荐复制卡)+ 技能中心清单/详情/冻结/删除 +
// 官方目录名册注入与「安装即复制」
// 2026-11-08 三期:origin='imported'(岛主从外部带入的技能包,import_skill 工具落卡)+
// 随卡资产岛级存档与「安装即复制」materialize/卸下清理——居民执行能力零新增(拍板)

export interface SkillRow {
  id: number
  name: string
  description: string
  content: string
  creatorBotId: string
  /** active=在用 / frozen=岛主停用(技能中心二期给入口) / deleted=软删 */
  status: string
  version: number
  /** island=居民自建 / official=精选推荐装来的复制卡(不可 update,冻结/删除照常) /
   *  imported=岛主导入的外部技能包(哨兵创建者,居民不可 update;正文不限长) */
  origin: 'island' | 'official' | 'imported'
  createdAt: string
  updatedAt: string
}

interface SkillDbRow {
  id: number
  name: string
  description: string
  content: string
  creator_bot_id: string
  status: string
  version: number
  origin: 'island' | 'official' | 'imported'
  created_at: string
  updated_at: string
}

function fromRow(r: SkillDbRow): SkillRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    content: r.content,
    creatorBotId: r.creator_bot_id,
    status: r.status,
    version: r.version,
    origin: r.origin,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/** 活卡(未软删):名册、解析、审批预览都基于这份 */
export function listActiveSkills(): SkillRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM skills WHERE status != 'deleted' ORDER BY updated_at DESC, id DESC")
    .all() as SkillDbRow[]
  return rows.map(fromRow)
}

export function getSkill(id: number): SkillRow | null {
  const row = getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillDbRow | undefined
  return row ? fromRow(row) : null
}

/** 按名解析(精确→唯一模糊→多个列清单),只看活卡 */
export function findSkillByName(name: string): ResolveResult<SkillRow> {
  return resolveByName(listActiveSkills(), name)
}

/** 精确同名查询(落卡前的重名判定用):resolveByName 的唯一模糊命中会把「PDF处理」
 *  误判成与既有「PDF」重名;数据库精确比对才是落卡口径 */
export function findExactActiveSkillByName(name: string): SkillRow | null {
  const row = getDb()
    .prepare("SELECT * FROM skills WHERE name = ? AND status != 'deleted'")
    .get(name) as SkillDbRow | undefined
  return row ? fromRow(row) : null
}

/** 某居民已安装的技能(含已停用的卡,停用只是不注入,装卸关系仍在) */
export function installedSkills(botId: string): SkillRow[] {
  const rows = getDb()
    .prepare(
      `SELECT s.* FROM skills s JOIN skill_installs i ON i.skill_id = s.id
       WHERE i.bot_id = ? AND s.status != 'deleted'
       ORDER BY i.installed_at DESC, s.id DESC`
    )
    .all(botId) as SkillDbRow[]
  return rows.map(fromRow)
}

export function isInstalled(skillId: number, botId: string): boolean {
  return (
    getDb()
      .prepare('SELECT 1 FROM skill_installs WHERE skill_id = ? AND bot_id = ?')
      .get(skillId, botId) !== undefined
  )
}

/** 学会某门技能的居民数(更新审批卡的「改了大家都用新版」文案) */
export function skillLearnerCount(skillId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM skill_installs i JOIN skills s ON s.id = i.skill_id
       WHERE i.skill_id = ? AND s.status != 'deleted'`
    )
    .get(skillId) as { n: number }
  return row.n
}

/** 创建技能卡:落卡 + 版本快照 v1 + 自动装回创建者(创建即学会);重名靠部分唯一索引兜底 */
export function createSkill(input: {
  name: string
  description: string
  content: string
  creatorBotId: string
}): SkillRow {
  const invalid = validateSkillDraft(input)
  if (invalid) throw new Error(invalid)
  const ts = nowIso()
  const info = getDb()
    .prepare(
      `INSERT INTO skills (name, description, content, creator_bot_id, status, version, created_at, updated_at, origin)
       VALUES (?, ?, ?, ?, 'active', 1, ?, ?, 'island')`
    )
    .run(input.name, input.description, input.content, input.creatorBotId, ts, ts)
  const id = Number(info.lastInsertRowid)
  getDb()
    .prepare('INSERT INTO skill_revisions (skill_id, version, description, content, created_at) VALUES (?, 1, ?, ?, ?)')
    .run(id, input.description, input.content, ts)
  getDb()
    .prepare("INSERT OR IGNORE INTO skill_installs (skill_id, bot_id, installed_at, via) VALUES (?, ?, ?, 'creator')")
    .run(id, input.creatorBotId, ts)
  return {
    id,
    ...input,
    status: 'active',
    version: 1,
    origin: 'island',
    createdAt: ts,
    updatedAt: ts
  }
}

/** 更新(仅创建者路径已在上层硬拦):版本 +1,旧版快照留档,已安装者下回合起用新版。
 *  版本推进用条件 UPDATE 认领(单聊与群聊可并发改同一张卡):读到旧版本的第二笔在这里
 *  落空即拒绝,不会先把内容写成 v2、再在快照主键上撞错留下错位的历史 */
export function updateSkill(
  skill: SkillRow,
  patch: { description?: string; content?: string }
): SkillRow {
  const next = {
    name: skill.name,
    description: patch.description ?? skill.description,
    content: patch.content ?? skill.content
  }
  const invalid = validateSkillDraft(next)
  if (invalid) throw new Error(invalid)
  const ts = nowIso()
  const version = skill.version + 1
  const claimed = getDb()
    .prepare('UPDATE skills SET description = ?, content = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?')
    .run(next.description, next.content, version, ts, skill.id, skill.version)
  if (claimed.changes === 0) {
    throw new Error('这张技能卡刚被改过(版本已变化),本次修改没有保存;请重新核对最新内容后再改。')
  }
  getDb()
    .prepare('INSERT INTO skill_revisions (skill_id, version, description, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(skill.id, version, next.description, next.content, ts)
  return { ...skill, ...next, version, updatedAt: ts }
}

export function installSkill(
  skillId: number,
  botId: string,
  via: 'creator' | 'user' | 'resident' | 'import'
): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO skill_installs (skill_id, bot_id, installed_at, via) VALUES (?, ?, ?, ?)')
    .run(skillId, botId, nowIso(), via)
}

/** 卸下(居民工具或岛主在档案页签):只删安装关系,技能卡与版本历史都在岛上 */
export function uninstallSkill(skillId: number, botId: string): void {
  getDb().prepare('DELETE FROM skill_installs WHERE skill_id = ? AND bot_id = ?').run(skillId, botId)
}

/** 档案「技能」页签:TA 已学会的技能卡(自创徽章与来源标注);官方复制卡标「来自精选推荐」 */
export function botSkillEntries(botId: string): BotSkillEntry[] {
  const self = getBot(botId)
  if (!self) return []
  const skills = installedSkills(botId)
  const names = new Map(listBots().map((b) => [b.id, b.name]))
  return skills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    version: s.version,
    frozen: s.status === 'frozen',
    isCreator: s.creatorBotId === botId,
    creatorName: s.origin === 'official' || s.origin === 'imported' ? null : (names.get(s.creatorBotId) ?? null),
    origin: s.origin,
    updatedAt: s.updatedAt
  }))
}

/** 名册/卡片的署名行:官方复制卡显示「精选推荐装来的手艺」;导入卡显示「岛主导入的手艺」;
 *  创建者已离岛显示「已离岛居民」 */
function bylineOf(skill: SkillRow, selfId: string): string {
  if (skill.origin === 'official') return '精选推荐装来的手艺'
  if (skill.origin === 'imported') return '岛主导入的手艺'
  if (skill.creatorBotId === selfId) return '你记下的手艺'
  const name = getBot(skill.creatorBotId)?.name
  return `${name ?? '已离岛居民'} 记下的手艺`
}

/** 「你的技能」提示词节(已装的全文或名册——总量超 SKILL_INJECT_BUDGET 自动切名册,
 *  正文走 load_skill——+ 岛上名册 + 精选推荐名册):全部为空返回空数组,整节省略 */
export function skillPromptSection(botId: string): string[] {
  const self = getBot(botId)
  if (!self) return []
  const installedRows = installedSkills(botId).filter((s) => s.status === 'active')
  const active = listActiveSkills()
  const installedIds = new Set(installedRows.map((s) => s.id))
  const { list, hidden } = pickLearnable(active, installedIds)
  const toPrompt = (s: SkillRow, withContent: boolean): PromptSkillItem => ({
    name: s.name,
    byline: bylineOf(s, botId),
    description: s.description,
    version: s.version,
    ...(s.origin === 'imported' ? { imported: true } : {}),
    ...(withContent ? { content: s.content } : {})
  })
  // 精选推荐名册:目录里本岛还没复制进岛的卡(已复制的会在上面名册里自然出现)
  const catalog = currentCatalog()
  const officialNames = officialInstalledNames()
  return [
    ...skillPromptLines(
      // 导入卡(拍板 2026-11-08):正文不限长,名册常驻不进全文预算,正文一律 load_skill
      installedRows.map((s) => toPrompt(s, s.origin !== 'imported')),
      list.map((s) => toPrompt(s, false)),
      hidden
    ),
    ...officialPromptLines(
      catalog.skills.map((c) => ({ name: c.name, description: c.description })),
      officialNames,
      0
    )
  ]
}

// ── 技能中心二期(2026-11-05) ─────────────────────────────────────────────

/** 岛上已存在的官方复制卡名集合(未删):官方名册排除 + 货架「已装」标记共用 */
export function officialInstalledNames(): Set<string> {
  const rows = getDb()
    .prepare("SELECT name FROM skills WHERE origin = 'official' AND status != 'deleted'")
    .all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

/** 技能中心「岛上的技能」清单:全岛活卡(含冻结),最近更新在前;官方卡带 origin 标记 */
export function islandSkillSummaries(): IslandSkillSummary[] {
  const rows = listActiveSkills()
  const names = new Map(listBots().map((b) => [b.id, b.name]))
  const counts = new Map(
    (
      getDb()
        .prepare(
          `SELECT i.skill_id AS id, COUNT(*) AS n FROM skill_installs i
           JOIN skills s ON s.id = i.skill_id WHERE s.status != 'deleted' GROUP BY i.skill_id`
        )
        .all() as { id: number; n: number }[]
    ).map((r) => [r.id, r.n])
  )
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    version: s.version,
    origin: s.origin,
    creatorName: s.origin === 'official' || s.origin === 'imported' ? null : (names.get(s.creatorBotId) ?? null),
    frozen: s.status === 'frozen',
    learnerCount: counts.get(s.id) ?? 0,
    updatedAt: s.updatedAt
  }))
}

/** 技能中心详情(展开行):正文全文 + 不可变版本历史 + 安装名单 */
export function islandSkillDetail(id: number): IslandSkillDetail | null {
  const skill = getSkill(id)
  if (!skill || skill.status === 'deleted') return null
  const versions = (
    getDb()
      .prepare(
        'SELECT version, description, content, created_at FROM skill_revisions WHERE skill_id = ? ORDER BY version DESC'
      )
      .all(id) as { version: number; description: string; content: string; created_at: string }[]
  ).map((v) => ({
    version: v.version,
    description: v.description,
    content: v.content,
    createdAt: v.created_at
  }))
  const names = new Map(listBots().map((b) => [b.id, b.name]))
  const installers = (
    getDb()
      .prepare('SELECT bot_id, installed_at FROM skill_installs WHERE skill_id = ? ORDER BY installed_at')
      .all(id) as { bot_id: string; installed_at: string }[]
  ).map((i) => ({ botId: i.bot_id, name: names.get(i.bot_id) ?? '已离岛居民' }))
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    version: skill.version,
    origin: skill.origin,
    creatorName:
      skill.origin === 'official' || skill.origin === 'imported'
        ? null
        : (names.get(skill.creatorBotId) ?? null),
    frozen: skill.status === 'frozen',
    versions,
    installers,
    updatedAt: skill.updatedAt
  }
}

/** 冻结/解冻(岛级停用):全岛不注入、灰显、居民侧更新被拦;解冻即恢复 */
export function setSkillFrozen(skillId: number, frozen: boolean): void {
  getDb()
    .prepare("UPDATE skills SET status = ?, updated_at = ? WHERE id = ? AND status != 'deleted'")
    .run(frozen ? 'frozen' : 'active', nowIso(), skillId)
}

/** 删除(软删+全岛卸下):自建与官方复制卡同权——官方卡删的是本岛复制件,云端目录不受影响 */
export function deleteIslandSkill(skillId: number): void {
  const skill = getSkill(skillId)
  // 导入卡先清各学习居民工作区里的随卡副本再删安装关系——删完居民侧就再也找不到这张卡,
  // 副本会变孤儿;失败只记日志不拦删除(与资产档清理同口径)
  if (skill?.origin === 'imported') {
    const learners = getDb().prepare('SELECT bot_id FROM skill_installs WHERE skill_id = ?').all(skillId) as {
      bot_id: string
    }[]
    for (const row of learners) {
      const bot = getBot(row.bot_id)
      if (bot?.workspacePath) removeMaterializedImportedAssets(skillId, skill.name, bot.workspacePath)
    }
  }
  getDb()
    .prepare("UPDATE skills SET status = 'deleted', updated_at = ? WHERE id = ? AND status != 'deleted'")
    .run(nowIso(), skillId)
  getDb().prepare('DELETE FROM skill_installs WHERE skill_id = ?').run(skillId)
  // 导入卡随卡清资产档;失败只记日志不拦删除
  try {
    fs.rmSync(skillArchiveDir(skillId), { recursive: true, force: true })
  } catch (err) {
    console.error('[skills] 清理导入资产档失败:', skillId, err)
  }
}

/** 精选推荐「安装即复制」(需求 §3):把目录卡复制进本岛 skills 表(origin=official,
 *  creator=OFFICIAL_CREATOR_ID),不自动装给任何居民——居民经「安装到…」或 install_skill 学。
 *  重名(岛上已有同名活卡,含此前复制过又没删净的)抛人话错误;成功返回新卡 id */
export function installOfficialCopy(card: OfficialSkillCard): number {
  const dup = getDb()
    .prepare("SELECT 1 FROM skills WHERE name = ? AND status != 'deleted'")
    .get(card.name)
  if (dup) {
    throw new Error(`岛上已有叫「${card.name}」的技能。若是精选推荐装来的旧复制,先在「岛上的技能」里删除它再重新装。`)
  }
  const invalid = validateSkillDraft({
    name: card.name,
    description: card.description,
    content: card.detail
  })
  if (invalid) throw new Error(`官方目录的「${card.name}」数据不合规:${invalid}`)
  const ts = nowIso()
  const info = getDb()
    .prepare(
      `INSERT INTO skills (name, description, content, creator_bot_id, status, version, created_at, updated_at, origin)
       VALUES (?, ?, ?, ?, 'active', 1, ?, ?, 'official')`
    )
    .run(card.name, card.description, card.detail, OFFICIAL_CREATOR_ID, ts, ts)
  const id = Number(info.lastInsertRowid)
  getDb()
    .prepare('INSERT INTO skill_revisions (skill_id, version, description, content, created_at) VALUES (?, 1, ?, ?, ?)')
    .run(id, card.description, card.detail, ts)
  return id
}

// ── 技能导入三期(2026-11-08,import_skill 工具配套) ─────────────────────────

/** 导入卡的哨兵创建者(居民表里没有这个 id;名册/档案页签据此显示「岛主导入」,
 *  update_skill 的「只有创建者能改」对导入卡天然全拦) */
export const IMPORTED_CREATOR_ID = 'owner'

/** 岛级资产档根(账号数据目录内,不进居民工作区):skill-assets/<skillId>/ 原样存档。
 *  导入时的来源文件可能消失(收件箱清空/附件临时目录),档是后续 materialize 的唯一事实源 */
function skillArchiveDir(skillId: number): string {
  return path.join(requireDataRoot(), 'skill-assets', String(skillId))
}

/** 导入落卡:origin='imported' + 哨兵创建者 + v1 快照;校验走导入口径(64/500/正文不限长)。
 *  不自动安装——调用方(tools.ts)按需 install + materialize,与审批时序解耦。
 *  卡与 v1 快照两条 INSERT 包同一事务:后半失败不留「有卡没快照」的半截卡 */
export function createImportedSkill(input: {
  name: string
  description: string
  content: string
}): SkillRow {
  const invalid = validateImportedSkillDraft(input)
  if (invalid) throw new Error(invalid)
  const ts = nowIso()
  const db = getDb()
  const id = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO skills (name, description, content, creator_bot_id, status, version, created_at, updated_at, origin)
         VALUES (?, ?, ?, ?, 'active', 1, ?, ?, 'imported')`
      )
      .run(input.name, input.description, input.content, IMPORTED_CREATOR_ID, ts, ts)
    const newId = Number(info.lastInsertRowid)
    db.prepare(
      'INSERT INTO skill_revisions (skill_id, version, description, content, created_at) VALUES (?, 1, ?, ?, ?)'
    ).run(newId, input.description, input.content, ts)
    return newId
  })()
  return {
    id,
    ...input,
    creatorBotId: IMPORTED_CREATOR_ID,
    status: 'active',
    version: 1,
    origin: 'imported',
    createdAt: ts,
    updatedAt: ts
  }
}

/** 随卡资产入岛档:按扫描出的 rel 清单原样复制(剥离执行位——资产永远是「被解释器打开的
 *  文本」,不是可直接运行的程序)。失败抛给人话错误,调用方据此撤卡。
 *  扫描(审批前)与归档(审批后)之间来源可能被动过(TOCTOU):逐文件复核——真实路径必须
 *  还在来源根内、必须仍是常规文件(链接逐条拒)、尺寸仍在上限内;清单之外一份也不多收 */
export function archiveImportedAssets(skillId: number, sourceRoot: string, files: ScannedAssetFile[]): void {
  if (files.length === 0) return
  const archive = skillArchiveDir(skillId)
  const rootReal = realpathSafe(sourceRoot)
  try {
    let totalBytes = 0
    for (const f of files) {
      const from = path.join(sourceRoot, ...f.rel.split('/'))
      const real = realpathSafe(from)
      if (!isWithin(rootReal, real)) throw new Error(`「${f.rel}」已不在来源包里(被移走或换成了链接)`)
      const st = fs.lstatSync(real)
      if (!st.isFile()) throw new Error(`「${f.rel}」已不是常规文件(可能被换成了链接),导入中止`)
      if (st.size > IMPORT_ASSET_MAX_FILE_BYTES) throw new Error(`「${f.rel}」已超出单件上限,导入中止`)
      totalBytes += st.size
      if (totalBytes > IMPORT_ASSET_MAX_TOTAL_BYTES) throw new Error('随卡文件合计已超出总量上限,导入中止')
      const to = path.join(archive, ...f.rel.split('/'))
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(real, to)
      fs.chmodSync(to, 0o644)
    }
  } catch (err) {
    try {
      fs.rmSync(archive, { recursive: true, force: true })
    } catch {
      /* 清场失败无碍,下次导入覆盖 */
    }
    throw new Error(`随卡文件入岛失败(${err instanceof Error ? err.message : String(err)}),本次导入没有保存。`, {
      cause: err
    })
  }
}

/** 随卡落位目录的归属标记:岛档 skill-assets 没有工作区视角,同名安全目录(不同卡重名清洗
 *  同名/居民自建目录)靠这个文件判定「这目录是不是这张卡的」;materialize 写、卸下/重装核对 */
const SKILL_MARKER_NAME = '.archipelago-skill-id'

function readSkillMarker(target: string): string | null {
  try {
    return fs.readFileSync(path.join(target, SKILL_MARKER_NAME), 'utf8').trim()
  } catch {
    return null
  }
}

/** 安装即复制:把岛档里的随卡文件 materialize 到居民工作区「技能/<安全名>/」,
 *  布局与卡正文清单一致(相对路径原样可用)。返回落位根(无资产返回 null)。
 *  围栏校验:目标必须是「技能/」下一层的严格子目录,且链路上不得有符号链接(工作区里若有
 *  指向外部的链接,复制会沿链接写出工作区);目标已存在则核对归属标记,别卡的/居民自建的
 *  目录拒绝合并,防止后装覆盖前卡、卸一卡误删另一卡 */
export function materializeImportedAssets(skillId: number, skillName: string, workspacePath: string): string | null {
  const archive = skillArchiveDir(skillId)
  if (!fs.existsSync(archive) || fs.readdirSync(archive).length === 0) return null
  const skillsRoot = path.join(workspacePath, '技能')
  const target = path.join(skillsRoot, sanitizeSkillDirName(skillName))
  if (!isWithin(workspacePath, target) || target === workspacePath || target === skillsRoot)
    throw new Error('随卡文件落位越出了居民工作区,已拦下。')
  for (const p of [skillsRoot, target]) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink())
      throw new Error(`落位路径上有符号链接(${p}),为不写出工作区已拦下;请先清理该链接。`)
  }
  const existing = fs.existsSync(target)
  if (existing && readSkillMarker(target) !== String(skillId)) {
    throw new Error(
      `工作区里已有「技能/${sanitizeSkillDirName(skillName)}/」且不是这张卡的随卡目录,已拦下(不合并覆盖);请换个技能名重导,或先清理那个目录。`
    )
  }
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, SKILL_MARKER_NAME), String(skillId))
  const copyAll = (src: string, dest: string): void => {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name)
      const d = path.join(dest, entry.name)
      // 目标位若是符号链接一律先拆再写,绝不沿链接写出去(岛档是自建的,src 侧链接本就不存在)
      if (fs.lstatSync(d, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(d)
      if (entry.isDirectory()) {
        fs.mkdirSync(d, { recursive: true })
        copyAll(s, d)
      } else if (entry.isFile()) {
        fs.copyFileSync(s, d)
        fs.chmodSync(d, 0o644)
      }
    }
  }
  copyAll(archive, target)
  return target
}

/** 卸下清理:删该居民工作区里的随卡副本(只删核对过归属标记的「技能/<安全名>/」,
 *  绝不碰工作区其他文件)。返回是否真删了 */
export function removeMaterializedImportedAssets(skillId: number, skillName: string, workspacePath: string): boolean {
  const skillsRoot = path.join(workspacePath, '技能')
  const target = path.join(skillsRoot, sanitizeSkillDirName(skillName))
  if (!isWithin(workspacePath, target) || target === workspacePath || target === skillsRoot) return false
  if (!fs.existsSync(target) || readSkillMarker(target) !== String(skillId)) return false
  try {
    fs.rmSync(target, { recursive: true, force: true })
    return true
  } catch (err) {
    console.error('[skills] 清理随卡文件副本失败:', target, err)
    return false
  }
}

/** 岛主侧「安装到…」与居民 install_skill 共用的安装收口:导入卡先落随卡文件再写安装关系
 *  (落位失败=安装关系没写,重试干净;已装幂等跳过)。返回落位根(无资产/非导入卡 null) */
export function installSkillWithAssets(skillId: number, botId: string, via: 'resident' | 'user'): string | null {
  const skill = getSkill(skillId)
  if (!skill) throw new Error('这张技能卡已经不在岛上了,刷新一下再看。')
  const bot = getBot(botId)
  if (skill.origin === 'imported' && bot?.workspacePath)
    return materializeThenInstall(skillId, botId, via, skill.name, bot.workspacePath)
  installSkill(skillId, botId, via)
  return null
}

function materializeThenInstall(
  skillId: number,
  botId: string,
  via: 'resident' | 'user',
  skillName: string,
  workspacePath: string
): string | null {
  const placed = materializeImportedAssets(skillId, skillName, workspacePath)
  installSkill(skillId, botId, via)
  return placed
}
