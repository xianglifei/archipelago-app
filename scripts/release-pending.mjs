// RELEASE-PENDING.md 的解析与归档 —— 各开发 session 登记的「发版前置事项」的集中读取层。
// release.mjs 发版前强制读取(有未勾选条目即拦下),cloud 部署 postflight 打印提醒;成功发版后归档已勾条目。
// 本模块只提供函数,无 CLI、无顶层副作用,可安全被 import。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 测试/特殊场景可用 RELEASE_PENDING_FILE 指到别处,不动真实清单
export const pendingPath = process.env.RELEASE_PENDING_FILE || path.join(root, 'RELEASE-PENDING.md')

const OPEN_RE = /^\s*-\s*\[\s\]\s*(.+)$/
const DONE_RE = /^\s*-\s*\[[xX]\]\s*(.+)$/

export function parsePending() {
  let text
  try {
    text = fs.readFileSync(pendingPath, 'utf8')
  } catch {
    return { exists: false, open: [], done: [] }
  }
  const open = []
  const done = []
  for (const line of text.split('\n')) {
    const m = OPEN_RE.exec(line)
    if (m) {
      open.push(m[1].trim())
      continue
    }
    const d = DONE_RE.exec(line)
    if (d) done.push(d[1].trim())
  }
  return { exists: true, open, done }
}

/** 成功发版后归档:删除已勾选([x])条目,未勾选与其余内容原样保留 */
export function archiveDone() {
  const raw = fs.readFileSync(pendingPath, 'utf8')
  const kept = raw.split('\n').filter((l) => !DONE_RE.test(l))
  fs.writeFileSync(pendingPath, kept.join('\n'))
}
