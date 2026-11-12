import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { FileText, Folder, Loader2, Paperclip, Send, Square, X } from 'lucide-react'
import type { AttachmentIntakeItem, MessageAttachment } from '@shared/types'
import { DirectoryInput, type DirectoryInputHandle } from './DirectoryInput'
import { shortAttachmentName, shortAttachmentPath } from '@shared/attachments-core'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { openFileSmart } from '../utils/open-file'
import { QuoteStrip } from './quote/QuoteStrip'
import { useQuoteRecord } from './quote/quoteStore'

// 共享输入框(2026-10-29 输入框升级;2026-10-30 评审改版):单聊/群聊共用,合并此前两处复制的 composer-inbox。
// 承载:回形针附件(选择/粘贴/拖拽三入口统一走主进程 intake)、附件区(输入框顶部一行:
// 图片=缩略图方图/文件=小卡;目录引用在文字区内原子显示与删除)、
// @居民浮窗(键入触发/↑↓ 选择/Enter 确认,IME 组合中不抢键)。
// 选区引用条(2026-11-02)挂在附件区之上:quoteKey 缺省(寄信 PostView)时整个功能关闭。
// 「整行避让」态随 v1.1.1 第三十七轮:单行=文字与两侧图标同排,多行=底部整行让给按钮。

export interface ComposerProps {
  input: string
  onInputChange(v: string): void
  attachments: MessageAttachment[]
  onAttachmentsChange(next: MessageAttachment[]): void
  busy: boolean
  onStop(): void
  onSend(): void
  placeholder: string
  /** 发送键额外禁用条件(如积分用尽);空文本+零附件+零引用的禁用由组件自算 */
  sendDisabled?: boolean
  /** @浮窗候选(群聊=成员,单聊=全岛居民) */
  mentionCandidates: { name: string }[]
  /** 附件管线分流:'chat'(默认,给居民看:图片缩放、目录引用原路径)|'post'(寄信:原样字节复制、拒目录) */
  attachmentMode?: 'chat' | 'post'
  /** 选区引用池分桶键(2026-11-02):单聊=chatQuoteKey(botId)、群聊=groupQuoteKey(groupId);
   *  缺省(寄信)=不挂引用条、引用不参与发送判定 */
  quoteKey?: string
}

/** 从 DataTransfer 取文件与目录标记(Finder 复制/拖入的文件夹靠 webkitGetAsEntry 判目录) */
export function filesFromDataTransfer(dt: DataTransfer): { files: File[]; dirs: boolean[] } {
  const files: File[] = []
  const dirs: boolean[] = []
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (!file) continue
    // webkitGetAsEntry 判目录(Finder 复制的文件夹/拖入的文件夹)
    let isDir = false
    try {
      isDir = item.webkitGetAsEntry()?.isDirectory === true
    } catch {
      // 无 entry API 时按普通文件走(主进程 stat 会再分一次)
    }
    files.push(file)
    dirs.push(isDir)
  }
  return { files, dirs }
}

/** 附件接收 hook(体验反馈 2026-10-30):回形针选择/粘贴/拖拽三入口共用的 intake(主进程分类缩放落盘)
 * +按路径去重合入。拖放区扩大到整个聊天视图后,视图根与 Composer 各挂一份同一个 hook,
 * 去重与合并逻辑单源,谁先接到都走同一条路径 */
