import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import type { MessageAttachment } from '@shared/types'
import { useTranslation } from 'react-i18next'

export interface DirectoryInputHandle {
  text(): string
  caret(): number
  focusAt(offset: number): void
  element(): HTMLDivElement | null
}

// Directory references are indivisible DOM tokens, while the existing IPC contract keeps
// plain input and MessageAttachment[] separate. No directory contents are uploaded.
export const DirectoryInput = forwardRef<DirectoryInputHandle, {
  value: string
  directories: MessageAttachment[]
  placeholder: string
  onChange(text: string): void
  onRemove(paths: string[]): void
  onOpen(path: string): void
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void
  onCaret(): void
  onCompositionStart(): void
  onCompositionEnd(): void
}>(function DirectoryInput(props, ref) {
  const { t } = useTranslation()
  const root = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const callbacks = useRef(props)
  callbacks.current = props
  // Text offsets deliberately ignore tokens, so @ insertion uses the existing plain-text offsets.
  function textNodes(): Text[] {
    if (!root.current) return []
    const walker = document.createTreeWalker(root.current, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement?.closest('[data-directory]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    })
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    return nodes
  }
  function value(): string {
    return textNodes().map((node) => node.data).join('')
  }
  function caret(): number {
    const selection = window.getSelection()
    if (!selection?.rangeCount || !root.current?.contains(selection.anchorNode)) return value().length
    const range = selection.getRangeAt(0)
    let count = 0
    for (const node of textNodes()) {
      if (node === range.startContainer) return count + range.startOffset
      if (range.comparePoint(node, node.length) <= 0) count += node.length
    }
    return count
  }
  function focusAt(offset: number): void {
    const el = root.current
    if (!el) return
    el.focus()
    const range = document.createRange()
    let remaining = offset
    for (const node of textNodes()) {
      if (remaining <= node.length) {
        range.setStart(node, remaining)
        range.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return
      }
      remaining -= node.length
    }
    range.selectNodeContents(el)
    range.collapse(false)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  }
  useImperativeHandle(ref, () => ({ text: value, caret, focusAt, element: () => root.current }))
  useLayoutEffect(() => {
    const el = root.current
    if (!el || composing.current) return
    const focused = el.contains(document.activeElement)
    const offset = caret()
    const previous = value()
    if (previous !== props.value) {
      // Apply the changed text span without moving the surrounding directory tokens.
      let prefix = 0
      while (prefix < previous.length && prefix < props.value.length && previous[prefix] === props.value[prefix]) prefix++
      let suffix = 0
      while (suffix < previous.length - prefix && suffix < props.value.length - prefix && previous[previous.length - 1 - suffix] === props.value[props.value.length - 1 - suffix]) suffix++
      const end = previous.length - suffix
      const inserted = props.value.slice(prefix, props.value.length - suffix)
      const nodes = textNodes()
      let position = 0
      let placed = false
      for (const node of nodes) {
        const length = node.length
        const from = Math.max(0, Math.min(length, prefix - position))
        const to = Math.max(from, Math.min(length, end - position))
        const ownsInsertion = !placed && prefix >= position && prefix <= position + length
        node.data = node.data.slice(0, from) + (ownsInsertion ? inserted : '') + node.data.slice(to)
        if (ownsInsertion) placed = true
        position += length
      }
      if (!placed) el.append(document.createTextNode(inserted))
    }

    const paths = new Set(props.directories.map((a) => a.path))
    el.querySelectorAll<HTMLElement>('[data-directory]').forEach((node) => {
      if (!paths.has(node.dataset.directory!)) node.remove()
    })
    for (const directory of props.directories) {
      if (Array.from(el.querySelectorAll<HTMLElement>('[data-directory]')).some((node) => node.dataset.directory === directory.path)) continue
      const token = document.createElement('span')
      token.contentEditable = 'false'
      token.setAttribute('role', 'group')
      token.tabIndex = 0
      token.addEventListener('click', () => callbacks.current.onOpen(directory.path))
      token.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          callbacks.current.onOpen(directory.path)
        } else if (event.key === 'Backspace' || event.key === 'Delete') {
          event.preventDefault()
          event.stopPropagation()
          callbacks.current.onRemove([directory.path])
        }
      })
      token.className = 'composer-directory-token'
      token.dataset.directory = directory.path
      token.title = directory.path
      const label = document.createElement('span')
      label.className = 'composer-directory-label'
      label.textContent = directory.path
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'composer-directory-remove'
      remove.textContent = '×'
      remove.setAttribute('aria-label', t('composer.remove'))
      remove.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        callbacks.current.onRemove([directory.path])
      })
      remove.addEventListener('keydown', (event) => event.stopPropagation())
      token.append(label, remove)
      el.append(token, document.createTextNode(''))
    }
    el.querySelectorAll('.composer-directory-remove').forEach((button) => button.setAttribute('aria-label', t('composer.remove')))
    // Browsers can leave a placeholder <br> in an empty editable; our model uses explicit newlines.
    el.querySelectorAll('br').forEach((node) => node.remove())
    if (focused) focusAt(offset)
    // 依赖数组是「何时重放 DOM 同步」的触发器清单;caret/value/focusAt 是读 DOM 实时态的组件内工具函数,
    // 身份每渲染都变、行为恒定,入依赖会让 contenteditable 在输入中反复重放导致光标跳动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value, props.directories, t])

  function keyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing || composing.current) return
    const selection = window.getSelection()
    if ((event.key === 'Backspace' || event.key === 'Delete') && selection?.rangeCount) {
      const range = selection.getRangeAt(0)
      const tokens = Array.from(root.current!.querySelectorAll<HTMLElement>('[data-directory]'))
      const selected = tokens.filter((node) => !range.collapsed && range.intersectsNode(node))
      const container = range.startContainer
      let adjacent: Node | null | undefined = container.nodeType === Node.TEXT_NODE
        ? event.key === 'Backspace' && range.startOffset === 0 ? container.previousSibling
          : event.key === 'Delete' && range.startOffset === container.textContent!.length ? container.nextSibling : null
        : container.childNodes[range.startOffset + (event.key === 'Backspace' ? -1 : 0)]
      while (adjacent?.nodeType === Node.TEXT_NODE && !adjacent.textContent) {
        adjacent = event.key === 'Backspace' ? adjacent.previousSibling : adjacent.nextSibling
      }
      if (selected.length) {
        event.preventDefault()
        range.deleteContents()
        props.onChange(value())
        props.onRemove(selected.map((node) => node.dataset.directory!))
        return
      }
      const token = selected[0] ?? (adjacent instanceof HTMLElement && adjacent.dataset.directory ? adjacent : null)
      if (token) {
        event.preventDefault()
        props.onRemove([token.dataset.directory!])
        return
      }
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      document.execCommand('insertText', false, '\n')
      props.onChange(value())
      return
    }
    props.onKeyDown(event)
  }
  return <div
    ref={root}
    className="composer-directory-input"
    contentEditable
    suppressContentEditableWarning
    role="textbox"
    aria-multiline="true"
    aria-label={props.placeholder}
    onInput={() => {
      props.onChange(value())
      const missing = props.directories.filter((item) => !Array.from(root.current!.querySelectorAll<HTMLElement>('[data-directory]')).some((node) => node.dataset.directory === item.path))
      if (missing.length) props.onRemove(missing.map((item) => item.path))
      props.onCaret()
    }}
    onKeyDown={keyDown}
    onKeyUp={props.onCaret}
    onClick={props.onCaret}
    onPaste={(event) => {
      // File paste bubbles into the same existing intake path. Plain text is never pasted as HTML.
      if (Array.from(event.clipboardData.items).some((item) => item.kind === 'file')) return
      event.preventDefault()
      document.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
    }}
    onDrop={(event) => {
      if (event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      document.execCommand('insertText', false, event.dataTransfer.getData('text/plain'))
    }}
    onCompositionStart={() => { composing.current = true; props.onCompositionStart() }}
    onCompositionEnd={() => { composing.current = false; props.onChange(value()); props.onCompositionEnd() }}
  />
})
