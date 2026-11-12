import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../../utils/clipboard'
import { useTranslation } from '../../i18n'

// 消息操作条:hover 淡入,最后一条消息常显(业界惯例:桌面 hover 显示、流式中不显示)
export function MessageActions({ text, always = false }: { text: string; always?: boolean }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  function copy(): void {
    void copyText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className={`msg-actions${always ? ' show' : ''}`}>
      <button className="msg-action-btn" onClick={copy} title={t('common.copyMsg')}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? t('common.copied') : t('common.copy')}</span>
      </button>
    </div>
  )
}
