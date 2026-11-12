import { Check, Copy, FileDown, ListChecks, X } from 'lucide-react'
import { useTranslation } from '../i18n'
import type { ExportStatus } from '../utils/useMessageExport'

// 对话多选导出的 header 操作条(2026-11-02):多选模式替换 chat-header 内容区;
// 成功后退出多选,header 以 ExportStatusNote 短驻展示结果(点「在 Finder 中显示」直达文件)。
// 按钮自带 -webkit-app-region: no-drag(.chat-header button 既有规则),不破坏窗口拖拽区。

export function ChatSelectionBar({
  selectedCount,
  allSelected,
  busy,
  error,
  onToggleAll,
  onCopy,
  onExport,
  onCancel
}: {
  selectedCount: number
  allSelected: boolean
  busy: boolean
  error: string | null
  onToggleAll: () => void
  onCopy: () => void
  onExport: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const empty = selectedCount === 0
  return (
    <div className="selection-bar">
      <span className="selection-count">{t('chat.exportCount', { n: selectedCount })}</span>
      <button type="button" className="chip" disabled={busy} aria-pressed={allSelected} onClick={onToggleAll}>
        <ListChecks size={13} />
        {t('chat.exportAll')}
      </button>
      {error && <span className="selection-error" title={error}>{error}</span>}
      <div className="selection-actions">
        <button type="button" className="btn" disabled={busy || empty} onClick={onCopy}>
          <Copy size={13} /> {t('chat.exportCopy')}
        </button>
        <button type="button" className="btn" disabled={busy || empty} onClick={onExport}>
          <FileDown size={13} /> {t('chat.exportBtn')}
        </button>
        <button
          type="button"
          className="icon-btn ghost-btn sm"
          disabled={busy}
          title={t('chat.exportCancel')}
          onClick={onCancel}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

/** 导出成功后的 header 短驻条:保存成功带「在 Finder 中显示」,复制成功一闪即过;叉可立即关 */
export function ExportStatusNote({
  status,
  onReveal,
  onClose
}: {
  status: NonNullable<ExportStatus>
  onReveal: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="selection-note">
      <Check size={14} />
      <span>{t(status.kind === 'saved' ? 'chat.exportSaved' : 'chat.exportCopied')}</span>
      {status.kind === 'saved' && (
        <button type="button" className="link-btn" onClick={onReveal}>
          {t('chat.exportReveal')}
        </button>
      )}
      <button type="button" className="icon-btn ghost-btn sm note-close" title={t('common.close')} onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  )
}
