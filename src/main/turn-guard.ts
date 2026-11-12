// 回合失控护栏纯逻辑(2026-11-03 方案 - 单聊回合步数上限与失控护栏,零 electron 依赖,冒烟同源):
// ① 上限 24→100:取值两判据=无人值守任务完成率(任务回合撞上限没人能说「继续」)+ 1M 溢出安全
//    距离(重负载 100 步 ≈ 30~50 万 token,离溢出路径还有 2~3 倍余量;120 会摸到,故不取);
//    生产端无步数遥测,不能上线量再调,一步到位取宽。
// ② 重复调用检测(学 ZCode model-anomaly.ts):同名工具+同参数(stable JSON,键序无关)连续
//    REPEAT_STREAK_WARN 次 → 该次工具结果进上下文时附纠正提醒,每回合最多注 REPEAT_WARN_MAX_PER_TURN 次
//    (注满后计数照常、不再打扰)。只抓「连续同签名」:A→B→A→B 振荡属步数上限兜底的范围。
// ③ 耗尽前预警:距上限还剩 EXHAUST_WARN_AHEAD 步的那步工具执行完注入一次收尾指令,
//    留 10 步给模型执行收尾动作——真耗尽时末段大概率是模型自己写的总结,不是平台拼的括号。
// 注入只改进上下文的工具结果、不进时间线展示(chat.ts 里 event.done 拿纯结果);
// 提醒文案属居民世界文本(prompt payload),按 i18n 约定保持中文不翻。
// 群聊成员回合同走 runToolLoop(groups.ts),护栏同样生效;群预算(3×成员)是另一层机制,不受影响。

export const MAX_STEPS = 100
/** 同签名连续调用达到该次数时注入纠正提醒 */
export const REPEAT_STREAK_WARN = 3
/** 每回合重复提醒注入上限(注满后计数照常、不再打扰上下文) */
export const REPEAT_WARN_MAX_PER_TURN = 3
/** 距上限还剩多少步时注入收尾预警 */
export const EXHAUST_WARN_AHEAD = 10

export const REPEAT_REMINDER = `[系统提示] 这个工具用同样的参数已经连续调用 ${REPEAT_STREAK_WARN} 次了。除非岛主明确要求原样重试,不要再用完全相同的参数重复调用;请基于已有结果换下一步、说明卡在哪里,或向岛主求助。`

export const EXHAUST_REMINDER = `[系统提示] 本回合的步数预算还剩约 ${EXHAUST_WARN_AHEAD} 步。如果任务还没有完成,请开始收尾:总结目前的进展,说明哪些部分已完成、哪些还没有。`

/** 步数耗尽收尾句:任务回合无人值守,指路「回『继续』续跑」(岛主事后在单聊回「继续」即带全量上下文续跑);
 *  普通回合保持既有口径 */
export const EXHAUST_SUFFIX_TASK = '\n\n(本次任务执行已到步数上限,回复「继续」后可继续工作。)'
export const EXHAUST_SUFFIX_CHAT = '\n\n(本轮工具步数已达上限,先停在这里;要继续的话跟我说一声。)'

export interface RepeatGuardState {
  signature?: string
  streak: number
  warningsInjected: number
}

export function createRepeatGuard(): RepeatGuardState {
  return { streak: 0, warningsInjected: 0 }
}

/** 记一次工具调用;恰好命中阈值且未注满时返回 true(该次结果进上下文时附 REPEAT_REMINDER)。
 *  只在恰好命中那一次注入(ZCode 同语义):streak 4、5…不重复注,断掉后重达阈值才再注 */
export function noteToolCall(state: RepeatGuardState, signature: string): boolean {
  if (state.signature === signature) state.streak += 1
  else {
    state.signature = signature
    state.streak = 1
  }
  if (state.streak !== REPEAT_STREAK_WARN) return false
  if (state.warningsInjected >= REPEAT_WARN_MAX_PER_TURN) return false
  state.warningsInjected += 1
  return true
}

/** 工具调用签名:工具名 + 参数 stable JSON(键排序,参数键序不同视为同签名) */
export function toolCallSignature(name: string, args: Record<string, unknown>): string {
  return `${JSON.stringify(name)}:${stableJson(args)}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}
