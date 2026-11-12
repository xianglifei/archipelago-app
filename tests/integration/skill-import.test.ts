// 技能导入回归(2026-11-08 import_skill,四拍板全按推荐):
// 来源锁死(附件/技能收件箱两类,磁盘其他路径拒)、主进程确定性解析(模型不经手正文)、
// 正文原样不压缩(可超 10000 字)、随卡资产安装即复制到工作区(卸下清理)。
// 分档审批:全自动留痕放行 / 半自动无窗 fail-closed 拒绝。内存 SQLite 直调 executeTool
// (mock 集同 task-threads.test.ts,不走 runTurn)。
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SKILLS_DDL } from '../../src/main/skills-core'
import type { Bot, MessageAttachment } from '../../src/shared/types'

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  root: '',
  bot: null as Bot | null,
  windows: [] as Array<{ isFocused: () => boolean; webContents: { send: () => void } }>
}))

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: vi.fn(() => state.root) },
  BrowserWindow: { getAllWindows: () => state.windows },
  Notification: class {},
  net: {},
  powerMonitor: { on: vi.fn() },
  dialog: {}
}))
vi.mock('../../src/main/store', () => ({
  getDb: () => state.db,
  closeDb: () => undefined,
  metaGet: () => null,
  metaSet: () => undefined,
  nowIso: () => new Date().toISOString()
}))
vi.mock('../../src/main/bots', () => ({
  getBot: (id: string) => (state.bot?.id === id ? state.bot : null),
  listBots: () => (state.bot ? [state.bot] : []),
  createBot: vi.fn(),
  updateBot: vi.fn()
}))
vi.mock('../../src/main/audit', () => ({ audit: vi.fn() }))

import { executeTool } from '../../src/main/tools'
import { archiveImportedAssets, deleteIslandSkill, skillPromptSection } from '../../src/main/skills'
import { audit } from '../../src/main/audit'
import { scanSourceTree } from '../../src/shared/skill-import-core'
import { setDataRoot } from '../../src/main/paths'
import { setVisibleWorkspaceRootForTests } from '../../src/main/workspace'

function makeCaller(permission: 'semi' | 'auto', workspace: string): Bot {
  return {
    id: 'b1',
    name: '小艾',
    role: '',
    persona: '',
    archetype: '',
    providerId: '',
    modelId: '',
    isMain: false,
    color: '#3366ff',
    appearance: null,
    permission,
    workspacePath: workspace,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

const depsBase = { depth: 0, startReply: () => undefined } as const

async function runImport(caller: Bot, args: Record<string, unknown>, sessionId?: string): Promise<string> {
  return executeTool(caller, 'import_skill', args, { ...depsBase, sessionId })
}

function makeSkillFolder(dir: string, opts?: { withSkillMd?: boolean; bodyPad?: number }): string {
  const root = path.join(dir, '飞书技能')
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  const pad = opts?.bodyPad ?? 0
  if (opts?.withSkillMd !== false) {
    fs.writeFileSync(
      path.join(root, 'SKILL.md'),
      `---\nname: 飞书群管\ndescription: 用命令行管飞书群与日程\n---\n\n第一步:跑 scripts/run.sh。\nBODY_MARKER_XYZ\n${'很'.repeat(pad)}`
    )
  }
  fs.writeFileSync(path.join(root, 'scripts', 'run.sh'), 'echo hi')
  return root
}

const cleanupRoots: string[] = []
function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-it-'))
  cleanupRoots.push(root)
  return root
}

function resetDb(): void {
  const db = new Database(':memory:')
  db.exec(SKILLS_DDL)
  // origin 列是 1.2.5 二期迁移加的(ALTER TABLE),测试建库直接带上
  db.exec("ALTER TABLE skills ADD COLUMN origin TEXT NOT NULL DEFAULT 'island'")
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'dm', ref TEXT,
    summary TEXT, cutoff_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
  `)
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, reasoning TEXT, created_at TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
    kind TEXT, meta TEXT, exchange_id TEXT, turn_id TEXT, attachments TEXT)
  `)
  state.db = db
}

beforeEach(() => {
  resetDb()
  state.windows = []
  const root = freshRoot()
  state.root = root
  setDataRoot(path.join(root, 'data'))
  setVisibleWorkspaceRootForTests(path.join(root, '群岛'))
  state.bot = makeCaller('auto', path.join(root, '群岛', '小艾-abc123'))
})

