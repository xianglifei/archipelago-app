import { getDb, nowIso } from './store'

// 审计雏形(M12.4 先落库、无查看 UI):本机工具调用与审批决定 append-only 落库
// 落库失败只记日志,绝不影响工具执行

export function audit(botId: string, kind: string, detail: Record<string, unknown>): void {
  try {
    getDb()
      .prepare('INSERT INTO audit (bot_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(botId, kind, JSON.stringify(detail), nowIso())
  } catch (err) {
    console.error('[audit] 落库失败:', err)
  }
}
