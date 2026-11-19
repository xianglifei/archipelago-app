// 夜间记忆整理编排(方案 - Linger 借鉴三件套 2026-11-19,批次③):
// 每日 00:30 对「自上次整理后有新写入」的记忆 scope(居民私有 + 集体)各跑一次受校验整理——
// 模型对带行号的清单提案(MERGE/SUPERSEDE/REJECT),memory-curation-core 程序校验后落盘,
// 被动出的旧条目归档进 {scope}.history.md(程序写,模型不写),变更观测落 context_events。
// 语义借 Linger 夜间 wiki 的「结构化提案 + 程序校验」:幻觉没有直写记忆的通道。
// 调度=post.ts 式独立 setInterval(不占 tasks 表/用户任务列表);干净 scope 零成本跳过;
// 设置页「偏好」卡开关可关(meta KV,缺省开)。与 curateOwnerProfile(档案管家)同族:
// 后台机制、无角色无人设、借用居民模型槽位——私有 scope 用本人模型,集体用主 Bot。

import type { Bot, MemoryEntry, MemoryPrefs } from '@shared/types'
import { chatOnce, llmCredentials } from './llm'
import { listBots } from './bots'
import { getDb, metaGet, metaSet, nowIso } from './store'
import { curationArchive, curationClearDirty, curationDirty, curationRead, curationWrite } from './memory'
import {
  CURATION_WINDOW,
  localDateKey,
  parseCuration,
  planCuration,
  shouldRunCuration
} from './memory-curation-core'

/** 每日触发点(本地时间):夜里跑,错开 0 点的定时任务族高峰 */
export const CURATION_TRIGGER = { hour: 0, minute: 30 }
const SCAN_INTERVAL_MS = 60_000
const CURATION_MAX_TOKENS = 800

const ENABLED_KEY = 'memory.curation.enabled'
const LAST_RUN_KEY = 'memory.curation.lastRunDate'

// ---- 偏好(设置页「偏好」卡开关,缺省开) ----

export function memoryPrefsGet(): MemoryPrefs {
  return { curationEnabled: metaGet<string>(ENABLED_KEY) !== '0' }
}

export function memoryPrefsSave(patch: Partial<MemoryPrefs>): MemoryPrefs {
  if (patch.curationEnabled !== undefined) metaSet(ENABLED_KEY, patch.curationEnabled ? '1' : '0')
  return memoryPrefsGet()
}

// ---- 整理提示词(行协议与记忆管家/档案管家同风格,坏行丢弃不伤整批) ----

const CURATION_SYSTEM_PROMPT = [
  '你是群岛的记忆管家,负责夜间整理一份记忆清单:合并重复、改写失效表述、剔除矛盾或过期的条目。',
  '铁律:',
  '- 只整理清单里已有的内容:新文本只能是对所列条目的归纳改写,不许引入清单外的任何新事实;',
  '- 「语气:」开头的条目是岛主对居民说话方式的长期反馈,除非明显失效,不参与整理;',
  '- 拿不准就保留:不输出该条的操作就是保留。',
  '输出格式(每行一条;没有需要整理的只输出一行 DONE):',
  'DONE —— 没有需要整理的',
  'MERGE|行号,行号,...|合并后的文本 —— 把几条合成一条(至少两行)',
  'SUPERSEDE|行号|新文本 —— 这条表述过期/冗长,用新文本原位替换',
  'REJECT|行号|理由 —— 这条已失效或记错,移出记忆(理由必填)'
].join('\n')

function curationUserPrompt(shown: MemoryEntry[]): string {
  return `【记忆清单(从旧到新;行号即条目号,只整理所列条目)】\n${shown
    .map((e) => `${e.line}. [${e.date}] ${e.text}`)
    .join('\n')}`
}

// ---- 观测:一行 context_events(纯观测,落库失败只留痕不打断,recordTurnUsage 先例) ----

interface CurationSummary {
  scope: string
  /** 受影响行数(0=本次没动清单) */
  changed: number
  /** 归档条数 */
  archives: number
  /** 解析不过/校验丢弃的提案行数 */
  invalid: number
}

