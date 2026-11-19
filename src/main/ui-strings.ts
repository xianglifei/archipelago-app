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
  pickFolderTitle: '选择要发给居民的文件夹',
  // 看板(2026-11-19 需求 - 看板):主进程发出的仅四条——收尾提示词默认值(prompt 档)、
  // 智能「完成之后」的合并收尾指令(smart 档,dsh mergePrompt 群岛化:经岛主点「完成」
  // 授权才用 git -C 越过工作树操作岛主仓库根)、未命名兜底、回合失败角标文案
  boardFinishPromptDefault: '请收尾这件事:简述结果、列出交付或产出、说明未尽事项与建议,然后停下。',
  boardFinishSmartPrompt:
    '请把「{{title}}」在任务分支上的改动合并回基点分支并收尾(Merge this branch back and clean up):\n' +
    '- 岛主仓库根:{{repoRoot}}(在你的工作树之外;本次收尾经岛主点「完成」明确授权,可用 git -C {{repoRoot}} 操作)\n' +
    '- 你的任务分支:{{branch}}(检出:{{worktree}});基点分支:{{base}}(起点 {{baseCommit}})\n' +
    '\n' +
    '1. 先把工作树里未提交的改动提交到任务分支;\n' +
    '2. 用 git -C {{repoRoot}} 确认 {{base}} 已检出、工作区干净;不干净就停下来告诉我,别强合;\n' +
    '3. git -C {{repoRoot}} merge --no-ff {{branch}};有冲突就停,把冲突文件告诉我,别强推、别 rebase;\n' +
    '4. 合并成功后跑一下相关的测试或自检;\n' +
    '5. 清理:git -C {{repoRoot}} worktree remove {{worktree}}(要求工作树干净,失败就说明并停下),再 git -C {{repoRoot}} branch -d {{branch}};最后移除的是你自己的工作目录,之后不必再跑命令;\n' +
    '6. 用一两句话汇报:合入了哪个分支、合并提交、分支是否已删、未尽事项。',
  boardCardUntitled: '未命名卡片',
  boardTurnFailed: '这一轮没有跑成,进会话看原因。'
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
  pickFolderTitle: 'Choose folders to send',
  boardFinishPromptDefault:
    'Please wrap this up: summarize the outcome, list what was delivered, note anything left over, then stop.',
  boardFinishSmartPrompt:
    'Please merge the changes of "{{title}}" from its task branch back into the base branch and wrap up (Merge this branch back and clean up):\n' +
    '- Owner repo root: {{repoRoot}} (outside your worktree; this wrap-up is authorized by the owner clicking done, use git -C {{repoRoot}})\n' +
    '- Your task branch: {{branch}} (checkout: {{worktree}}); base branch: {{base}} (from {{baseCommit}})\n' +
    '\n' +
    '1. Commit any uncommitted changes in your worktree to the task branch;\n' +
    '2. Use git -C {{repoRoot}} to confirm {{base}} is checked out and clean; if not, stop and tell me, do not force anything;\n' +
    '3. git -C {{repoRoot}} merge --no-ff {{branch}}; on conflicts stop and list the files, never force-push or rebase;\n' +
    '4. After merging, run relevant tests or self-checks;\n' +
    '5. Clean up: git -C {{repoRoot}} worktree remove {{worktree}} (requires a clean worktree; if it fails, stop and explain), then git -C {{repoRoot}} branch -d {{branch}}; this removes your own working directory, no more commands after it;\n' +
    '6. Report in a sentence or two: which branch it merged into, the merge commit, whether the branch was deleted, anything left over.',
  boardCardUntitled: 'Untitled card',
  boardTurnFailed: 'The last turn failed; open the session to see why.'
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
