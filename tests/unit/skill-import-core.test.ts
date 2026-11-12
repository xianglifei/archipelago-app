// skill-import-core 单测(2026-11-08 import_skill):frontmatter 解析/导入校验/来源扫描/清单文本。
// 纯逻辑零 mock;扫描用例走真实 tmp 目录(fs 直测,与 path-fence 单测同思路)
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  IMPORTED_DESC_MAX,
  IMPORTED_NAME_MAX,
  buildImportedManifestSection,
  parseSkillMd,
  sanitizeSkillDirName,
  scanSourceTree,
  validateImportedSkillDraft
} from '../../src/shared/skill-import-core'

describe('parseSkillMd', () => {
  it('扁平 frontmatter:name/description 进字段,其余进正文', () => {
    const parsed = parseSkillMd('---\nname: pdf 处理\ndescription: 处理 PDF 文档\n---\n\n# 做法\n\n第一步。')
    expect(parsed.name).toBe('pdf 处理')
    expect(parsed.description).toBe('处理 PDF 文档')
    expect(parsed.body).toBe('# 做法\n\n第一步。')
  })

  it('引号值与 CRLF 行尾都剥干净', () => {
    const parsed = parseSkillMd('---\r\nname: "quoted"\r\ndescription: \'single\'\r\n---\r\nbody text')
    expect(parsed.name).toBe('quoted')
    expect(parsed.description).toBe('single')
    expect(parsed.body).toBe('body text')
  })

  it('无 frontmatter:整篇按正文处理,字段缺省', () => {
    const parsed = parseSkillMd('# 只有正文\n没有围栏')
    expect(parsed.name).toBeUndefined()
    expect(parsed.description).toBeUndefined()
    expect(parsed.body).toBe('# 只有正文\n没有围栏')
  })

  it('块标量(折行 description)收成一段', () => {
    const parsed = parseSkillMd('---\ndescription: >-\n  什么时候用:\n  处理图片。\nname: img\n---\n正文')
    expect(parsed.description).toBe('什么时候用: 处理图片。')
    expect(parsed.name).toBe('img')
  })

  it('宿主专属键(allowed-tools 等)忽略,不污染正文', () => {
    const parsed = parseSkillMd('---\nname: x\ndescription: d\nallowed-tools: Bash, Read\nlicense: MIT\n---\nhello')
    expect(parsed.name).toBe('x')
    expect(parsed.body).toBe('hello')
    expect(JSON.stringify(parsed)).not.toContain('Bash')
  })

  it('围栏未闭合:不抛异常,name 解析到、正文为空 → 落卡校验诚实拦下', () => {
    const parsed = parseSkillMd('---\nname: x\n没有闭合围栏')
    expect(parsed.name).toBe('x')
    expect(parsed.body).toBe('')
    expect(validateImportedSkillDraft({ name: 'x', description: 'd', content: parsed.body })).toContain('正文不能为空')
  })
})

describe('validateImportedSkillDraft', () => {
  const base = { name: 'ok', description: 'd', content: 'c' }
  it('名字 64 字内放行,超了报上限', () => {
    expect(validateImportedSkillDraft({ ...base, name: 'a'.repeat(IMPORTED_NAME_MAX) })).toBeNull()
    expect(validateImportedSkillDraft({ ...base, name: 'a'.repeat(IMPORTED_NAME_MAX + 1) })).toContain('上限 64')
  })
  it('描述 500 字内放行,超了报上限', () => {
    expect(validateImportedSkillDraft({ ...base, description: 'd'.repeat(IMPORTED_DESC_MAX) })).toBeNull()
    expect(validateImportedSkillDraft({ ...base, description: 'd'.repeat(IMPORTED_DESC_MAX + 1) })).toContain('上限 500')
  })
  it('正文不限长:12000 字原样放行(拍板:导入卡不压缩)', () => {
    expect(validateImportedSkillDraft({ ...base, content: 'c'.repeat(12000) })).toBeNull()
  })
  it('缺名/缺描述/缺正文分别给可行动的报错', () => {
    expect(validateImportedSkillDraft({ ...base, name: '' })).toContain('frontmatter 要有 name')
    expect(validateImportedSkillDraft({ ...base, description: '' })).toContain('description')
    expect(validateImportedSkillDraft({ ...base, content: '' })).toContain('正文不能为空')
  })
})

