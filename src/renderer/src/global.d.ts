import type { RendererApi } from '@shared/types'

declare global {
  interface Window {
    archipelago: RendererApi
  }
}

export {}
