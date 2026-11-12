import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initI18n } from './i18n'
import './styles.css'
import './markdown.css'
import './design-refinements.css'

// 语言先行:取主进程机器级语言初始化 i18next 后再挂载,首帧(登录屏/向导)即是正确语言,无闪烁
void initI18n().finally(() => {
  // 平台标志挂 html 根:Windows overlay 三键在右上,渲染层用 .platform-win 做让位/隐藏红绿灯占位
  if (window.archipelago.platform === 'win32') document.documentElement.classList.add('platform-win')
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})