function recordCurationEvent(summary: CurationSummary): void {
  try {
    getDb()
      .prepare(
        "INSERT INTO context_events (session_id, kind, detail, created_at) VALUES (?, 'memory-curation', ?, ?)"
      )
      .run(`memory:${summary.scope}`, JSON.stringify(summary), nowIso())
  } catch (err) {
    console.warn('[memory-curation] 观测落库失败(不影响整理结果):', err)
  }
}

// ---- 单 scope 整理 ----

async function curateScope(scope: string, bot: Bot, now: Date): Promise<CurationSummary> {
  const all = curationRead(scope)
  // 超长清单只整理最近 CURATION_WINDOW 条,头部原样保留
  const head = all.slice(0, Math.max(0, all.length - CURATION_WINDOW))
  const shown = all.slice(-CURATION_WINDOW)
  const creds = llmCredentials(bot.providerId)
  const result = await chatOnce({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey!,
    model: bot.modelId,
    maxTokens: CURATION_MAX_TOKENS,
    temperature: 0,
    messages: [
      { role: 'system', content: CURATION_SYSTEM_PROMPT },
      { role: 'user', content: curationUserPrompt(shown) }
    ]
  })
  const { proposals, done, invalid } = parseCuration(result.content)
  const outcome = planCuration(shown, proposals, localDateKey(now))
  const summary: CurationSummary = {
    scope,
    changed: outcome.changed,
    archives: outcome.archives.length,
    invalid: invalid.length + outcome.invalid.length
  }
  if (done || outcome.changed === 0) return summary
  curationWrite(scope, [...head, ...outcome.entries])
  curationArchive(scope, outcome.archives)
  return summary
}

// ---- 触发与调度 ----

/**
 * 每 60s 被调度器叫一次;到点且可跑才动手。lastRunDate 只在「真的发起过整理」时占用:
 * 全员没凭证(未登录)时当天凭证就绪后仍会补跑;跑过即清对应 scope 的脏标记,
 * 模型调用失败的 scope 保留脏标记等次日重试。
 */
export async function tickMemoryCuration(now = new Date()): Promise<void> {
  const dirty = curationDirty()
  if (
    !shouldRunCuration(now, {
      enabled: memoryPrefsGet().curationEnabled,
      dirty: dirty.length > 0,
      lastRunDate: metaGet<string>(LAST_RUN_KEY),
      hour: CURATION_TRIGGER.hour,
      minute: CURATION_TRIGGER.minute
    })
  ) {
    return
  }
  const bots = listBots()
  const main = bots.find((b) => b.isMain) ?? null
  const jobs: { scope: string; bot: Bot }[] = []
  for (const scope of dirty) {
    const bot = scope === 'shared' ? main : bots.find((b) => b.id === scope) ?? null
    if (!bot) {
      // 居民已删:其记忆是遗留文件,不再整理,移出脏集防永久重试
      console.warn(`[memory-curation] scope ${scope} 无对应居民,移出整理队列`)
      curationClearDirty(scope)
      continue
    }
    if (!llmCredentials(bot.providerId).apiKey) continue // 没凭证今天先跳过(不清脏)
    if (curationRead(scope).length < 2) {
      curationClearDirty(scope) // 一条没什么可整理的
      continue
    }
    jobs.push({ scope, bot })
  }
  if (jobs.length === 0) return
  metaSet(LAST_RUN_KEY, localDateKey(now))
  for (const { scope, bot } of jobs) {
    try {
      const summary = await curateScope(scope, bot, now)
      curationClearDirty(scope)
      recordCurationEvent(summary)
      console.log(`[memory-curation] ${scope}:改动 ${summary.changed} 行,归档 ${summary.archives} 条`)
    } catch (err) {
      console.error(`[memory-curation] ${scope} 整理失败(脏标记保留,次日重试):`, err)
    }
  }
}

/** 挂载夜间整理调度器(index.ts 启动时调用;登录门前凭证全空,自然静默) */
export function initMemoryCuration(): void {
  const timer = setInterval(() => void tickMemoryCuration().catch(() => undefined), SCAN_INTERVAL_MS)
  timer.unref?.()
}
