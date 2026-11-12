import { api } from '../api'

// 回合过程默认折叠/展开(2026-11-08 设置项)的渲染端缓存。
// 「工作中」「回信中」运行签只在挂载瞬间读默认值(不该中途拽动用户视图),所以不做事件广播:
// 设置页写入即更缓存,之后新挂载的签自然用新值。
// 拉取时机只放 ChatView 挂载后(登录守卫内)——metaGet 走业务库,库挂载前碰不得(init 红线)。

let cached: boolean | null = null
let inflight: Promise<void> | null = null

/** 拉取偏好(幂等:已加载则不重复请求);失败不置值,下次挂载重试 */
export function loadTurnProcessPref(): Promise<void> {
  if (cached !== null) return Promise.resolve()
  inflight ??= api
    .turnProcessGet()
    .then((v) => {
      cached = v
    })
    .catch(() => {
      inflight = null
    })
  return inflight
}

/** 当前偏好:true=过程明细默认展开;尚未加载完成按默认(折叠)兜底 */
export function turnProcessPrefExpanded(): boolean {
  return cached ?? false
}

/** 设置页写入后同步缓存,让之后新挂载的折叠签立即用新值 */
export function cacheTurnProcessPref(v: boolean): void {
  cached = v
}
