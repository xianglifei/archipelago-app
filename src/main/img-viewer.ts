// 内置图片查看器窗口(2026-11-06 拍板:独立单例窗 + 原样字节原图 + 适应窗口默认缩放)。
// 壳完全镜像 md-reader.ts(已被验收的窗口生命周期代码):单例复用(点新图=广播替换内容)、
// 边界记忆、首开未就绪排队补发、安全边界同口径。读取在 attachments.ts readImageFullForViewer,
// 原图由查看器窗口渲染层自行经 ImageReadFull 拉取(主进程只发路径,保持 md-reader 同构)。

import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { EV } from '@shared/ipc-channels'
import { metaGet, metaSet } from './store'
import { logDiag } from './diag'
import { expandHomePath } from './md-reader'

// 平台分叉与主窗口同一口径(不 import index.ts 的 IS_MAC,理由同 md-reader.ts:避免成环)
const IS_MAC = process.platform === 'darwin'

const BOUNDS_KEY = 'img-viewer-bounds'
const DEFAULT_BOUNDS = { width: 960, height: 680 }
const MIN_SIZE = { width: 420, height: 320 }

let viewerWindow: BrowserWindow | null = null
/** 首开时渲染层尚未挂载,事件会丢:先排队,did-finish-load 后补发 */
let pendingPath: string | null = null

/** IPC ImageReadFull 的发送方收口:只有查看器窗口的 webContents 能读全分辨率原图(收窄渲染层读文件面) */
export function isImgViewerSender(sender: Electron.WebContents): boolean {
  return viewerWindow !== null && viewerWindow.webContents === sender
}

/** 把图片加载进查看器:窗口就绪(pendingPath 已清)直发,未就绪排队(后到覆盖,只保最后一份) */
function dispatchLoad(path: string): void {
  if (viewerWindow && pendingPath === null) {
    viewerWindow.webContents.send(EV.ImgViewerLoad, { path })
  } else {
    pendingPath = path
  }
}

/** 独立查看器窗口(单例):点新图复用同一窗,替换内容;~/ 形态先展开(面包屑/刷新/系统打开全程用绝对路径) */
export function openImgViewer(rawPath: string): void {
  const path = expandHomePath(rawPath)
  if (viewerWindow) {
    if (viewerWindow.isMinimized()) viewerWindow.restore()
    viewerWindow.focus()
    dispatchLoad(path)
    return
  }

  // 记住上次大小与位置(图片窗口与阅读器各自记忆,互不挤占)
  const saved = metaGet<{ x: number; y: number; width: number; height: number }>(BOUNDS_KEY)
  const win = new BrowserWindow({
    ...(saved ?? DEFAULT_BOUNDS),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    ...(IS_MAC
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 11, y: 14 } }
      : { frame: false }),
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })
  viewerWindow = win
  pendingPath = path

  win.once('ready-to-show', () => win.show())
  // ready-to-show 兜底(同主窗口口径):渲染卡住时 5 秒后强制亮窗,不做无反馈的点击
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }, 5_000)

  // 安全边界对齐主窗口:外链一律系统浏览器,不开新窗;导航只许本应用页面
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL'] ?? ''
    if (dev && url.startsWith(dev)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
  })

  // 渲染层挂载完成才补发排队路径(此前 send 会落空)
  win.webContents.on('did-finish-load', () => {
    if (pendingPath && viewerWindow === win) {
      win.webContents.send(EV.ImgViewerLoad, { path: pendingPath })
      pendingPath = null
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loaded = devUrl
    ? win.loadURL(`${devUrl}/img-viewer.html`)
    : win.loadFile(join(__dirname, '../renderer/img-viewer.html'))
  loaded.catch((err: unknown) => {
    logDiag('img-viewer-load-rejected', { message: err instanceof Error ? err.message : String(err) })
  })

  win.on('close', () => {
    // getNormalBounds():最大化时也存还原后的普通边界,下次开窗不继承最大化
    try {
      metaSet(BOUNDS_KEY, win.getNormalBounds())
    } catch {
      // 库不可用(理论上登录后才开得到查看器)不拦关窗
    }
  })
  win.on('closed', () => {
    viewerWindow = null
    pendingPath = null
  })
}
