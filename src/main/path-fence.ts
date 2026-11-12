// 路径围栏纯函数(2026-11-04 从 fs-tools 拆出,零 electron 依赖):
// 供 fs-tools(本机文件工具)与 shell-classify-core(危险命令分类)共用,
// 拆分的动机是让分类逻辑可在 vitest 里直接单测(W1 修复矩阵要覆盖 win32 语义)。
import fs from 'node:fs'
import path from 'node:path'

/** 容错 realpath:尾部不存在的部分原样保留,只对最近存在祖先做真实路径穿透(symlink/junction) */
export function realpathSafe(p: string): string {
  let cur = p
  const suffix: string[] = []
  while (!fs.existsSync(cur)) {
    suffix.unshift(path.basename(cur))
    const parent = path.dirname(cur)
    if (parent === cur) return path.normalize(p)
    cur = parent
  }
  try {
    return path.join(fs.realpathSync(cur), ...suffix)
  } catch {
    return path.normalize(p)
  }
}

/** child 是否落在 parent 内(含相等);边界判断用宿主平台语义 */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
