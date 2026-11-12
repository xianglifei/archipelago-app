import { createContext, memo, useContext, useRef, useState, isValidElement, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { CodeBlock } from './CodeBlock'
import { MarkdownImage } from './MarkdownImage'
import { remarkAutolinkLocalPaths } from './autolinkLocalPaths'
import { classifyMarkdownImageSrc } from '@shared/markdown-image-core'
import { isLocalPathText, resolveWorkspacePath } from '@shared/md-autolink-core'
import { openFileSmart } from '../../utils/open-file'
import { copyText } from '../../utils/clipboard'
import { useTranslation } from '../../i18n'

// 流式与否通过 context 下发,代码块据此跳过高亮(参考 ChatBox:闭合后再高亮,避免闪烁)
export const StreamingContext = createContext(false)

// 正文相对路径(产出/xxx.md)的解析基准=当前居民工作区(2026-11-06 后缀规则):单聊/群聊/任务由
// 各视图供给;邮局信件等无基准的视图保持 null——相对路径还原纯文本,不产死链
export const WorkspaceBaseContext = createContext<string | null>(null)

// 本机路径 autolink(2026-11-06 方案 A)挂在最末:GFM/数学先解析,文本节点级的路径包裹不影响前者
const remarkPlugins = [remarkGfm, remarkMath, remarkAutolinkLocalPaths]
const rehypePlugins = [rehypeKatex]

// 流式中未闭合的代码围栏先补一个闭合,避免围栏之后的正文整段被吞进代码块
function healFences(text: string): string {
  let fences = 0
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) fences += 1
  }
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

// react-markdown 默认 urlTransform 只放行 http(s) 等协议与相对 URL:本机绝对路径(POSIX `/…`、
// Windows 盘符 `C:\…`)与 `data:image/…` 都会被清成空串,MarkdownImage 的本地三分流根本收不到。
// 定向放行 classifyMarkdownImageSrc 认识的形态(其余 URL 走默认消毒)。注意 urlTransform 是全局
// 属性、<a> 链接同吃这份白名单:故刻意不含 `file://`——主进程 shell.openExternal 对它会把本机
// 路径直接交给系统打开,链接形态绕过审批面不值得开;图片侧 file:// 写法罕见,降级占位可接受
function imgSrcUrlTransform(url: string): string {
  if (
    url.startsWith('/') ||
    url.startsWith('~/') ||
    url.startsWith('~\\') ||
    url.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(url) ||
    /^data:image\//i.test(url)
  ) {
    return url
  }
  return defaultUrlTransform(url)
}

// 表格:横向滚动容器 + hover 复制为 TSV(可直接贴进表格软件)
function MarkdownTable({ children }: { children?: ReactNode }) {
  const { t } = useTranslation()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  function copy(): void {
    const table = wrapRef.current?.querySelector('table')
    if (!table) return
    const tsv = Array.from(table.querySelectorAll('tr'))
      .map((tr) =>
        Array.from(tr.querySelectorAll('th,td'))
          .map((td) => td.textContent?.trim() ?? '')
          .join('\t')
      )
      .join('\n')
    void copyText(tsv).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="md-table-wrap" ref={wrapRef}>
      <table>{children}</table>
      <button className="md-table-copy" onClick={copy}>
        {copied ? t('common.copied') : t('common.copy')}
      </button>
    </div>
  )
}

/** urlTransform 的 default 分支会对相对 URL encodeURI(中文→%XX):判定与解析前先解一次,
 * 解不动(字面 % 序列)原样——markdown-image-core decodeLocalEscapes 同款口径 */
function decodeHref(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// 链接组件(2026-11-06 方案 A):本机路径(绝对/~ 形态或可解析的相对 .md 路径)点击统一分流
// openFileSmart(.md 进阅读器/其余系统应用),不走 target=_blank(主进程 openExternal 对本机
// 路径打不开);无工作区基准又解析不了的相对 .md 路径还原纯文本,不产死链
function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  const workspaceBase = useContext(WorkspaceBaseContext)
  const rawHref = decodeHref(href ?? '')
  const local = classifyMarkdownImageSrc(rawHref)
  const relative = local.kind === 'unsupported' && rawHref ? isLocalPathText(rawHref) : null
  const target = local.kind === 'local' ? local.path : relative ? resolveWorkspacePath(workspaceBase, relative) : null
  if (target) {
    return (
      <a
        href={href}
        title={target}
        onClick={(e) => {
          e.preventDefault()
          void openFileSmart(target)
        }}
      >
        {children}
      </a>
    )
  }
  if (relative) return <span>{children}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  )
}

// 插件与组件映射保持模块级引用稳定,避免 react-markdown 每次重解析
const components: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children
    let lang = 'text'
    let code = ''
    if (isValidElement(child)) {
      const props = child.props as { className?: string; children?: ReactNode }
      lang = /language-([\w+-]+)/.exec(props.className ?? '')?.[1]?.toLowerCase() ?? 'text'
      code = nodeText(props.children).replace(/\n$/, '')
    }
    return <CodeBlock code={code} lang={lang} />
  },
  table({ children }) {
    return <MarkdownTable>{children}</MarkdownTable>
  },
  a: MdLink,
  // 居民正文内嵌图(2026-11-05):本机路径渲染缩略图,远程降级链接,详见 MarkdownImage.tsx
  img({ src, alt }) {
    return <MarkdownImage src={src} alt={alt} />
  }
}

export const Markdown = memo(function Markdown({
  content,
  streaming = false
}: {
  content: string
  streaming?: boolean
}) {
  const healed = streaming ? healFences(content) : content
  return (
    <StreamingContext.Provider value={streaming}>
      <div className={`md${streaming ? ' streaming' : ''}`}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
          urlTransform={imgSrcUrlTransform}
        >
          {healed}
        </ReactMarkdown>
      </div>
    </StreamingContext.Provider>
  )
})
