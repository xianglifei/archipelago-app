import { randomUUID } from 'node:crypto'
import type { ModelSettings, SpaceInfo } from '@shared/types'
import { metaGet, metaSet, nowIso } from './store'

// 岛(Space)身份与全局模型配置(M2.8 / M11.6)

const KEY_SPACE = 'space'
const KEY_WIZARD_DONE = 'wizard.done'
const KEY_MODEL = 'model.default'

export function getSpace(): SpaceInfo | null {
  return metaGet<SpaceInfo>(KEY_SPACE)
}

export function initSpace(name: string, ownerName: string): SpaceInfo {
  const space: SpaceInfo = {
    id: randomUUID(),
    name: name.trim() || '无名岛',
    ownerName: ownerName.trim(),
    createdAt: nowIso()
  }
  metaSet(KEY_SPACE, space)
  return space
}

export function updateSpace(patch: { name?: string; ownerName?: string }): SpaceInfo {
  const space = getSpace()
  if (!space) throw new Error('岛尚未初始化')
  if (patch.name !== undefined && patch.name.trim()) space.name = patch.name.trim()
  if (patch.ownerName !== undefined) space.ownerName = patch.ownerName.trim()
  metaSet(KEY_SPACE, space)
  return space
}

export function isWizardDone(): boolean {
  return metaGet<string>(KEY_WIZARD_DONE) === 'done'
}

export function markWizardDone(): void {
  metaSet(KEY_WIZARD_DONE, 'done')
}

export function getModelConfig(): ModelSettings | null {
  return metaGet<ModelSettings>(KEY_MODEL)
}

export function setModelConfig(config: ModelSettings): void {
  metaSet(KEY_MODEL, config)
}
