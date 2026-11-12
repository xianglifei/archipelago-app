// 精选推荐目录(2026-11-05 技能中心二期):云端 catalog 拉取 + 24h 缓存(ETag/304)+ 离线 seed 兜底。
// 语义(需求 §5.4):目录只是橱窗与名册来源——下架/删除/改文案只影响未装用户(24h 内到达),
// 已装用户的卡是安装即复制的复制件,落在岛上本地 skills 表,与云端再无耦合。
// 联网一律走 net.fetch(裸 fetch 不认系统代理,「能登录不能聊」事故的教训)

import fs from 'node:fs'
import path from 'node:path'
import { net } from 'electron'
import { SEA_BASE_URL } from './auth'
import { requireDataRoot } from './paths'
import type { OfficialCatalogData, OfficialSkillCard } from '@shared/types'

/** 官方复制卡的 creator_bot_id 标记(居民表里没有这个 id;名册/档案页签据此显示「来自精选推荐」) */
export const OFFICIAL_CREATOR_ID = 'official'

/** 缓存有效期分两档(2026-11-05 Felix 拍板):
 *  ① App 启动(含登录后 reload)静默强刷一次——新上架的卡用户重启即见;
 *  ② 打开技能中心视图时,缓存超过 6h 就刷新(ETag 协商,没更新一次 304 几乎免费,304 也续期 fetchedAt);
 *  24h 是兜底硬上限(当前无路径能超过 6h 仍不刷,保留作文档口径)。 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
export const CATALOG_VIEW_TTL_MS = 6 * 60 * 60 * 1000

const CACHE_FILE = 'official-catalog.json'

/** 离线首装兜底 seed(与云端 catalog 同构;内容=已拍板首批七张,技能详情为用户向大白话) */
export const OFFICIAL_CATALOG_SEED: OfficialSkillCard[] = [
  {
    name: '飞书',
    section: '办公协作',
    description: '用命令行操作飞书:发消息、建文档、管日程。',
    detail:
      '让岛上的居民替你打理飞书——发消息、建群、写文档、查日程,一句话就行。对居民说「用飞书提醒张三,明天十点开会」,TA 会自己完成剩下的事。\n第一次使用需要扫码授权你的飞书账号,居民会把二维码拿给你扫;电脑上需要能联网,缺少的运行环境居民会先问过你再装。\n适合:让居民当你的飞书秘书,消息、文档、日程都可以交代。',
    url: 'https://github.com/larksuite/cli',
    icon: 'bird',
    color: '#3370ff',
    weight: 1
  },
  {
    name: '钉钉',
    section: '办公协作',
    description: '在钉钉里发消息、管待办与日程。',
    detail:
      '居民可以替你在钉钉里发工作通知、登记待办、查今天的日程。第一次使用需要授权一次钉钉账号,之后随叫随到。\n适合:上班族把重复性的钉钉琐事交给居民跑腿。',
    url: 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli',
    icon: 'message-circle',
    color: '#0089ff',
    weight: 2
  },
  {
    name: '企业微信',
    section: '办公协作',
    description: '通知、文档与智能表格,一句话搞定。',
    detail:
      '居民可以替你往企业微信发群通知、写文档、查智能表格。需要先绑定一次你们企业的机器人信息(装的时候居民会告诉你要准备什么)。\n适合:小团队让居民当内部通知员。',
    url: 'https://github.com/WecomTeam/wecom-cli',
    icon: 'briefcase',
    color: '#2eaf6b',
    weight: 3
  },
  {
    name: '腾讯会议',
    section: '办公协作',
    description: '查会议、建会议,会后顺手写纪要。',
    detail:
      '问居民「我今天有几场会」就能查到腾讯会议日程;让 TA 建会、会后整理一份纪要发给你也没问题。\n适合:会多的日子,把日程查询和纪要交给居民。',
    url: 'https://meeting.tencent.com/',
    icon: 'video',
    color: '#4f6bb8',
    weight: 4
  },
  {
    name: '瑞幸咖啡',
    section: '生活服务',
    description: '查门店与菜单,到店自取点一杯。',
    detail:
      '想喝咖啡了,对居民说「帮我点一杯生椰拿铁,冰的,大杯」——TA 会查你附近的瑞幸门店、看菜单报价、用掉能用的券,下完单把取餐码和门店位置发给你,你到店报码取餐就行。\n支持:按距离/商圈挑门店、看菜单和价格、自动用券、查订单历史、记住你常喝的那杯。\n注意:目前只支持到店自取,不支持外卖配送;第一次使用需要用手机号登录一次瑞幸账号。',
    url: 'https://open.lkcoffee.com/cli',
    icon: 'coffee',
    color: '#3355c9',
    weight: 1
  },
  {
    name: '飞猪',
    section: '生活服务',
    description: '查机票、酒店、火车票,结果直达预订链接。',
    detail:
      '出行前让居民帮你查:周六去杭州的机票、下周成都的酒店、五一的高铁票——TA 给你的结果是带预订链接的,你确认后自己下单付款,钱不经居民的手。\n适合:比价和查行程这种麻烦事交给居民,付款永远由你本人完成。',
    url: 'https://flyai.open.fliggy.com/',
    icon: 'plane',
    color: '#ff7a1a',
    weight: 2
  },
  {
    name: '网易云音乐',
    section: '生活服务',
    description: '搜歌、放歌、管歌单,还会分析口味。',
    detail:
      '对居民说「放一首适合写代码的歌」「把这首歌收进我的歌单」——TA 能搜歌、控制播放、整理歌单,还会根据你红心过的歌摸清你的口味,聊天时给你推荐。\n适合:把背景音乐这件事整个交给居民。',
    url: 'https://github.com/NetEase/skills',
    icon: 'music-2',
    color: '#d33a31',
    weight: 3
  }
]

