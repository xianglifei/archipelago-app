import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

// 启动诊断日志:排查远端环境上「Dock 一直弹跳但窗口不出现」这类无提示失败(2026-10 内测反馈)。
// 事件带本地时间与相对进程启动的毫秒数,写入 userData/logs/main.log,超 1MB 重写。
const t0 = Date.now()

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function logDiag(event: string, detail?: unknown): void {
  const line = `[${new Date().toLocaleString('sv')} +${Date.now() - t0}ms] ${event}${
    detail === undefined ? '' : ` ${safeJson(detail)}`
  }`
  console.log(`[diag] ${line}`)
  try {
    const file = path.join(app.getPath('userData'), 'logs', 'main.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.rmSync(file)
    fs.appendFileSync(file, `${line}\n`)
  } catch {
    // 日志写不进去不能反过来弄崩启动
  }
}
