#!/usr/bin/env node
// 界面文案防漏网扫描(2026-10-30 双语):渲染层源码不允许硬编码 CJK(中文注释除外)——
// 中文只能住在 i18n/zh.ts。挂在 typecheck:web 之后,新增硬编码中文直接红。
// 逐字符状态机:跳过 //与块注释;单双引号字符串/模板字面量/JSX 文本里的 CJK 都算违规。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIR = path.join(ROOT, 'src/renderer/src')
// 词典本体豁免:zh.ts 是中文的家;en.ts 里仅有的中文是「中文」这个自指标签(语言名不翻)
// AvatarAtlas = dev-only 自检页(?avatar-atlas),诊断文案面向开发者,不进用户词典
const ALLOW = new Set([
  path.join(SCAN_DIR, 'i18n', 'zh.ts'),
  path.join(SCAN_DIR, 'i18n', 'en.ts'),
  path.join(SCAN_DIR, 'components', 'AvatarAtlas.tsx')
])
// … 为通用省略号(英文 Loading… 也用),不算中文证据
const CJK = /\p{Script=Han}|[，。、；：？！「」『』（）《》]/u

const files = []
;(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.(ts|tsx)$/.test(name)) files.push(full)
  }
})(SCAN_DIR)

/** 返回源码里违规 CJK 所在行号(去重);注释与 // locale:protocol 行不违规(后者=匹配主进程中文协议串) */
function violations(src) {
  const lines = src.split('\n')
  const marked = lines.map((l, i) => (/\/\/\s*locale:protocol/.test(l) ? i + 1 : 0)).filter(Boolean)
  const exempt = new Set(marked.flatMap((n) => [n, n + 1])) // 标记行与紧随其后的那行(违规串常在下一行)
  if (exempt.size) {
    return [...new Set(scan(src).filter((n) => !exempt.has(n)))]
  }
  return scan(src)
}

function scan(src) {
  const hits = []
  let state = 'code' // code | line | block | squote | dquote | template
  const templateStack = [] // 模板 ${ 内嵌表达式后回退层级
  let line = 1
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '\n') line++
    if (state === 'line') {
      if (c === '\n') state = 'code'
    } else if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code'
        i++
      }
    } else if (state === 'squote') {
      if (c === '\\') {
        i++
        continue
      }
      if (c === "'") state = 'code'
      else if (CJK.test(c)) hits.push(line)
    } else if (state === 'dquote') {
      if (c === '\\') {
        i++
        continue
      }
      if (c === '"') state = 'code'
      else if (CJK.test(c)) hits.push(line)
    } else if (state === 'template') {
      if (c === '\\') {
        i++
        continue
      }
      if (c === '`') state = 'code'
      else if (c === '$' && n === '{') {
        templateStack.push('template')
        state = 'code'
        i++
      } else if (CJK.test(c)) hits.push(line)
    } else {
      if (c === '/' && n === '/') {
        state = 'line'
        i++
      } else if (c === '/' && n === '*') {
        state = 'block'
        i++
      } else if (c === "'") state = 'squote'
      else if (c === '"') state = 'dquote'
      else if (c === '`') state = 'template'
      else if (c === '}' && templateStack.length > 0) state = templateStack.pop()
      else if (CJK.test(c)) hits.push(line)
    }
  }
  return [...new Set(hits)]
}


let bad = 0
for (const file of files) {
  if (ALLOW.has(file)) continue
  const hits = violations(readFileSync(file, 'utf-8'))
  if (hits.length > 0) {
    bad++
    const rel = path.relative(ROOT, file)
    console.error(`✗ ${rel} 含硬编码中文:行 ${hits.slice(0, 12).join(', ')}${hits.length > 12 ? ' …' : ''}`)
  }
}
if (bad > 0) {
  console.error(`\n界面文案必须走 i18n(src/renderer/src/i18n/zh.ts);以上 ${bad} 个文件需迁移。`)
  process.exit(1)
}

// ---- 主进程 UI 面闸:系统通知与对话框的文案必须经 uiStr() ----
// src/main 充满 B 域中文(工具结果/prompt),不能全量扫;只盯「用户直接看到的系统面」:
// new Notification( / dialog.show* / notifyIfBlurred( 调用点附近出现中文且未走 uiStr 即红(notifyIfBlurred=全应用通知漏斗)。
// 菜单项(label:)不在此列——菜单集中在 index.ts setupAppMenu,靠走查与约定覆盖。
const MAIN_DIR = path.join(ROOT, 'src/main')
const MAIN_UI_API = /new Notification\(|dialog\.show(?:ErrorBox|MessageBox|MessageBoxSync)\(|notifyIfBlurred\(/g

/** 取调用点的参数区:从 '(' 起平衡括号到配对 ')',跳过字符串字面量——只测参数本身,不受邻近代码/日志干扰 */
function callArgs(src, matchIdx) {
  let i = src.indexOf('(', matchIdx)
  if (i < 0) return ''
  let depth = 0
  let j = i
  for (; j < src.length; j++) {
    const c = src[j]
    if (c === '\'' || c === '"' || c === '`') {
      const q = c
      j++
      while (j < src.length && src[j] !== q) {
        if (src[j] === '\\') j++
        j++
      }
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) break
    }
  }
  return src.slice(i, Math.min(j + 1, src.length))
}

/** 从参数文本里剥掉 uiStr(...) 调用(平衡括号)——留下的字符串字面量才是「裸文案」;
 *  混合参数(一半走了 uiStr 一半还是裸中文)因此也能抓到 */
function stripUiStr(args) {
  let out = args
  let idx
  while ((idx = out.indexOf('uiStr(')) >= 0) {
    const open = idx + 'uiStr('.length - 1
    let depth = 0
    let close = -1
    for (let j = open; j < out.length; j++) {
      const c = out[j]
      if (c === '\'' || c === '"' || c === '`') {
        const q = c
        j++
        while (j < out.length && out[j] !== q) {
          if (out[j] === '\\') j++
          j++
        }
        continue
      }
      if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (depth === 0) {
          close = j
          break
        }
      }
    }
    if (close < 0) break
    out = out.slice(0, idx) + out.slice(close + 1)
  }
  return out
}

const mainFiles = readdirSync(MAIN_DIR).filter((n) => /\.ts$/.test(n))
let mainBad = 0
for (const name of mainFiles) {
  const src = readFileSync(path.join(MAIN_DIR, name), 'utf-8')
  MAIN_UI_API.lastIndex = 0
  let m
  while ((m = MAIN_UI_API.exec(src)) !== null) {
    // 参数区里的中文字符串字面量,且未走 uiStr——通知/对话框用户可见文案漏了本地化
    const args = callArgs(src, m.index)
    const literals = stripUiStr(args).match(/(['"`])[^'"`]*\p{Script=Han}[^'"`]*\1/u)
    if (literals) {
      const lineNo = src.slice(0, m.index).split('\n').length
      console.error(`✗ src/main/${name}:${lineNo} 通知/对话框参数含中文字面量且未经 uiStr()——请走 src/main/ui-strings.ts(${literals[0].slice(0, 30)})`)
      mainBad++
    }
  }
}
if (mainBad > 0) process.exit(1)
console.log(`check-ui-locale: ${files.length} 个渲染层文件无硬编码中文,主进程 ${mainFiles.length} 文件通知/对话框全走 uiStr ✓`)
