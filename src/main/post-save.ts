import { clipboard, ClipboardItem, dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { uiStr } from './ui-strings'

export async function postSaveInviteQr(dataUrl: string): Promise<{ saved: boolean }> {
  if (typeof dataUrl !== 'string' || dataUrl.length > 1024 * 1024 || !dataUrl.startsWith('data:image/png;base64,')) throw new Error(uiStr('postSaveQrFailed'))
  const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
  if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(uiStr('postSaveQrFailed'))
  const result = await dialog.showSaveDialog({ title: uiStr('postSaveQrTitle'), defaultPath: 'archipelago-invite.png', filters: [{ name: 'PNG', extensions: ['png'] }] })
  if (result.canceled || !result.filePath) return { saved: false }
  try { writeFileSync(result.filePath, bytes); return { saved: true } }
  catch { throw new Error(uiStr('postSaveQrFailed')) }
}

/** 复制邀请函分享图到系统剪贴板(2026-11-03):微信里直接粘贴;校验与保存同款(PNG 前缀+magic bytes) */
export async function postCopyInviteImage(dataUrl: string): Promise<{ copied: boolean }> {
  if (typeof dataUrl !== 'string' || dataUrl.length > 4 * 1024 * 1024 || !dataUrl.startsWith('data:image/png;base64,')) throw new Error(uiStr('postCopyImageFailed'))
  // Electron 44:clipboard 走 W3C 风格 ClipboardItem(旧 writeImage 已移除)
  const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
  if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(uiStr('postCopyImageFailed'))
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)]) })])
  return { copied: true }
}
