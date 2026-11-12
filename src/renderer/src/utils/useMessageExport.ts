import { useEffect, useState } from 'react'
import { api } from '../api'
import { copyText } from './clipboard'

// 对话多选导出(2026-11-02):单聊/群聊共用的一条多选模式状态机。
// selecting/selectedIds 是组件本地态(对齐 quoteStore 的内存态定位),切会话即随组件卸载清空;
// md 拼装在主进程(数据权威),这里只管勾选与动作;保存成功/复制成功以 header 成功条短驻展示。
// Escape 退出多选——与审批决策面板的 Esc=拒绝互斥:多选模式开着时审批键盘让位(ChatView 侧守卫)。

export type ExportStatus = { kind: 'saved'; path: string } | { kind: 'copied' } | null

export function useMessageExport(scope: { botId: string } | { groupId: string } | { threadId: string }): {
  selecting: boolean
  selectedIds: Set<number>
  busy: boolean
  error: string | null
  status: ExportStatus
  dismissStatus: () => void
  enter: () => void
  exit: () => void
  toggle: (id: number) => void
  selectAll: (ids: number[]) => void
  run: (mode: 'save' | 'copy') => Promise<void>
} {
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<ExportStatus>(null)

  function exit(): void {
    setSelecting(false)
    setSelectedIds(new Set())
    setError(null)
  }

  // Escape 退出多选(exit 全是 setState,陈旧闭包安全)
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        exit()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selecting])

  // 成功条短驻:保存/复制统一 2s(实机定稿),叉可手动立即关
  useEffect(() => {
    if (!status) return
    const id = setTimeout(() => setStatus(null), 2000)
    return () => clearTimeout(id)
  }, [status])

  async function run(mode: 'save' | 'copy'): Promise<void> {
    if (busy || selectedIds.size === 0) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const result = await api.chatExport({ ...scope, messageIds: [...selectedIds], mode })
      if (mode === 'copy') {
        await copyText(result.markdown ?? '')
        setStatus({ kind: 'copied' })
        exit()
      } else if (result.saved) {
        // 用户取消保存对话框则留在多选模式继续调整;保存成功收尾退出
        if (result.path) setStatus({ kind: 'saved', path: result.path })
        exit()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return {
    selecting,
    selectedIds,
    busy,
    error,
    status,
    dismissStatus: () => setStatus(null),
    enter: () => {
      setSelecting(true)
      setSelectedIds(new Set())
      setError(null)
    },
    exit,
    toggle: (id: number) => {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    selectAll: (ids: number[]) => setSelectedIds(new Set(ids)),
    run
  }
}
