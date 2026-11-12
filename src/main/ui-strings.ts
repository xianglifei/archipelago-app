// 主进程侧界面文案(2026-10-30 双语):应用菜单/错误对话框/About/系统通知。
// 与渲染端词典(src/renderer/src/i18n)分居两进程——这里只有主进程直接出的那一小撮 UI 件。
import { getUiLanguage } from './ui-language'

type Dict = Record<string, string>

const ZH: Dict = {
  appName: '群岛',
  bootErrorTitle: '群岛启动遇到问题',
  about: '关于群岛',
  preferences: '偏好设置…',
  services: '服务',
  hideApp: '隐藏群岛',
  hideOthers: '隐藏其他',
  unhide: '全部显示',
  quit: '退出群岛',
  menuFile: '文件',
  closeWindow: '关闭窗口',
  menuEdit: '编辑',
  undo: '撤销',
  redo: '重做',
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
  menuView: '显示',
  reload: '重新加载',
  devTools: '开发者工具',
  actualSize: '实际大小',
  zoomIn: '放大',
  zoomOut: '缩小',
  fullscreen: '全屏',
  menuWindow: '窗口',
  minimize: '最小化',
  zoom: '缩放',
  bringAllToFront: '全部置于前',
  approvalNotify: '{{name}} 请求审批',
  exportEmpty: '没有可导出的消息',
  exportSaveTitle: '保存导出的对话',
  exportWriteFailed: '未能保存导出的文件，请重试。',
  exportTooLarge: '导出内容过大(超过 50MB),请减少选中的图片。',
  postSaveQrTitle: '保存邀请函二维码',
  postSaveQrFailed: '未能保存二维码，请重试。',
  postCopyImageFailed: '复制图片失败,请重试',
  postInviteIslandChanged: '岛已切换，请重新生成邀请函。',
  postNotifyTitle: '群岛邮局',
  postNotifyBody: '{{name}} 来信了',
  pickMixedTitle: '选择要发给居民的文件或文件夹',
  pickFileTitle: '选择要发给居民的文件',
  pickFolderTitle: '选择要发给居民的文件夹'
}

const EN: Dict = {
  appName: 'Archipelago',
  bootErrorTitle: 'Archipelago failed to start',
  about: 'About Archipelago',
  preferences: 'Preferences…',
  services: 'Services',
  hideApp: 'Hide Archipelago',
  hideOthers: 'Hide Others',
  unhide: 'Show All',
  quit: 'Quit Archipelago',
  menuFile: 'File',
  closeWindow: 'Close Window',
  menuEdit: 'Edit',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
  menuView: 'View',
  reload: 'Reload',
  devTools: 'Developer Tools',
  actualSize: 'Actual Size',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  fullscreen: 'Toggle Full Screen',
  menuWindow: 'Window',
  minimize: 'Minimize',
  zoom: 'Zoom',
  bringAllToFront: 'Bring All to Front',
  approvalNotify: '{{name}} needs your approval',
  exportEmpty: 'No messages to export',
  exportSaveTitle: 'Save exported conversation',
  exportWriteFailed: 'Could not save the exported file. Please try again.',
  exportTooLarge: 'The export is too large (over 50 MB). Please select fewer images.',
  postSaveQrTitle: 'Save invitation QR code',
  postSaveQrFailed: 'Could not save the QR code. Please try again.',
  postCopyImageFailed: 'Could not copy the image. Please try again.',
  postInviteIslandChanged: 'The island changed. Please create the invitation again.',
  postNotifyTitle: 'Archipelago Post',
  postNotifyBody: 'A letter from {{name}}',
  pickMixedTitle: 'Choose files or folders to send',
  pickFileTitle: 'Choose files to send',
  pickFolderTitle: 'Choose folders to send'
}

/** 取当前界面语言的一条主进程文案 */
export function uiStr(key: string, params?: Record<string, string | number>): string {
  const dict = getUiLanguage() === 'en' ? EN : ZH
  let out = dict[key] ?? ZH[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{{${k}}}`, String(v))
  }
  return out
}