function seedCatalog(): OfficialCatalogData {
  return { revision: 1, skills: OFFICIAL_CATALOG_SEED }
}

interface CacheFile {
  etag: string | null
  revision: number
  fetchedAt: number
  skills: OfficialSkillCard[]
}

let memo: CacheFile | null = null
let inFlight: Promise<OfficialCatalogData> | null = null

function cachePath(): string {
  return path.join(requireDataRoot(), CACHE_FILE)
}

function loadCache(): CacheFile | null {
  if (memo) return memo
  try {
    const raw = fs.readFileSync(cachePath(), 'utf-8')
    const parsed = JSON.parse(raw) as CacheFile
    if (Array.isArray(parsed.skills) && parsed.skills.length > 0) {
      memo = parsed
      return memo
    }
  } catch {
    // 无缓存/坏缓存:走 seed,首次联网拉取后覆盖
  }
  return null
}

function persist(cache: CacheFile): void {
  memo = cache
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(cache), 'utf-8')
  } catch {
    // 落盘失败不致命:内存缓存照用,下次启动重新拉
  }
}

/** 同步读目录(prompt 装配/解析走这条,不触发网络):缓存 → seed 兜底 */
export function currentCatalog(): OfficialCatalogData {
  const c = loadCache()
  if (c) return { revision: c.revision, skills: c.skills }
  return seedCatalog()
}

export function isCatalogStale(): boolean {
  const c = loadCache()
  return !c || Date.now() - c.fetchedAt > CATALOG_TTL_MS
}

/** 官方目录里本岛已装(已复制进岛)的名字集合,由调用方从 skills 表查好传入 */
export function officialResolve(name: string): OfficialSkillCard | null {
  const list = currentCatalog().skills
  const exact = list.find((c) => c.name === name)
  if (exact) return exact
  const fuzzy = list.filter((c) => c.name.includes(name) || name.includes(c.name))
  if (fuzzy.length === 1) return fuzzy[0]!
  return null
}

/** 拉取/刷新目录:ETag 协商(304=沿用缓存);失败时静默沿用旧缓存或 seed(诚实降级,不打断使用) */
export async function fetchCatalog(force: boolean): Promise<OfficialCatalogData> {
  const cached = loadCache()
  if (!force && cached && Date.now() - cached.fetchedAt <= CATALOG_VIEW_TTL_MS) {
    return { revision: cached.revision, skills: cached.skills }
  }
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        // 能力协商(2026-11-06):带此头=新客户端,云端目录才下发连接器卡;
        // 老客户端不带 → 只拿技能卡,连接器行对它们不存在(防「看得见装不了」死卡)
        'x-mcp-client': '1'
      }
      if (cached?.etag) headers['if-none-match'] = cached.etag
      const resp = await net.fetch(`${SEA_BASE_URL}/skills/catalog`, { headers })
      if (resp.status === 304 && cached) {
        persist({ ...cached, fetchedAt: Date.now() })
        return { revision: cached.revision, skills: cached.skills }
      }
      if (!resp.ok) throw new Error(`catalog ${resp.status}`)
      const body = (await resp.json()) as { ok?: boolean; data?: OfficialCatalogData }
      const data = body.data
      if (!data || !Array.isArray(data.skills)) throw new Error('catalog shape')
      persist({
        etag: resp.headers.get('etag'),
        revision: data.revision,
        fetchedAt: Date.now(),
        skills: data.skills
      })
      return { revision: data.revision, skills: data.skills }
    } catch {
      // 离线/远端异常:沿用旧缓存(不更新 fetchedAt,下次再试);从未成功过则 seed
      return cached ? { revision: cached.revision, skills: cached.skills } : seedCatalog()
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
