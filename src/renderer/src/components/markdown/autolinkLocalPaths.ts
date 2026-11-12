import type { InlineCode, Link, Parent, PhrasingContent, Root, Text } from 'mdast'
import { isLocalPathText, scanLocalPathSpans } from '@shared/md-autolink-core'

// 正文本机路径 autolink(2026-11-06 方案 A):mdast 文本节点级扫描,把 /Users/… 与 ~/… 家目录形态
// 路径包成 link 节点。选 AST 而非字符串预处理的原因:代码块/行内代码是独立节点类型天然跳过;
// 已有 markdown 链接的文字在 link 节点子树里,不会二次包裹出 `[a]([b](b))` 破坏语法。
// 点击分流与样式见 Markdown.tsx 的 a 组件(本机路径走 openFileSmart,不 target=_blank)。
// 反引号内联代码(2026-11-06 二次走查):居民惯用 `路径` 强调文件名,整段恰是路径时同样包成
// link>inlineCode(保持 code 视觉,获得可点语义);块级代码块刻意不动(脚本里的路径≠文件引用)。

/** 这两类节点子树内的文字已是链接语境,跳过 */
const SKIP_PARENT_TYPES = new Set(['link', 'linkReference'])

function visit(parent: Parent): void {
  const children = parent.children
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (!node) continue
    if ('children' in node) {
      if (!SKIP_PARENT_TYPES.has(node.type)) visit(node as Parent)
      continue
    }
    if (node.type === 'inlineCode') {
      const value = (node as InlineCode).value
      const path = isLocalPathText(value)
      if (path) {
        const link: Link = { type: 'link', url: path, children: [{ type: 'inlineCode', value }] }
        children.splice(i, 1, link)
      }
      continue
    }
    if (node.type !== 'text') continue
    const value = (node as Text).value
    const spans = scanLocalPathSpans(value)
    if (spans.length === 0) continue

    const replacement: PhrasingContent[] = []
    let cursor = 0
    for (const span of spans) {
      if (span.start > cursor) replacement.push({ type: 'text', value: value.slice(cursor, span.start) })
      const link: Link = { type: 'link', url: span.path, children: [{ type: 'text', value: span.path }] }
      replacement.push(link)
      cursor = span.end
    }
    if (cursor < value.length) replacement.push({ type: 'text', value: value.slice(cursor) })
    children.splice(i, 1, ...replacement)
    i += replacement.length - 1
  }
}

export function remarkAutolinkLocalPaths(): (tree: Root) => void {
  return (tree) => visit(tree)
}
