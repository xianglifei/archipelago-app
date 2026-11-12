// update_resident 字段解析纯逻辑核心(2026-11-05 issue #30):空串语义 / 同值去重 /
// 拒绝口径——不碰 Electron/DB,冒烟直接 import 本文件(skills-core 同款拆法);
// DB 读写、审批与广播编排见 tools.ts 处理器

import type { Bot, BotPatch } from '@shared/types'
import { resolveArchetype } from '@shared/archetypes'

export interface ResidentPatchResult {
  /** 拒绝原因(人话,直接作为工具结果返回);undefined=解析通过 */
  error?: string
  /** 解析出的身份字段 patch(已做同值去重;error 时为空对象) */
  patch: BotPatch
}

/** 参数 → 身份字段 patch。
 *  空值语义(#30 起):role/persona 传了(非 null)就按传了算——空串/纯空格=显式清空回「未设」,
 *  与 invite 的「空=不设」在此分家:update 的空是岛主的明确指令,不再当没传;
 *  name 不许清空(居民必须有名字),archetype 仍须解析成八型之一,两者空值维持「视为没传」。
 *  同值去重:传现值(含已空再传空)当没改,免得弹「改成一样」的空审批卡。 */
export function parseResidentPatch(
  args: Record<string, unknown>,
  target: Pick<Bot, 'name' | 'role' | 'persona' | 'archetype'>
): ResidentPatchResult {
  const patch: BotPatch = {}
  const newName = String(args.name ?? '').trim()
  if (args.name !== undefined && !newName) {
    return { error: '新名字不能为空;不想改名字就不要传 name。', patch }
  }
  if (newName) patch.name = newName
  const role = String(args.role ?? '').trim()
  if (args.role !== undefined && args.role !== null) patch.role = role
  const persona = String(args.persona ?? '').trim()
  if (args.persona !== undefined && args.persona !== null) patch.persona = persona
  const archArg = String(args.archetype ?? '').trim()
  if (archArg) {
    const resolved = resolveArchetype(archArg)
    if (!resolved) {
      return {
        error: `没有「${archArg}」这个性格原型;可选:元气、温柔、悠闲、知性、大姐、行动派、风雅、小太阳。`,
        patch
      }
    }
    patch.archetype = resolved.id
  }
  if (
    patch.name === undefined &&
    patch.role === undefined &&
    patch.persona === undefined &&
    patch.archetype === undefined
  ) {
    return { error: '至少要改一项:名字(name)、角色(role)、人设(persona)或性格(archetype)。', patch }
  }
  if (patch.name === target.name) delete patch.name
  if (patch.archetype === target.archetype) delete patch.archetype
  if (patch.role === target.role) delete patch.role
  if (patch.persona === target.persona) delete patch.persona
  if (
    patch.name === undefined &&
    patch.role === undefined &&
    patch.persona === undefined &&
    patch.archetype === undefined
  ) {
    return { error: `传来的改动都和「${target.name}」现在的一样,没有要改的。`, patch }
  }
  return { patch }
}
