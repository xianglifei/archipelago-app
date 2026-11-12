import { useContext, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { createHighlighter } from 'shiki'
import { StreamingContext } from './Markdown'
import { copyText } from '../../utils/clipboard'
import { useTranslation } from '../../i18n'

const THEME = 'github-dark-default'

// 常用语言预载,其余语言首次遇到时按需懒加载
const PRELOAD_LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'css',
  'html',
  'markdown',
  'python',
  'bash',
  'sql',
  'yaml',
  'diff'
]

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>
type LangInput = Parameters<Highlighter['loadLanguage']>[0]
let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [THEME], langs: PRELOAD_LANGS })
  return highlighterPromise
}

const htmlCache = new Map<string, string>()

async function highlight(code: string, lang: string): Promise<string | null> {
  const key = `${lang}\n${code}`
  const cached = htmlCache.get(key)
  if (cached) return cached
  try {
    const hl = await getHighlighter()
    let resolved = lang
    if (!hl.getLoadedLanguages().includes(lang)) {
      try {
        await hl.loadLanguage(lang as LangInput)
      } catch {
        resolved = 'text'
      }
    }
    const html = hl.codeToHtml(code, { lang: resolved, theme: THEME })
    if (htmlCache.size > 200) htmlCache.clear()
    htmlCache.set(key, html)
    return html
  } catch {
    return null
  }
}

const LANG_LABELS: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  javascript: 'js',
  typescript: 'ts',
  py: 'python',
  rb: 'ruby',
  md: 'markdown',
  yml: 'yaml'
}

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { t } = useTranslation()
  const streaming = useContext(StreamingContext)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  // 内容区完全命令式管理:先放纯文本兜底,非流式且高亮就绪后整体替换,
  // 避免 React 虚拟 DOM 与 innerHTML 互相打架(流式期间每个 delta 都会重建)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.innerHTML = ''
    const pre = document.createElement('pre')
    const codeEl = document.createElement('code')
    codeEl.textContent = code
    pre.appendChild(codeEl)
    el.appendChild(pre)
    if (streaming) return
    let cancelled = false
    void highlight(code, lang).then((html) => {
      if (!cancelled && html && bodyRef.current) bodyRef.current.innerHTML = html
    })
    return () => {
      cancelled = true
    }
  }, [code, lang, streaming])

  async function copy(): Promise<void> {
    await copyText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-block-lang">{lang === 'text' ? t('markdown.text') : LANG_LABELS[lang] ?? lang}</span>
        <button className="code-block-copy" onClick={() => void copy()}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      <div className="code-block-body" ref={bodyRef} />
    </div>
  )
}
