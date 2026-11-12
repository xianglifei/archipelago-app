#!/usr/bin/env node
// i18n 词典 key 校验(2026-10-30 双语):组件里用到的 t('…') / i18nKey / 主进程 TOOL_ZH 的 key
// 必须真实存在于 zh 词典——缺 key 运行时静默回落中文(fallbackLng),必须静态抓出来。
// zh/en 的结构 parity 由 en.ts 的 `typeof zh` 在 typecheck 强制,本脚本只管「用到的 key 存在」。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- 1. 解析 zh.ts,取全部叶子 key(嵌套对象 → 点路径;数组值跳过) ----
const zhPath = path.join(ROOT, 'src/renderer/src/i18n/zh.ts')
const source = ts.createSourceFile(zhPath, readFileSync(zhPath, 'utf-8'), ts.ScriptTarget.ES2022, true)
const dictKeys = new Set()

function walkObject(node, prefix) {
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const name = prop.name.getText(source).replace(/^['"]|['"]$/g, '')
    const key = prefix ? `${prefix}.${name}` : name
    if (ts.isObjectLiteralExpression(prop.initializer)) {
      walkObject(prop.initializer, key)
    } else {
      dictKeys.add(key)
    }
  }
}
for (const stmt of source.statements) {
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === 'zh' && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
        walkObject(decl.initializer, '')
      }
    }
  }
}

// ---- 2. 收集用到的 key ----
const used = new Map() // key -> 位置描述
const files = []
;(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full)
    else if (/\.(ts|tsx)$/.test(name)) files.push(full)
  }
})(path.join(ROOT, 'src'))

const USAGE_PATTERNS = [
  /\bt\(\s*'([a-zA-Z][\w.]*)'/g, // t('chat.stop') / t('x', {...})
  /\bi18nKey="([a-zA-Z][\w.]*)"/g, // <Trans i18nKey="login.sentTo">
  /^\s*'(chat\.(?:tool|out)\.[a-zA-Z]+)':/gm // 主进程 TOOL_ZH 的 key(value 映射的键名)
]
for (const file of files) {
  if (file.includes(path.join('src', 'renderer', 'src', 'i18n'))) continue // 词典自身除外
  const src = readFileSync(file, 'utf-8')
  for (const re of USAGE_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src)) !== null) {
      used.set(m[1], `${path.relative(ROOT, file)}`)
    }
  }
}

// ---- 3. 校验 ----
let bad = 0
for (const [key, where] of used) {
  if (!dictKeys.has(key)) {
    bad++
    console.error(`✗ 缺 key:${key}  (${where})`)
  }
}
if (bad > 0) {
  console.error(`\n以上 ${bad} 个 key 在 zh 词典里不存在(注意数组值与嵌套路径)。`)
  process.exit(1)
}
console.log(`check-i18n-keys: ${used.size} 个在用 key 全部命中词典(词典共 ${dictKeys.size} key)✓`)
