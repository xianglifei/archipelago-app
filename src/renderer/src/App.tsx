import { useEffect, useState } from 'react'
import { Waves } from 'lucide-react'
import type { BootState } from '@shared/types'
import { api, onAuthChanged } from './api'
import { useTranslation } from './i18n'
import Wizard from './screens/Wizard'
import MainScreen from './screens/MainScreen'
import LoginScreen from './components/LoginScreen'
import { WinControls } from './components/NavRail'
import AvatarAtlas from './components/AvatarAtlas'

export default function App() {
  const { t } = useTranslation()
  // dev 自检页:?avatar-atlas 直接渲染头像图鉴,不启动应用(api.boot 也不发)
  const showAtlas =
    import.meta.env.DEV && new URLSearchParams(location.search).has('avatar-atlas')
  const [boot, setBoot] = useState<BootState | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // 登录门(0.8):登出事件 → 整屏切登录页,主界面连同一切状态卸载
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    if (showAtlas) return
    api
      .boot()
      .then(setBoot)
      .catch((err) => setFailed(err instanceof Error ? err.message : String(err)))
    return onAuthChanged((e) => {
      if (!e.state) setLocked(true)
    })
  }, [showAtlas])

  if (showAtlas) return <AvatarAtlas />

  if (failed) {
    return (
      <div className="splash">
        <Waves size={40} className="splash-icon" />
        <p className="splash-error">{t('common.bootFailed', { msg: failed })}</p>
      </div>
    )
  }

  if (!boot) {
    return (
      <div className="splash">
        <Waves size={40} className="splash-icon" />
      </div>
    )
  }

  if (boot.gate === 'login' || locked) {
    return (
      <>
        {/* 方案 C(2026-11-04):登录屏无导航栏,Windows frameless 下自绘三键挂 fixed 左上,
            与主界面 NavRail 顶部同位(x:11,高 38px) */}
        {window.archipelago.platform === 'win32' && (
          <div className="win-controls-fixed">
            <WinControls />
          </div>
        )}
        <LoginScreen />
      </>
    )
  }
  if (!boot.wizardDone) return <Wizard onDone={setBoot} />
  return <MainScreen initialBoot={boot} />
}
