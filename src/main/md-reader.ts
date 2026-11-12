// 内置 Markdown 阅读器窗口(2026-11-06 拍板:独立窗口 + 纯只读)。
// 形态对齐主窗口(Mac hidden titlebar 红绿灯 / Windows frame:false 自绘三键),单例复用:
// 已开时新文件 = 广播 MdReaderLoad 替换内容;首开未就绪时路径排队,did-finish-load 后补发。
// 读取边界(参考 ZCode codeViewer.ts):仅 .md/.markdown、≤256KB、二进制嗅探,全部诚实报错。

import { BrowserWindow, shell } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { EV } from '@shared/ipc-channels'
import type { MdTextReadResult } from '@shared/types'
import { isMarkdownPath, looksBinary, MD_READER_TEXT_MAX_BYTES } from '@shared/md-reader-core'
import { metaGet, metaSet } from './store'
import { logDiag } from './diag'

// 平台分叉与主窗口同一口径;不 import index.ts 的 IS_MAC(ipc→md-reader→index 会成环,本地判定零成本)
const IS_MAC = process.platform === 'darwin'

const BOUNDS_KEY = 'md-reader-bounds'
const DEFAULT_BOUNDS = { width: 860, height: 640 }
const MIN_SIZE = { width: 520, height: 380 }

let readerWindow: BrowserWindow | null = null
/** 首开时渲染层尚未挂载,事件会丢:先排队,did-finish-load 后补发 */
let pendingPath: string | null = null

/** ~/ 前缀展开成绝对路径(正文 autolink 与选区打开会带来 ~ 形态;绝对路径原样)。
 *  供 ipc.ts 的 FilesOpen/FilesReveal 复用——shell.openPath/showItemInFolder 都不认 ~。 */
export function expandHomePath(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** 阅读器文本读取(IPC FilesReadText 的实现):只放行 .md,超限/二进制/errno 分家诚实回 reason */
export async function readTextForMdReader(rawPath: string): Promise<MdTextReadResult> {
  if (typeof rawPath !== 'string' || !rawPath) return { ok: false, reason: 'bad-path' }
  const path = expandHomePath(rawPath)
  if (!isMarkdownPath(path)) return { ok: false, reason: 'not-md' }

  let size: number
  let mtimeMs: number
  try {
    const st = await stat(path)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // errno 分家(同 FilesOpen 口径):ENOENT=真没了,其余 EACCES/EPERM 等=macOS 隐私墙,文件多半还在
    if (code === 'ENOENT') return { ok: false, reason: 'not-found' }
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: 'no-access', detail: code }
    return { ok: false, reason: 'not-found', detail: code }
  }

  if (size > MD_READER_TEXT_MAX_BYTES) return { ok: false, reason: 'too-large' }
  if (size === 0) return { ok: true, content: '', size, mtimeMs }

  try {
    const buf = await readFile(path)
    // 二进制嗅探:文件头含 NUL 即非文本(.md 正常内容不会出 \0)
    if (looksBinary(buf.subarray(0, 8192))) return { ok: false, reason: 'binary' }
    return { ok: true, content: buf.toString('utf8'), size, mtimeMs }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: 'no-access', detail: code }
    return { ok: false, reason: 'read-error', detail: code }
  }
}

/** IPC FilesReadText 的发送方收口:只有阅读器窗口的 webContents 能读本机文本(收窄渲染层读文件面) */
export function isMdReaderSender(sender: Electron.WebContents): boolean {
  return readerWindow !== null && readerWindow.webContents === sender
}

/** 把文件加载进阅读器:窗口就绪(pendingPath 已清)直发,未就绪排队(后到覆盖,只保最后一份) */
function dispatchLoad(path: string): void {
  if (readerWindow && pendingPath === null) {
    readerWindow.webContents.send(EV.MdReaderLoad, { path })
  } else {
    pendingPath = path
  }
}

/** 独立阅读器窗口(单例):点新文件复用同一窗,替换内容;~/ 形态先展开(面包屑/刷新/系统打开全程用绝对路径) */
export function openMdReader(rawPath: string): void {
  const path = expandHomePath(rawPath)
  if (readerWindow) {
    if (readerWindow.isMinimized()) readerWindow.restore()
    readerWindow.focus()
    dispatchLoad(path)
    return
  }

  // 记住上次大小与位置(文档场景值得有;最大化期间 getNormalBounds 拿的是还原尺寸,天然正确)
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
  readerWindow = win
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
    if (pendingPath && readerWindow === win) {
      win.webContents.send(EV.MdReaderLoad, { path: pendingPath })
      pendingPath = null
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loaded = devUrl
    ? win.loadURL(`${devUrl}/md-reader.html`)
    : win.loadFile(join(__dirname, '../renderer/md-reader.html'))
  loaded.catch((err: unknown) => {
    logDiag('md-reader-load-rejected', { message: err instanceof Error ? err.message : String(err) })
  })

  win.on('close', () => {
    // getNormalBounds():最大化时也存还原后的普通边界,下次开窗不继承最大化(文档窗口常态是非最大化)
    try {
      metaSet(BOUNDS_KEY, win.getNormalBounds())
    } catch {
      // 库不可用(理论上登录后才开得到阅读器)不拦关窗
    }
  })
  win.on('closed', () => {
    readerWindow = null
    pendingPath = null
  })
}
