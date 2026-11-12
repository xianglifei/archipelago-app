// 任务会话标题(2026-11-06「新建任务」P3 拍板:自动生成 + 手改兜底)的纯逻辑:
// 模型起的标题不可信——可能带引号/句读/解释性长句,这里统一净化;
// 拆纯函数供单测同源验证(skills-core / resident-patch-core 同款拆法)。

/** 短标题上限(P3:标题认事不认长,列表行一行装得下) */
export const TASK_TITLE_MAX = 12

/** 手改标题的上限(比自动标题宽一档,岛主自己写长一点无妨) */
export const TASK_TITLE_MANUAL_MAX = 40

/**
 * 净化模型起的任务标题:去包裹引号(「」“”'")、去尾句读(。.!!?？…;)、
 * 压空白成单空格、截到 TASK_TITLE_MAX;净化后为空返回 null(保持「新任务」)。
 * 引号与句读交替出现(如「整理照片」。)——两步交替循环剥到都无变化为止。
 */
export function sanitizeTaskTitle(raw: string): string | null {
  let s = raw.trim()
  const pairs: Record<string, string> = { '「': '」', '“': '”', '"': '"', "'": "'", '『': '』', '《': '》' }
  for (;;) {
    const before = s
    // 剥一层配对包裹引号(可嵌套,由外层循环逐层剥)
    const head = s[0]
    const tail = s[s.length - 1]
    if (head && tail && pairs[head] === tail) s = s.slice(1, -1).trim()
    // 去尾部句读(重复句号一并去)
    s = s.replace(/[。．.!！?？;；…]+$/u, '').trim()
    if (s === before) break
  }
  // 压空白:换行/连续空格压成单空格(标题不折行)
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return null
  // 截上限(代理对安全:用数组迭代避免把 emoji 切半)
  const chars = [...s]
  return chars.length <= TASK_TITLE_MAX ? s : chars.slice(0, TASK_TITLE_MAX).join('')
}

/** 净化岛主手改的标题:只压空白与截 MANUAL_MAX,不去引号句读(岛主想带什么带什么);空返回 null */
export function sanitizeManualTitle(raw: string): string | null {
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s) return null
  const chars = [...s]
  return chars.length <= TASK_TITLE_MANUAL_MAX ? s : chars.slice(0, TASK_TITLE_MANUAL_MAX).join('')
}
