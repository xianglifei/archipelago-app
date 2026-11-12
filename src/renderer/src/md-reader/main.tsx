import React from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '../i18n'
import MdReaderApp from './MdReaderApp'
import '../styles.css'
import '../markdown.css'
import './md-reader.css'

// 阅读器窗口第二入口(2026-11-06 只读拍板):与主入口同构——语言先行再挂载,首帧即正确语言
void initI18n().finally(() => {
  if (window.archipelago.platform === 'win32') document.documentElement.classList.add('platform-win')
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <MdReaderApp />
    </React.StrictMode>
  )
})