describe('sanitizeSkillDirName', () => {
  it('非法字符清洗 + 截断 32 字', () => {
    expect(sanitizeSkillDirName('pdf 处理/v2?')).toBe('pdf处理v2')
    expect(sanitizeSkillDirName('x'.repeat(40))).toHaveLength(32)
    expect(sanitizeSkillDirName('/*?')).toBe('skill')
  })
})

describe('scanSourceTree', () => {
  function makeTree(): { root: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-'))
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: t\n---\nbody')
    fs.writeFileSync(path.join(root, 'scripts', 'run.py'), 'print(1)')
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
  }

  it('常规目录:文件收录(正斜杠 rel)、合计字节正确', () => {
    const { root, cleanup } = makeTree()
    try {
      const scan = scanSourceTree(root)
      expect(scan.breach).toBeNull()
      expect(scan.files.map((f) => f.rel).sort()).toEqual(['SKILL.md', 'scripts/run.py'])
      expect(scan.totalBytes).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  it('符号链接逐条跳过,不跟随', () => {
    const { root, cleanup } = makeTree()
    try {
      fs.symlinkSync('/etc/hostname', path.join(root, 'evil'))
      const scan = scanSourceTree(root)
      expect(scan.files.some((f) => f.rel === 'evil')).toBe(false)
      expect(scan.skipped.find((s) => s.rel === 'evil')?.reason).toContain('符号链接')
    } finally {
      cleanup()
    }
  })

  it('噪音目录(.git/node_modules)记入 skipped 不入岛', () => {
    const { root, cleanup } = makeTree()
    try {
      fs.mkdirSync(path.join(root, '.git', 'refs'), { recursive: true })
      fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref')
      fs.writeFileSync(path.join(root, '.DS_Store'), 'junk')
      const scan = scanSourceTree(root)
      expect(scan.files.some((f) => f.rel.startsWith('.git'))).toBe(false)
      expect(scan.skipped.some((s) => s.rel === '.git')).toBe(true)
      expect(scan.skipped.some((s) => s.rel === '.DS_Store')).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('超单文件上限:该文件跳过、整包不拒收', () => {
    const { root, cleanup } = makeTree()
    try {
      fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(600 * 1024, 1))
      const scan = scanSourceTree(root)
      expect(scan.breach).toBeNull()
      expect(scan.files.some((f) => f.rel === 'big.bin')).toBe(false)
      expect(scan.skipped.find((s) => s.rel === 'big.bin')?.reason).toContain('超上限')
    } finally {
      cleanup()
    }
  })

  it('文件数超 50:整包拒收(breach)', () => {
    const { root, cleanup } = makeTree()
    try {
      for (let i = 0; i < 52; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x')
      const scan = scanSourceTree(root)
      expect(scan.breach).toContain('50 个')
    } finally {
      cleanup()
    }
  })

  it('总量超 2MB:整包拒收(breach);单件都须在上限内(超单件的会被跳过、攒不到总量)', () => {
    const { root, cleanup } = makeTree()
    try {
      for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `big${i}.bin`), Buffer.alloc(450 * 1024, 1))
      const scan = scanSourceTree(root)
      expect(scan.breach).toContain('MB')
    } finally {
      cleanup()
    }
  })
})

describe('buildImportedManifestSection', () => {
  it('有文件:清单含相对路径、根目录交代与 run_command 口径', () => {
    const text = buildImportedManifestSection(
      'pdf处理',
      [{ rel: 'scripts/run.py', size: 10 }],
      [{ rel: '.git', reason: '噪音目录/系统文件,不入岛' }]
    )
    expect(text).toContain('技能/pdf处理/')
    expect(text).toContain('· scripts/run.py')
    expect(text).toContain('· .git(未带入')
    expect(text).toContain('run_command')
  })
  it('无文件无跳过:整段省略', () => {
    expect(buildImportedManifestSection('x', [], [])).toBe('')
  })
})

describe('sanitizeSkillDirName:相对路径分量兜底(codex 评审 #1 回归)', () => {
  it("'.' 与 '..' 落到兜底名,不会指到「技能/」上层", () => {
    expect(sanitizeSkillDirName('..')).toBe('skill')
    expect(sanitizeSkillDirName('.')).toBe('skill')
    expect(sanitizeSkillDirName(' ')).toBe('skill')
    expect(sanitizeSkillDirName('..foo')).toBe('..foo')
  })
})

describe('parseSkillMd:正文原样(codex 评审 #9/#10 回归)', () => {
  it('行首缩进保留:四空格缩进代码块不被 trim 破形', () => {
    const parsed = parseSkillMd('---\nname: x\ndescription: d\n---\n\n    indented_code()\n    more()')
    expect(parsed.body).toBe('    indented_code()\n    more()')
  })

  it('CRLF 正文原样保留(不重排行尾)', () => {
    const parsed = parseSkillMd('---\r\nname: x\r\ndescription: d\r\n---\r\n\r\nstep one\r\nstep two')
    expect(parsed.body).toBe('step one\r\nstep two')
  })

  it('尾部空白保留(原样口径),仅围栏后的首个空行剥离', () => {
    const parsed = parseSkillMd('---\nname: x\ndescription: d\n---\n\n正文\n\n\n')
    expect(parsed.body).toBe('正文\n\n\n')
  })

  it('折行块标量(>)含空行:空行当分段,不静默截断后半段', () => {
    const parsed = parseSkillMd('---\ndescription: >\n  第一段什么时候用。\n\n  第二段也属于描述。\nname: x\n---\n正文')
    expect(parsed.description).toBe('第一段什么时候用。\n第二段也属于描述。')
    expect(parsed.name).toBe('x')
  })

  it('字面量块标量(|)保留相对缩进与空行(描述里贴代码段不破形)', () => {
    const parsed = parseSkillMd('---\ndescription: |\n  用法:\n\n    run --flag\n    done\nname: x\n---\n正文')
    expect(parsed.description).toBe('用法:\n\n  run --flag\n  done')
    expect(parsed.name).toBe('x')
  })
})

describe('scanSourceTree:先跳过再计量(codex 评审 #12 回归)', () => {
  function makeTree(): { root: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-'))
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: t\n---\nbody')
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
  }

  it('单件 3MB(超过单件也超过总量):按单件口径跳过,不整包拒收', () => {
    const { root, cleanup } = makeTree()
    try {
      fs.writeFileSync(path.join(root, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024, 1))
      const scan = scanSourceTree(root)
      expect(scan.breach).toBeNull()
      expect(scan.files.some((f) => f.rel === 'huge.bin')).toBe(false)
      expect(scan.skipped.find((s) => s.rel === 'huge.bin')?.reason).toContain('超上限')
    } finally {
      cleanup()
    }
  })

  it('已收录接近总量时再遇应跳过的大文件:跳过即可,不误判总量超限', () => {
    const { root, cleanup } = makeTree()
    try {
      for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(root, `big${i}.bin`), Buffer.alloc(480 * 1024, 1))
      fs.writeFileSync(path.join(root, 'oversize.bin'), Buffer.alloc(600 * 1024, 1))
      const scan = scanSourceTree(root)
      expect(scan.breach).toBeNull()
      expect(scan.files).toHaveLength(5) // SKILL.md + 4 个 big
      expect(scan.totalBytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 40 * 1024)
    } finally {
      cleanup()
    }
  })
})