afterAll(() => {
  for (const root of cleanupRoots) fs.rmSync(root, { recursive: true, force: true })
})

describe('import_skill 链路', () => {
  it('收件箱目录导入(全自动档):落卡+学会+入岛档+工作区副本,执行位剥离,噪音目录不入岛', async () => {
    const root = state.root
    const src = path.join(root, '群岛', '技能收件箱', '飞书技能')
    makeSkillFolder(path.dirname(src))
    fs.mkdirSync(path.join(src, '.git'), { recursive: true })
    fs.writeFileSync(path.join(src, '.git', 'HEAD'), 'ref: main')
    fs.writeFileSync(path.join(src, '大文件.bin'), Buffer.alloc(600 * 1024, 1))

    const out = await runImport(state.bot!, { path: src })
    expect(out).toContain('已导入技能「飞书群管」')
    expect(out).toContain('技能/飞书群管/')

    const row = state.db!.prepare(`SELECT * FROM skills WHERE name = '飞书群管'`).get() as {
      id: number
      origin: string
      creator_bot_id: string
      content: string
    }
    expect(row.origin).toBe('imported')
    expect(row.creator_bot_id).toBe('owner')
    // 正文原样不压缩(拍板):正文体 + 清单段,BODY_MARKER 原样在卡里
    expect(row.content).toContain('BODY_MARKER_XYZ')
    expect(row.content).toContain('· scripts/run.sh')
    expect(row.content).toContain('· .git(未带入')
    expect(row.content).toContain('· 大文件.bin(未带入')

    const install = state.db!
      .prepare(`SELECT via FROM skill_installs WHERE skill_id = ? AND bot_id = 'b1'`)
      .get(row.id) as { via: string }
    expect(install.via).toBe('import')

    // 岛档与工作区副本都在,执行位剥离(0o644)
    const archived = path.join(root, 'data', 'skill-assets', String(row.id), 'scripts', 'run.sh')
    expect(fs.existsSync(archived)).toBe(true)
    const placed = path.join(root, '群岛', '小艾-abc123', '技能', '飞书群管', 'scripts', 'run.sh')
    expect(fs.existsSync(placed)).toBe(true)
    expect((fs.statSync(placed).mode & 0o111) === 0).toBe(true)
    expect(fs.existsSync(path.join(placed, '..', '..', '大文件.bin'))).toBe(false)
    // 审计留痕带来源(codex 评审 #15 回归):全自动档放行也要能事后追溯是哪类来源
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      'b1',
      'import_skill',
      expect.objectContaining({ origin: 'imported', from: '技能收件箱' })
    )
  })

  it('正文超 10000 字原样保留(拍板:导入卡不受居民卡上限约束)', async () => {
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'), { bodyPad: 12000 })
    await runImport(state.bot!, { path: src })
    const row = state.db!.prepare(`SELECT content FROM skills WHERE name = '飞书群管'`).get() as {
      content: string
    }
    expect(row.content.length).toBeGreaterThan(12000)
    expect(row.content).toContain('BODY_MARKER_XYZ')
  })

  it('附件来源(当前会话岛主消息携带):收下', async () => {
    const src = makeSkillFolder(path.join(state.root, 'Downloads'))
    const att: MessageAttachment[] = [{ kind: 'dir', path: src, name: '飞书技能' }]
    state.db!
      .prepare(
        `INSERT INTO messages (session_id, role, content, reasoning, created_at, hidden, kind, meta, exchange_id, turn_id, attachments)
         VALUES ('s1', 'user', '这是技能', NULL, ?, 0, 'chat', NULL, NULL, NULL, ?)`
      )
      .run(new Date().toISOString(), JSON.stringify(att))
    const out = await runImport(state.bot!, { path: src }, 's1')
    expect(out).toContain('已导入技能')
  })

  it('来源锁死(铁律①):磁盘任意路径拒收,指路两个合法入口', async () => {
    const src = makeSkillFolder(path.join(state.root, 'random-place'))
    const out = await runImport(state.bot!, { path: src })
    expect(out).toContain('不是岛主提供的技能来源')
    expect(out).toContain('技能收件箱')
    const count = state.db!.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('目录缺 SKILL.md:诚实报错不落卡', async () => {
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'), { withSkillMd: false })
    const out = await runImport(state.bot!, { path: src })
    expect(out).toContain('SKILL.md')
    const count = state.db!.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('重名:审批之前就拦下', async () => {
    const src1 = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'))
    await runImport(state.bot!, { path: src1 })
    const other = path.join(state.root, '群岛', '技能收件箱', '另一份')
    fs.cpSync(src1, other, { recursive: true })
    const out = await runImport(state.bot!, { path: other })
    expect(out).toContain('已经有叫「飞书群管」')
    const count = state.db!.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('半自动档无窗口:fail-closed 拒绝,不落卡', async () => {
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'))
    state.bot = makeCaller('semi', state.bot!.workspacePath)
    const out = await runImport(state.bot!, { path: src })
    expect(out).toContain('岛主没有同意')
    const count = state.db!.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('卸下导入卡:工作区随卡副本清掉,卡与岛档保留', async () => {
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'))
    await runImport(state.bot!, { path: src })
    const placed = path.join(state.root, '群岛', '小艾-abc123', '技能', '飞书群管')
    expect(fs.existsSync(placed)).toBe(true)
    const out = await executeTool(state.bot!, 'uninstall_skill', { skill: '飞书群管' }, depsBase)
    expect(out).toContain('随卡文件副本也清掉了')
    expect(fs.existsSync(placed)).toBe(false)
    const row = state.db!.prepare(`SELECT status FROM skills WHERE name = '飞书群管'`).get() as {
      status: string
    }
    expect(row.status).toBe('active')
  })

  it('update_skill 对导入卡诚实拦截(哨兵创建者不掉「已离岛居民」口径)', async () => {
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'))
    await runImport(state.bot!, { path: src })
    const out = await executeTool(
      state.bot!,
      'update_skill',
      { skill: '飞书群管', content: '改成我的版本' },
      depsBase
    )
    expect(out).toContain('岛主导入')
    expect(out).toContain('删掉后重新导入')
  })

  it('提示词装配:导入卡名册常驻(拍板①),正文不注入、走 load_skill', async () => {
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'), { bodyPad: 12000 })
    await runImport(state.bot!, { path: src })
    const lines = skillPromptSection('b1').join('\n')
    expect(lines).toContain('岛主导入的手艺')
    expect(lines).toContain('load_skill')
    expect(lines).not.toContain('BODY_MARKER_XYZ')
  })
})

// ── codex 评审(2026-11-09)修复批回归 ────────────────────────────────────────

describe('import_skill 评审修复回归', () => {
  it('技能名为 "..":落位与清理都锁在「技能/skill/」里,工作区根安然无恙', async () => {
    const src = path.join(state.root, '群岛', '技能收件箱', 'dotdot')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: ".."\ndescription: 危险名\n---\n正文')
    const out = await runImport(state.bot!, { path: src })
    expect(out).toContain('已导入技能')
    const ws = state.bot!.workspacePath!
    expect(fs.existsSync(path.join(ws, '技能', 'skill', 'SKILL.md'))).toBe(true)
    await executeTool(state.bot!, 'uninstall_skill', { skill: '..' }, depsBase)
    expect(fs.existsSync(path.join(ws, '技能', 'skill'))).toBe(false)
    expect(fs.existsSync(ws)).toBe(true)
    expect(fs.existsSync(path.join(ws, '技能'))).toBe(true)
  })

  it('目录包只有 frontmatter 没正文:拼清单之前就拦下,不溜成一张纯清单卡', async () => {
    const src = path.join(state.root, '群岛', '技能收件箱', 'empty-body')
    fs.mkdirSync(path.join(src, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: 空正文\ndescription: d\n---\n')
    fs.writeFileSync(path.join(src, 'scripts', 'a.sh'), 'echo hi')
    const out = await runImport(state.bot!, { path: src })
    expect(out).toContain('正文不能为空')
    const count = state.db!.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('归档复核:审批窗口内文件被换成符号链接 → 拒收并清场,不留半截岛档', async () => {
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'))
    const scan = scanSourceTree(src)
    expect(scan.breach).toBeNull()
    // 模拟审批等待期间被动过:run.sh 换成指向包外的符号链接
    const outside = path.join(state.root, 'outside-secret.txt')
    fs.writeFileSync(outside, 'secret')
    fs.rmSync(path.join(src, 'scripts', 'run.sh'))
    fs.symlinkSync(outside, path.join(src, 'scripts', 'run.sh'))
    expect(() => archiveImportedAssets(4242, src, scan.files)).toThrow('链接')
    expect(fs.existsSync(path.join(state.root, 'data', 'skill-assets', '4242'))).toBe(false)
    expect(fs.readlinkSync(path.join(src, 'scripts', 'run.sh'))).toBe(outside)
  })

  it('归档复核:审批窗口内文件被删 → 诚实报错(caller 侧会撤卡)', async () => {
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'))
    const scan = scanSourceTree(src)
    fs.rmSync(path.join(src, 'scripts', 'run.sh'))
    expect(() => archiveImportedAssets(4243, src, scan.files)).toThrow()
    expect(fs.existsSync(path.join(state.root, 'data', 'skill-assets', '4243'))).toBe(false)
  })

  it('模糊名不是重名:岛上已有「PDF」时「PDF处理」照常导入(精确比对口径)', async () => {
    const ts = new Date().toISOString()
    state.db!
      .prepare(
        `INSERT INTO skills (name, description, content, creator_bot_id, status, version, created_at, updated_at, origin)
         VALUES ('PDF', '已有的卡', 'c', 'b1', 'active', 1, ?, ?, 'island')`
      )
      .run(ts, ts)
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'))
    const out = await runImport(state.bot!, { path: src, name: 'PDF处理' })
    expect(out).toContain('已导入技能「PDF处理」')
  })

  it('工作区已有同名陌生目录:拒合并诚实交代,卡仍导入装好,陌生文件原样保留', async () => {
    const ws = state.bot!.workspacePath!
    fs.mkdirSync(path.join(ws, '技能', '飞书群管'), { recursive: true })
    fs.writeFileSync(path.join(ws, '技能', '飞书群管', '居民自己的文件.txt'), 'keep')
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'))
    const out = await runImport(state.bot!, { path: src })
    expect(out).toContain('落位失败')
    expect(out).toContain('不是这张卡的随卡目录')
    expect(fs.existsSync(path.join(ws, '技能', '飞书群管', '居民自己的文件.txt'))).toBe(true)
    const row = state.db!.prepare(`SELECT id, status FROM skills WHERE name = '飞书群管'`).get() as {
      id: number
      status: string
    }
    expect(row.status).toBe('active')
    const install = state.db!
      .prepare(`SELECT 1 AS ok FROM skill_installs WHERE skill_id = ? AND bot_id = 'b1'`)
      .get(row.id)
    expect(install).toBeTruthy()
  })

  it('全岛删除导入卡:学习居民工作区随卡副本与岛档一并清掉,不留孤儿副本', async () => {
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'))
    await runImport(state.bot!, { path: src })
    const row = state.db!.prepare(`SELECT id FROM skills WHERE name = '飞书群管'`).get() as { id: number }
    const placed = path.join(state.root, '群岛', '小艾-abc123', '技能', '飞书群管')
    expect(fs.existsSync(placed)).toBe(true)
    deleteIslandSkill(row.id)
    expect(fs.existsSync(placed)).toBe(false)
    expect(fs.existsSync(path.join(state.root, 'data', 'skill-assets', String(row.id)))).toBe(false)
  })

  it('安装收口:卸下后再 install_skill,随卡文件重新落位且可再次卸下', async () => {
    const src = makeSkillFolder(path.join(state.root, '群岛', '技能收件箱'))
    await runImport(state.bot!, { path: src })
    const placed = path.join(state.root, '群岛', '小艾-abc123', '技能', '飞书群管', 'scripts', 'run.sh')
    await executeTool(state.bot!, 'uninstall_skill', { skill: '飞书群管' }, depsBase)
    expect(fs.existsSync(placed)).toBe(false)
    const out = await executeTool(state.bot!, 'install_skill', { skill: '飞书群管' }, depsBase)
    expect(out).toContain('随卡文件已放进')
    expect(fs.existsSync(placed)).toBe(true)
  })
})
