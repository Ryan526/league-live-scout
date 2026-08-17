import type { ScoutApi } from './index'

declare global {
  interface Window {
    scout: ScoutApi
  }
}

export {}
