// 内置 Markdown 阅读器(2026-11-06 拍板:独立窗口 + 纯只读):md 判定与读取边界的纯函数,
// 渲染层(入口分流)与主进程(读取校验)与单测三方共用(零 electron 依赖)。
// 参考口径(ZCode codeViewer.ts):256KB 上限,超限诚实报错不截断。

/** 阅读器文本读取上限(ZCode 同款 256KB):超出诚实报「太大」,不截断不降级 */
export const MD_READER_TEXT_MAX_BYTES = 256 * 1024

/** 判定是否 markdown 文件:只认后缀 .md / .markdown(大小写不敏感),入口分流与读取校验同源 */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown')
}

/** 二进制嗅探:文件头含 NUL 字节视为二进制(UTF-8 文本任何合法内容都不会出 \0) */
export function looksBinary(head: Uint8Array): boolean {
  return head.includes(0)
}

/** 面包屑切段:按 / 与 \ 切路径,过滤空段;渲染层展示用(末段=文件名加粗) */
export function crumbSegments(path: string): string[] {
  return path
    .split(/[\\/]/)
    .map((s) => s.trim())
    .filter(Boolean)
}