export function useAttachmentIntake({
  mode,
  attachments,
  onAttachmentsChange
}: {
  mode: 'chat' | 'post'
  attachments: MessageAttachment[]
  onAttachmentsChange(next: MessageAttachment[]): void
}): { intaking: boolean; intakeFiles(files: File[], dirOnly: boolean[]): Promise<void>; pickFiles(mode?: 'mixed' | 'file' | 'dir'): Promise<void> } {
  const { t } = useTranslation()
  const [intaking, setIntaking] = useState(false)
  // 附件最新快照:intake 是异步的,完成时闭包里的 attachments 可能已过期(连续两批拖入,
  // 后返回的会把先返回的整批顶掉;期间手动删掉的也会被复活)。合并永远基于最新值
  const latestRef = useRef(attachments)
  latestRef.current = attachments

  /** 把主进程返回的新附件按路径去重后并入(同一文件重复拖入不重复挂);写回同步更新快照 */
  const mergeAdded = (added: MessageAttachment[]): void => {
    const base = latestRef.current
    const seen = new Set(base.map((a) => a.path))
    const merged = [...base]
    for (const a of added) {
      if (!seen.has(a.path)) {
        seen.add(a.path)
        merged.push(a)
      }
    }
    latestRef.current = merged
    onAttachmentsChange(merged)
  }

  /** 粘贴/拖拽统一 intake:带真实路径的走 path,截图等无路径图片字节走 dataUrl */
  async function intakeFiles(files: File[], dirOnly: boolean[]): Promise<void> {
    const items: AttachmentIntakeItem[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (!file) continue
      if (dirOnly[i]) {
        // Finder 复制的文件夹:File 对象仍带真实路径(Electron),主进程按 stat 分类
        const p = api.filePathOf(file)
        if (p) items.push({ path: p })
        continue
      }
      const p = api.filePathOf(file)
      if (p) {
        items.push({ path: p })
      } else if (file.type.startsWith('image/')) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(file)
        }).catch(() => null)
        if (dataUrl) items.push({ dataUrl, name: file.name || t('composer.shot') })
      }
    }
    if (items.length === 0) return
    setIntaking(true)
    try {
      const added = await (mode === 'post' ? api.postAttachmentsIntake(items) : api.attachmentsIntake(items))
      mergeAdded(added)
    } catch (err) {
      console.error('[composer] attachment intake failed:', err)
    } finally {
      setIntaking(false)
    }
  }

  /** 回形针:系统对话框选择。mac 一次混选(文件/文件夹);Windows 原生对话框不支持混选,
   *  由回形针按钮的二选一菜单分流(2026-11-04 W4,菜单 state 在 Composer 主体);邮局恒为纯文件选择 */
  async function pickFiles(pickMode: 'mixed' | 'file' | 'dir' = 'mixed'): Promise<void> {
    setIntaking(true)
    try {
      const added = await (mode === 'post' ? api.postAttachmentsPick() : api.attachmentsPick(pickMode))
      if (added.length > 0) mergeAdded(added)
    } catch (err) {
      console.error('[composer] attachment pick failed:', err)
    } finally {
      setIntaking(false)
    }
  }

  return { intaking, intakeFiles, pickFiles }
}

/** @ 触发检测:光标前一段以 @ 开头(其前是行首/空白),token 内无空白 */
function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([^@\s]{0,24})$/.exec(before)
  if (!m) return null
  return { start: caret - m[2]!.length - 1, query: m[2]! }
}

