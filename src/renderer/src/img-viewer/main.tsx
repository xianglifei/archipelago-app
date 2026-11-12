import React from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '../i18n'
import ImgViewerApp from './ImgViewerApp'
import '../styles.css'
import './img-viewer.css'

// 图片查看器窗口第三入口(2026-11-06 拍板):与 md-reader 入口同构——语言先行再挂载,首帧即正确语言
void initI18n().finally(() => {
  if (window.archipelago.platform === 'win32') document.documentElement.classList.add('platform-win')
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ImgViewerApp />
    </React.StrictMode>
  )
})
