import { app, BrowserWindow, Menu, shell, dialog, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { EV } from '@shared/ipc-channels'
import { registerIpc } from './ipc'
import { initUpdater } from './updater'
import { initTaskScheduler } from './tasks'
import { initPostPoller } from './post'
import { logDiag } from './diag'
import { uiStr } from './ui-strings'
import { onUiLanguageChanged } from './ui-language'
import { closeAllMcp } from './mcp-manager'

// dev 模式下宿主是 node_modules 里的 Electron.app,不设置的话菜单栏/通知/数据目录都会挂在 "Electron" 名下
app.setName('群岛')

// 平台分叉总开关:Mac 是完整形态;Windows 首版(2026-11-03)差异集中在窗口三键/菜单/更新器/终端
export const IS_MAC = process.platform === 'darwin'

// Windows 通知必须设 AppUserModelId,否则 Notification 静默不弹(与 build.appId 一致)
if (!IS_MAC) app.setAppUserModelId('io.feixing.archipelago')

logDiag('main-loaded', {
  version: app.getVersion(),
  packaged: app.isPackaged,
  arch: process.arch,
  macos: process.getSystemVersion(),
  argv: process.argv
})

let mainWindow: BrowserWindow | null = null
let windowShown = false
let gpuRelaunchDone = false

/** 窗口只经此口显示,便于记录它最终是怎么出来的(ready-to-show / 兜底超时 / 失败路径) */
function showMainWindow(source: string): void {
  if (!mainWindow || windowShown) return
  windowShown = true
  mainWindow.show()
  logDiag('window-shown', { source })
}

/**
 * 窗口显示前渲染进程就崩溃:多为老机型/老系统上 GPU 初始化失败,首帧永远出不来,
 * 表现为 Dock 无限弹跳。带 --disable-gpu 重启一次(只重试一次,避免循环)。
 */
function relaunchWithGpuDisabled(): void {
  if (gpuRelaunchDone || process.argv.includes('--disable-gpu')) return
  gpuRelaunchDone = true
  logDiag('relaunch-with-disable-gpu')
  app.relaunch({ args: [...process.argv.slice(1), '--disable-gpu'] })
  app.exit(0)
}

/** 自建应用菜单:中文化,替换 Electron 英文默认菜单(含生产环境暴露的开发者工具)。
 *  Windows 不设菜单(服务/hide 等 role 均为 macOS-only,菜单栏还会与 overlay 三键打架);
 *  编辑快捷键(复制/粘贴等)由 Chromium 在输入框原生处理,不依赖菜单。 */
function setupAppMenu(): void {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null)
    return
  }
  const isDev = !app.isPackaged
  const template: MenuItemConstructorOptions[] = [
    {
      label: uiStr('appName'),
      submenu: [
        { role: 'about', label: uiStr('about') },
        { type: 'separator' },
        {
          label: uiStr('preferences'),
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send(EV.OpenSettings)
        },
        { type: 'separator' },
        { role: 'services', label: uiStr('services') },
        { type: 'separator' },
        { role: 'hide', label: uiStr('hideApp') },
        { role: 'hideOthers', label: uiStr('hideOthers') },
        { role: 'unhide', label: uiStr('unhide') },
        { type: 'separator' },
        { role: 'quit', label: uiStr('quit') }
      ]
    },
    {
      label: uiStr('menuFile'),
      submenu: [{ role: 'close', label: uiStr('closeWindow') }]
    },
    {
      label: uiStr('menuEdit'),
      submenu: [
        { role: 'undo', label: uiStr('undo') },
        { role: 'redo', label: uiStr('redo') },
        { type: 'separator' },
        { role: 'cut', label: uiStr('cut') },
        { role: 'copy', label: uiStr('copy') },
        { role: 'paste', label: uiStr('paste') },
        { role: 'selectAll', label: uiStr('selectAll') }
      ]
    },
    {
      label: uiStr('menuView'),
      submenu: [
        { role: 'reload', label: uiStr('reload'), visible: isDev },
        { role: 'toggleDevTools', label: uiStr('devTools'), visible: isDev },
        { type: 'separator', visible: isDev },
        { role: 'resetZoom', label: uiStr('actualSize') },
        { role: 'zoomIn', label: uiStr('zoomIn') },
        { role: 'zoomOut', label: uiStr('zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: uiStr('fullscreen') }
      ]
    },
    {
      label: uiStr('menuWindow'),
      submenu: [
        { role: 'minimize', label: uiStr('minimize') },
        { role: 'zoom', label: uiStr('zoom') },
        { type: 'separator' },
        { role: 'front', label: uiStr('bringAllToFront') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  windowShown = false
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 600,
    show: false,
    // 平台分叉(2026-11-04 拍板方案 C):Mac 红绿灯在左(系统绘制,84px 导航栏内);
    // Windows 全无边框 frame:false + 渲染层自绘 ─ □ × 三键放左上同一位置(NavRail 顶部 38px 占位)
    // ——与 Mac 版视觉完全一致,右上一片干净不再盖内容;代价=失去 Win11 Snap Layouts 悬停
    // (Windows 肌肉记忆的取舍由 Felix 拍板),双击拖拽区最大化/Win+方向键分屏仍可用。
    // thickFrame 默认 true,frameless 仍有系统 resize 边框与 Win11 圆角。
    ...(IS_MAC
      ? {
          // 'hidden' 而非 'hiddenInset':trafficLightPosition 只在 hidden(或 customButtonsOnHover)下生效,
          // 配 hiddenInset 会被静默忽略(实测三键落回系统默认 x≈20,越过窄导航栏右缘)
          titleBarStyle: 'hidden' as const,
          // 红绿灯三键实测几何(macOS 27,2x 屏像素级量得):单键 16px × 3 + 间距 7.5×2 ≈ 62px 组宽——
          // 并非原型假设的 12px/52px。取整配 84px 导航栏:x:11 → 左右边距各 ≈11px 对称;
          // 垂直中心 20px(y:14)与侧栏岛名行同中心线(2026-10-28 导航栏方案)
          trafficLightPosition: { x: 11, y: 14 }
        }
      : {
          frame: false
        }),
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => showMainWindow('ready-to-show'))

  // 最大化状态广播(2026-11-04 方案 C:Windows 自绘三键 □/❐ 图标切换);Mac 无自绘键也广播,无害
  const broadcastMaximized = (): void => {
    if (!mainWindow) return
    mainWindow.webContents.send(EV.WindowMaximized, mainWindow.isMaximized())
  }
  mainWindow.on('maximize', broadcastMaximized)
  mainWindow.on('unmaximize', broadcastMaximized)

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logDiag('render-process-gone', details)
    if (!windowShown) relaunchWithGpuDisabled()
  })
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, url, isMainFrame) => {
    logDiag('did-fail-load', { errorCode, errorDescription, url, isMainFrame })
    // 主帧加载失败也把窗口亮出来:白屏 + 日志可比无限弹跳好定位
    if (isMainFrame) showMainWindow('did-fail-load')
  })

  // 外链一律用系统浏览器打开,不在应用内开新窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL'] ?? ''
    if (dev && url.startsWith(dev)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loaded = devUrl
    ? mainWindow.loadURL(devUrl)
    : mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  loaded
    .then(() => logDiag('load-settled'))
    .catch((err: unknown) => {
      logDiag('load-rejected', {
        message: err instanceof Error ? err.message : String(err)
      })
      showMainWindow('load-rejected')
    })

  // ready-to-show 兜底:渲染/GPU 卡住时 5 秒后强制亮窗,不再无限 Dock 弹跳
  setTimeout(() => {
    if (!windowShown) showMainWindow('timeout-fallback')
  }, 5_000)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// 子进程(GPU/网络服务等)退出原因,只记录不干预
app.on('child-process-gone', (_e, details) => logDiag('child-process-gone', details))

process.on('uncaughtException', (err) => {
  logDiag('uncaught-exception', { message: err.message, stack: err.stack })
  // 启动早期失败要有可见反馈,否则就是无提示的僵尸进程
  if (!windowShown) {
    dialog.showErrorBox(uiStr('bootErrorTitle'), `${err.message}\n\n${err.stack ?? ''}`)
  }
})
process.on('unhandledRejection', (reason) => {
  logDiag('unhandled-rejection', { reason: String(reason) })
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 拿不到锁只退出,不再继续往下跑启动流程(旧代码 quit 后仍会执行完整个模块)
  app.quit()
} else {
  app.whenReady().then(() => {
    logDiag('app-ready')

    // Dock 图标,替换 Electron 默认图标(打包后的 .app 由 build/icon.icns 提供)
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'resources/icon.png')
      : join(__dirname, '../../resources/icon.png')
    app.dock?.setIcon(iconPath)

    const applyAbout = (): void => {
      // 关于面板:不设 version 字段,避免露出 Electron/Chromium/Node 技术栈(仅 macOS 有此面板)
      if (!IS_MAC) return
      app.setAboutPanelOptions({
        applicationName: uiStr('appName'),
        applicationVersion: app.getVersion(),
        copyright: `Copyright © 2026 ${uiStr('appName')}`
      })
    }
    applyAbout()
    // 双语(2026-10-30):界面语言切换 → 菜单与 About 面板按新语言重建
    onUiLanguageChanged(() => {
      setupAppMenu()
      applyAbout()
    })

    setupAppMenu()
    registerIpc()
    createWindow()
    logDiag('window-created')
    initUpdater()
    // 定时任务调度器(2026-10-29):每分钟扫一次;登录门前/登出后每轮静默,挂载后自动恢复
    initTaskScheduler()
    // 邮局轮询器(2026-10-29):120s 拉一次信箱 + 唤醒/聚焦补拉;未登录/未绑岛静默
    initPostPoller()

    app.on('activate', () => {
      // 判主窗自身而非全窗口数(2026-11-06 codex 审查修复):md 阅读器/图片查看器等独立窗
      // 还开着时,全窗口数不为 0,主窗关闭后点 Dock 图标将永远打不开主界面
      if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    })
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    logDiag('ready-failed', { message, stack: err instanceof Error ? err.stack : undefined })
    dialog.showErrorBox(uiStr('bootErrorTitle'), `${message}\n\n${err instanceof Error ? err.stack ?? '' : ''}`)
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  // MCP 连接器(2026-11-06):退出时关全部连接、杀 stdio 子进程(close 内部同步 kill,尽力而为)
  void closeAllMcp()
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})