export default function Composer({
  input,
  onInputChange,
  attachments,
  onAttachmentsChange,
  busy,
  onStop,
  onSend,
  placeholder,
  sendDisabled = false,
  mentionCandidates,
  attachmentMode = 'chat',
  quoteKey
}: ComposerProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const directoryRef = useRef<DirectoryInputHandle>(null)
  const directories = attachments.filter((a) => a.kind === 'dir')
  const visualAttachments = attachments.filter((a) => a.kind !== 'dir')
  const hasDirectories = directories.length > 0
  const quoteRecord = useQuoteRecord(quoteKey ?? '')
  const [inputMulti, setInputMulti] = useState(false)
  const { intaking, intakeFiles, pickFiles } = useAttachmentIntake({ mode: attachmentMode, attachments, onAttachmentsChange })
  // Windows 回形针二选一菜单(2026-11-04 W4):原生对话框不支持文件+文件夹混选,拆两个入口;
  // 输入区非窗口拖拽区,document pointerdown 收起即可(无侧栏拖拽区吞事件的坑)
  const [pickMenuOpen, setPickMenuOpen] = useState(false)
  const pickWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pickMenuOpen) return
    const onDown = (e: PointerEvent): void => {
      if (!pickWrapRef.current?.contains(e.target as Node)) setPickMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [pickMenuOpen])
  // @浮窗:mention={起点,查询串} 为 null 时关闭;IME 组合中不更新查询(组合文本不是最终输入)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const composingRef = useRef(false)
  const restoreCaretRef = useRef<number | null>(null)

  const classifyInput = useCallback(() => {
    const el = directoryRef.current?.element() ?? inputRef.current
    if (!el) return
    // 先归一到单行态 padding 再量:multi 态右内边距更小、文字可能因此少折一行,
    // 直读会形成「multi→单行→multi」边界抖动,故量测口径必须恒定(padding-left 两态恒 46px 不参与)
    const { paddingRight, paddingBottom } = el.style
    el.style.paddingRight = '46px'
    el.style.paddingBottom = '10px'
    const singleStateH = el.scrollHeight
    el.style.paddingRight = paddingRight
    el.style.paddingBottom = paddingBottom
    setInputMulti(singleStateH > 55) // 单行态口径:1 行≈44、2 行≈67,55 居中分割
  }, [])
  useEffect(() => {
    classifyInput()
  }, [input, attachments, classifyInput])
  useEffect(() => {
    // 窗口缩放会改变折行数,一并重判
    window.addEventListener('resize', classifyInput)
    return () => window.removeEventListener('resize', classifyInput)
  }, [classifyInput])

  // 光标恢复(插入 @ 居民后):受控 textarea 先渲染新值再定位
  useEffect(() => {
    if (restoreCaretRef.current === null) return
    const pos = restoreCaretRef.current
    restoreCaretRef.current = null
    if (directoryRef.current) {
      directoryRef.current.focusAt(pos)
      return
    }
    const el = inputRef.current
    if (el) {
      el.focus()
      el.setSelectionRange(pos, pos)
    }
  }, [input])

  const mentionList = mention
    ? mentionCandidates
        .filter((c) => c.name.toLowerCase().includes(mention.query.toLowerCase()))
        .slice(0, 8)
    : []

  function refreshMention(): void {
    const el = inputRef.current
    if (composingRef.current) return
    const value = directoryRef.current?.text() ?? el?.value ?? input
    const caret = directoryRef.current?.caret() ?? el?.selectionStart ?? 0
    setMention(activeMention(value, caret))
    setMentionIndex(0)
  }

  function insertMention(name: string): void {
    const el = inputRef.current
    if (!mention) return
    const caret = directoryRef.current?.caret() ?? el?.selectionStart ?? input.length
    const next = `${input.slice(0, mention.start)}@${name} ${input.slice(caret)}`
    restoreCaretRef.current = mention.start + name.length + 2
    setMention(null)
    onInputChange(next)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement | HTMLDivElement>): void {
    if (e.nativeEvent.isComposing || composingRef.current) return
    // 附件原子删除(2026-10-30 评审):正文空时按 Backspace 整个删掉最后一个附件,
    // 普通附件名不会被逐字符删;目录引用由 DirectoryInput 按路径块处理
    if (!hasDirectories && e.key === 'Backspace' && input === '' && !mention && attachments.length > 0) {
      e.preventDefault()
      onAttachmentsChange(attachments.slice(0, -1))
      return
    }
    if (mention && mentionList.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % mentionList.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + mentionList.length) % mentionList.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(mentionList[mentionIndex]?.name ?? mentionList[0]!.name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    } else if (mention && e.key === 'Escape') {
      setMention(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLDivElement>): void {
    const { files, dirs } = filesFromDataTransfer(e.clipboardData)
    if (files.length === 0) return // 纯文本粘贴走默认行为
    e.preventDefault()
    e.stopPropagation()
    void intakeFiles(files, dirs)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    const { files, dirs } = filesFromDataTransfer(e.dataTransfer)
    if (files.length === 0) return // 纯文本拖放走浏览器默认(插入到光标处),不拦
    e.preventDefault()
    // 聊天视图根也是拖放区(体验反馈 2026-10-30):这里已收下就不再冒泡,同一份文件不双收
    e.stopPropagation()
    void intakeFiles(files, dirs)
  }

  // 空文本+零附件+零引用才禁发送(引用单独成条也算有效消息)
  const sendBlocked = sendDisabled || (!input.trim() && attachments.length === 0 && quoteRecord.quotes.length === 0)

  return (
    <div className="composer-main">
      <div
        className={`composer-inbox ${inputMulti ? 'multi' : ''} ${attachments.length > 0 ? 'has-atts' : ''}`}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={(e) => {
          // 只有拖的是文件才接管(允许 drop);纯文本拖放保持浏览器默认
          if (e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
      >
        {quoteKey && <QuoteStrip quoteKey={quoteKey} record={quoteRecord} />}
        {visualAttachments.length > 0 && (
          <div className="attach-strip">
            {visualAttachments.map((a) => (
              <AttachmentChip key={a.path} attachment={a} onRemove={() => onAttachmentsChange(attachments.filter((x) => x.path !== a.path))} />
            ))}
          </div>
        )}
        {mention && mentionList.length > 0 && (
          <div className="mention-pop" role="listbox">
            {mentionList.map((c, i) => (
              <button
                key={c.name}
                type="button"
                className={`mention-pop-item ${i === mentionIndex ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault() // 不让 textarea 失焦
                  insertMention(c.name)
                }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                @{c.name}
              </button>
            ))}
          </div>
        )}
        {hasDirectories ? <DirectoryInput
          ref={directoryRef}
          value={input}
          directories={directories}
          placeholder={placeholder}
          onChange={onInputChange}
          onOpen={(path) => { void api.revealInFolder(path) }}
          onRemove={(paths) => onAttachmentsChange(attachments.filter((a) => !paths.includes(a.path)))}
          onKeyDown={handleKeyDown}
          onCaret={refreshMention}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false; refreshMention() }}
        /> : <textarea
          ref={inputRef}
          value={input}
          readOnly={busy && attachmentMode === 'post'}
          rows={1}
          placeholder={placeholder}
          onChange={(e) => {
            onInputChange(e.target.value)
            refreshMention()
          }}
          onKeyUp={(e) => {
            // ↑↓ 在输入框内移动光标后查询串可能变化(如光标移进别的 @token),补一次判定
            if (!e.nativeEvent.isComposing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) refreshMention()
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
            refreshMention()
          }}
        />}
        <div className="composer-actions">
        <div className="attach-pick-wrap" ref={pickWrapRef}>
          <button
            className="icon-btn attach-btn"
            title={t('composer.attach')}
            disabled={intaking || (busy && attachmentMode === 'post')}
            onClick={() => {
              // Windows 原生对话框不支持混选(W4):弹二选一;mac 与邮局模式直接打开
              if (window.archipelago.platform === 'win32' && attachmentMode !== 'post') setPickMenuOpen((v) => !v)
              else void pickFiles()
            }}
          >
            {intaking ? <Loader2 size={14} className="spin" /> : <Paperclip size={15} />}
          </button>
          {pickMenuOpen && (
            <div className="row-menu attach-pick-menu">
              <button onClick={() => void pickFiles('file')}>
                <FileText size={13} /> {t('composer.pickFile')}
              </button>
              <button onClick={() => void pickFiles('dir')}>
                <Folder size={13} /> {t('composer.pickFolder')}
              </button>
            </div>
          )}
        </div>
        <span className="composer-action-spacer" />
        {busy && attachmentMode === 'post' ? (
          <span className="composer-sending" role="status"><Loader2 size={14} className="spin" />{t('post.sending')}</span>
        ) : busy ? (
          <button className="icon-btn stop" title={t('chat.stop')} onClick={onStop}>
            <Square size={13} />
          </button>
        ) : (
          <button className="icon-btn send" title={t('chat.send')} disabled={sendBlocked} onClick={onSend}>
            <Send size={14} />
          </button>
        )}
        </div>
      </div>
    </div>
  )
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** 输入框附件区单元(2026-10-30 评审改版):图片=缩略图方图(点开预览)、文件=图标+截断名小卡、
 * 文件夹=路径 chip(色底+等宽路径,点开 Finder 定位);统一右上 X 移除 */
function AttachmentChip({ attachment, onRemove }: { attachment: MessageAttachment; onRemove(): void }) {
  const { t } = useTranslation()
  if (attachment.kind === 'image' && attachment.thumb) {
    return (
      <span className="attach-thumb" title={attachment.path}>
        <button type="button" className="attach-thumb-main" onClick={() => void openFileSmart(attachment.path)}>
          <img src={attachment.thumb} alt={attachment.name} />
        </button>
        <button type="button" className="attach-thumb-x" title={t('composer.remove')} onClick={onRemove}>
          <X size={11} />
        </button>
      </span>
    )
  }
  if (attachment.kind === 'dir') {
    return (
      <span className="attach-path" title={attachment.path}>
        <button
          type="button"
          className="attach-path-main"
          onClick={() => void api.revealInFolder(attachment.path)}
        >
          <Folder size={12} />
          <span className="attach-path-text">{shortAttachmentPath(attachment.path)}</span>
        </button>
        <button type="button" className="attach-chip-x" title={t('composer.remove')} onClick={onRemove}>
          <X size={11} />
        </button>
      </span>
    )
  }
  return (
    <span className="attach-chip" title={attachment.path}>
      <button
        type="button"
        className="attach-chip-main"
        onClick={() => void api.revealInFolder(attachment.path)}
      >
        <FileText size={12} />
        <span className="attach-chip-copy"><span className="attach-chip-name">{shortAttachmentName(attachment.name)}</span><small>{attachment.name.split('.').pop()?.toUpperCase()}{attachment.size != null && ` · ${formatAttachmentSize(attachment.size)}`}</small></span>
      </button>
      <button type="button" className="attach-chip-x" title={t('composer.remove')} onClick={onRemove}>
        <X size={11} />
      </button>
    </span>
  )
}

/** 发送后的用户附件(2026-10-30 评审):图片缩略图/文件卡/文件夹路径 chip 各自成块,
 * 不再挤进绿色正文气泡——看上去就像连续发了「一张图、一个文件、一段文字」几条消息;
 * 数据仍是单条消息,纯渲染层拆分 */
export function UserAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  const atts = attachments ?? []
  if (atts.length === 0) return null
  const images = atts.filter((a) => a.kind === 'image' && a.thumb)
  const others = atts.filter((a) => !(a.kind === 'image' && a.thumb))
  return (
    <>
      {images.length > 0 && (
        <div className="msg-images">
          {images.map((a) => (
            <button key={a.path} type="button" className="msg-image" title={a.path} onClick={() => void openFileSmart(a.path)}>
              <img src={a.thumb} alt={a.name} />
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="msg-att-units">
          {others.map((a) =>
            a.kind === 'dir' ? (
              <button
                key={a.path}
                type="button"
                className="msg-att-path"
                title={a.path}
                onClick={() => void api.revealInFolder(a.path)}
              >
                <Folder size={13} />
                <span className="msg-att-path-text">{shortAttachmentPath(a.path)}</span>
              </button>
            ) : (
              <button
                key={a.path}
                type="button"
                className="msg-att-file"
                title={a.path}
                onClick={() => void openFileSmart(a.path)}
              >
                <FileText size={17} />
                <span className="attach-chip-copy"><span className="attach-card-name">{shortAttachmentName(a.name)}</span><small>{a.name.split('.').pop()?.toUpperCase()}{a.size != null && ` · ${formatAttachmentSize(a.size)}`}</small></span>
              </button>
            )
          )}
        </div>
      )}
    </>
  )
}

/** 信件附件卡(邮局信纸内沿用):小卡片一排;图片带缩略图点开内置查看器,.md 进内置阅读器(2026-11-06) */
export function AttachmentCards({ attachments }: { attachments: MessageAttachment[] }) {
  if (!attachments || attachments.length === 0) return null
  return (
    <div className="attach-cards">
      {attachments.map((a) =>
        a.kind === 'image' && a.thumb ? (
          <button key={a.path} type="button" className="attach-card image" title={a.path} onClick={() => void openFileSmart(a.path)}>
            <img src={a.thumb} alt={a.name} />
          </button>
        ) : (
          <button
            key={a.path}
            type="button"
            className="attach-card"
            title={a.path}
            onClick={() => void openFileSmart(a.path)}
          >
            {a.kind === 'dir' ? <Folder size={14} /> : <FileText size={14} />}
            <span className="attach-card-name">{shortAttachmentName(a.name)}</span>
          </button>
        )
      )}
    </div>
  )
}
