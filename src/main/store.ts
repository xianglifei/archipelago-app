import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { MAIN_BOT_APPEARANCE, appearanceFromId } from '@shared/avatar'
import { MAIN_BOT_ARCHETYPE } from '@shared/archetypes'
import { requireDataRoot } from './paths'
import { SKILLS_DDL } from './skills-core'
import { TASKS_DDL } from './tasks'
import { TASK_THREADS_DDL, migrateTaskThreadsWorkdirColumns } from './task-threads'
import { POST_DDL } from '@shared/post-core'
import { MCP_DDL } from './mcp-core'

// M12:全部状态进 SQLite,原子写、崩溃可恢复(WAL)
let db: Database.Database | null = null

/** 0.9 群岛通道切换的一次性迁移闸(2026-11-13 BYOK):见 migrate() 内注释 */
const RELAY_SWITCH_MIGRATION_FLAG = 'migration.0_9.relay_switch'

export function getDb(): Database.Database {
  if (db) return db
  const dir = requireDataRoot()
  fs.mkdirSync(dir, { recursive: true })
  db = new Database(path.join(dir, 'archipelago.db'))
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}

/** 登出/切换账号时关闭连接并清缓存;进行中的写入由各调用方的 catch 兜底 */
export function closeDb(): void {
  if (db) {
    try {
      db.close()
    } catch {
      // 已关闭或繁忙,忽略
    }
    db = null
  }
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      persona TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      is_main INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'dm',
      summary TEXT,
      cutoff_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      reasoning TEXT,
      created_at TEXT NOT NULL,
      exchange_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

    CREATE TABLE IF NOT EXISTS context_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      announcement TEXT NOT NULL DEFAULT '',
      admin_bot_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (group_id, bot_id)
    );

    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      bot_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id, id);

    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)

  // 技能系统三张表(2026-10-29 第一期,M7 能力库第一块):整表新增,幂等 CREATE,
  // 存量库首启补建零风险;DDL 单点在 skills-core.ts(冒烟同源验证)
  database.exec(SKILLS_DDL)

  // MCP 连接器两表(2026-11-06):connectors(岛级连接器)+connector_installs(分配到居民),
  // 整表新增幂等 CREATE;DDL 单点在 mcp-core.ts(单测同源验证)
  database.exec(MCP_DDL)

  // 技能二期(2026-11-05)增量列:skills.origin——official=精选推荐装来的复制卡
  // (「安装即复制」,与云端目录再无耦合);与 messages 列族同款 pragma 守卫增量迁移
  {
    const skillColumns = database.prepare('PRAGMA table_info(skills)').all() as { name: string }[]
    if (!skillColumns.some((c) => c.name === 'origin')) {
      database.exec("ALTER TABLE skills ADD COLUMN origin TEXT NOT NULL DEFAULT 'island'")
    }
  }

  // 定时任务两表(2026-10-29):tasks(任务清单)+task_runs(触发历史),整表新增幂等 CREATE;
  // DDL 单点在 tasks.ts(冒烟同源验证)
  database.exec(TASKS_DDL)

  // 任务会话(2026-11-06「新建任务」):task_threads 整表新增幂等 CREATE;
  // DDL 单点在 task-threads.ts(单测同源验证);消息落在 sessions/messages 既有表(见下 ref 列)
  database.exec(TASK_THREADS_DDL)
  // 任务会话工作目录绑定列族(2026-11-10 第一批):存量库守卫式补列,单点在 task-threads.ts
  migrateTaskThreadsWorkdirColumns(database)

  // 增量迁移:sessions.ref——任务会话行的线程指向(kind='task' 时 ref=task_threads.id);
  // 旧库补列全 NULL=普通会话,存量零改动(与 messages 列族同款 pragma 守卫增量迁移)
  const sessionColumns = database.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
  if (!sessionColumns.some((c) => c.name === 'ref')) {
    database.exec('ALTER TABLE sessions ADD COLUMN ref TEXT')
  }

  // 邮局两表(2026-10-29):post_letters(收发信件流,历史全在本地)+post_contacts(通讯录本地镜像);
  // 整表新增幂等 CREATE;DDL 单点在 post-core.ts(冒烟同源验证)
  database.exec(POST_DDL)

  // FTS5 全文索引(M3.3 read_own_chat 的底座),外部内容表 + 触发器保持同步
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `)
  const ftsReady = database.prepare("SELECT value FROM meta WHERE key = 'fts.rebuilt'").get()
  if (!ftsReady) {
    database.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')")
    database
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts.rebuilt', '1')")
      .run()
  }

  // 增量迁移:messages.hidden(Bot 间私信,2026-10)
  const columns = database.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
  if (!columns.some((c) => c.name === 'hidden')) {
    database.exec('ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  }
  // 增量迁移:消息类型(chat=普通对话 / relation=居民私信事件行,DS Bot 式内联展示,2026-10)
  if (!columns.some((c) => c.name === 'kind')) {
    database.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'")
  }
  if (!columns.some((c) => c.name === 'meta')) {
    database.exec('ALTER TABLE messages ADD COLUMN meta TEXT')
  }
  // 增量迁移:私信交流 ID(2026-10-22,一次 send_message 的 4 行 relation 消息共用,
  // 界面按它折叠成单气泡 + 详情浮窗);旧 relation 行无此列为 legacy 展示。
  // 索引必须放在列确保存在之后建——旧库建表块会跳过 CREATE TABLE,此时列尚不存在
  if (!columns.some((c) => c.name === 'exchange_id')) {
    database.exec('ALTER TABLE messages ADD COLUMN exchange_id TEXT')
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_messages_exchange ON messages(exchange_id)')
  // 增量迁移:回合 id(回合折叠方案 C,2026-10-27)。一次「用户消息→过程行→最终回复」的全部行共享;
  // 界面按回合把过程折叠为「已工作 N 秒」签;旧消息无此列,渲染层按位置推导兜底,不回填
  if (!columns.some((c) => c.name === 'turn_id')) {
    database.exec('ALTER TABLE messages ADD COLUMN turn_id TEXT')
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn_id)')
  // 增量迁移:消息附件(2026-10-29 输入框升级)——岛主随消息发的文件/文件夹/图片引用,
  // JSON 数组(MessageAttachment[]);仅用户消息使用,旧消息 NULL=无附件
  if (!columns.some((c) => c.name === 'attachments')) {
    database.exec('ALTER TABLE messages ADD COLUMN attachments TEXT')
  }
  const groupMessageColumns = database.prepare('PRAGMA table_info(group_messages)').all() as { name: string }[]
  if (!groupMessageColumns.some((c) => c.name === 'attachments')) {
    database.exec('ALTER TABLE group_messages ADD COLUMN attachments TEXT')
  }
  // 增量迁移:群消息选区引用(2026-11-02)——用户消息携带的引用落 meta(QuoteMeta JSON);
  // 与 messages 表的 meta 列同构,旧消息 NULL=无引用
  if (!groupMessageColumns.some((c) => c.name === 'meta')) {
    database.exec('ALTER TABLE group_messages ADD COLUMN meta TEXT')
  }

  // 增量迁移:bots 权限档位与工作区路径(M4.1,2026-10);旧记录 permission 取默认 workspace,
  // workspace_path 留空由 fromRow 兜底计算,不回填
  const botColumns = database.prepare('PRAGMA table_info(bots)').all() as { name: string }[]
  if (!botColumns.some((c) => c.name === 'permission')) {
    database.exec("ALTER TABLE bots ADD COLUMN permission TEXT NOT NULL DEFAULT 'workspace'")
  }
  if (!botColumns.some((c) => c.name === 'workspace_path')) {
    database.exec('ALTER TABLE bots ADD COLUMN workspace_path TEXT')
  }

  // 增量迁移:群聊上下文检查点(A1,2026-10-28)——groups 表加每群一份的摘要与截断点;
  // 早期群聊压缩成摘要注入转写,不再受 120 条裸窗口整体蒸发。新列放增量段(红线:
  // 初始建表块只会建出旧形态,存量库靠这里的 ALTER 补列)
  const groupColumns = database.prepare('PRAGMA table_info(groups)').all() as { name: string }[]
  if (!groupColumns.some((c) => c.name === 'summary')) {
    database.exec('ALTER TABLE groups ADD COLUMN summary TEXT')
  }
  if (!groupColumns.some((c) => c.name === 'cutoff_id')) {
    database.exec('ALTER TABLE groups ADD COLUMN cutoff_id INTEGER')
  }

  // 增量迁移:居民外观(0.7 头像系统,JSON 字符串)。存量回填一次并落库固化:
  // Momo=章鱼A/星芒高光(设计稿钦定),其余按 id 稳定哈希取值,避免每次启动变脸
  if (!botColumns.some((c) => c.name === 'appearance')) {
    database.exec('ALTER TABLE bots ADD COLUMN appearance TEXT')
    const rows = database
      .prepare('SELECT id, is_main FROM bots WHERE deleted_at IS NULL AND appearance IS NULL')
      .all() as { id: string; is_main: number }[]
    const update = database.prepare('UPDATE bots SET appearance = ? WHERE id = ?')
    for (const row of rows) {
      const appearance = row.is_main === 1 ? MAIN_BOT_APPEARANCE : appearanceFromId(row.id)
      update.run(JSON.stringify(appearance), row.id)
    }
  }

  // 增量迁移:居民性格原型(0.8 性格系统)。存量回填一次并落库固化:
  // 主 Bot=小太阳(sunshine,2026-10-26 审阅会:取消岛务长专属、替换傲娇槽位),
  // 其余按 id 稳定哈希分配温暖系(元气/温柔/悠闲),之后岛主可在居民档案里随时改
  if (!botColumns.some((c) => c.name === 'archetype')) {
    database.exec("ALTER TABLE bots ADD COLUMN archetype TEXT NOT NULL DEFAULT ''")
    const rows = database
      .prepare('SELECT id, is_main FROM bots WHERE deleted_at IS NULL')
      .all() as { id: string; is_main: number }[]
    const update = database.prepare('UPDATE bots SET archetype = ? WHERE id = ?')
    const warmPool = ['genki', 'gentle', 'chill']
    for (const row of rows) {
      const archetype =
        row.is_main === 1
          ? MAIN_BOT_ARCHETYPE
          : warmPool[row.id.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % warmPool.length]
      update.run(archetype, row.id)
    }
  }
  // 增量迁移:性格体系调整(2026-10-26 审阅会)——旧 steward(元气知性)统一归位小太阳,
  // 旧 tsundere(傲娇,已删除)归位温柔(说话不带刺的最接近档);幂等可重复跑
  database.prepare(`UPDATE bots SET archetype = '${MAIN_BOT_ARCHETYPE}' WHERE archetype = 'steward'`).run()
  database.prepare("UPDATE bots SET archetype = 'gentle' WHERE archetype = 'tsundere'").run()

  // 增量迁移:主 Bot 角色标签收敛为「岛务长」(2026-10,去掉「· 调度者」后缀)
  database
    .prepare("UPDATE bots SET role = '岛务长' WHERE role = '岛务长 · 调度者'")
    .run()

  // 增量迁移:DeepSeek 模型更名(2026-10,官方已从 chat/reasoner 切换到 flash/v4-pro)
  database.prepare("UPDATE bots SET model_id = 'deepseek-flash' WHERE model_id = 'deepseek-chat'").run()
  database.prepare("UPDATE bots SET model_id = 'deepseek-v4-pro' WHERE model_id = 'deepseek-reasoner'").run()
  // 增量迁移:0.9 群岛通道切换——全体居民迁到 archipelago 通道;智谱模型映射到 快速 档
  // (人设与记忆延续,行为差异由居民自身承载)。
  // 2026-11-13 BYOK 起加一次性闸:此前这段每次开机无条件执行,用户设好自带 Key 重启就被写回群岛通道,
  // 功能等于不存在。跑过一次即落 meta 标记,之后不再跑。**新增迁移只能追加在闸外并保持幂等**,
  // 想复用这段的清理语义请另起一条带自己闸的迁移。
  if (!database.prepare('SELECT 1 FROM meta WHERE key = ?').get(RELAY_SWITCH_MIGRATION_FLAG)) {
    database.prepare("UPDATE bots SET provider_id = 'archipelago' WHERE provider_id IN ('zhipu','deepseek')").run()
    database.prepare("UPDATE bots SET model_id = 'deepseek-flash' WHERE model_id IN ('glm-5.3','glm-5.3-flash')").run()
    const modelDefault = database.prepare("SELECT value FROM meta WHERE key = 'model.default'").get() as
      | { value: string }
      | undefined
    if (modelDefault) {
      try {
        const parsed = JSON.parse(modelDefault.value) as { providerId?: string; modelId?: string }
        if (parsed.modelId === 'deepseek-chat') parsed.modelId = 'deepseek-flash'
        if (parsed.modelId === 'deepseek-reasoner') parsed.modelId = 'deepseek-v4-pro'
        if (parsed.modelId === 'glm-5.3' || parsed.modelId === 'glm-5.3-flash') parsed.modelId = 'deepseek-flash'
        if (parsed.providerId === 'zhipu' || parsed.providerId === 'deepseek') parsed.providerId = 'archipelago'
        database
          .prepare("UPDATE meta SET value = ? WHERE key = 'model.default'")
          .run(JSON.stringify(parsed))
      } catch {
        // 解析失败保持原值
      }
    }
    database
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(RELAY_SWITCH_MIGRATION_FLAG, JSON.stringify('done'))
  }
}

export function metaGet<T>(key: string): T | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value) as T
  } catch {
    return null
  }
}

export function metaSet(key: string, value: unknown): void {
  getDb()
    .prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, JSON.stringify(value))
}

export function nowIso(): string {
  return new Date().toISOString()
}
