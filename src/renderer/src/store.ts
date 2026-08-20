import { create } from 'zustand'
import type { AppSettings, RateLimiterStatus, ScoutSnapshot } from '@shared/types'

interface ScoutStore {
  snapshot: ScoutSnapshot | null
  settings: AppSettings | null
  /** Latest queue status, stamped on arrival so the UI can age the ETA
   *  between pushes rather than showing a value that is already stale. */
  rate: (RateLimiterStatus & { receivedAt: number }) | null
  logs: string[]
  settingsOpen: boolean

  setSnapshot: (s: ScoutSnapshot) => void
  setSettings: (s: AppSettings) => void
  setRate: (r: RateLimiterStatus) => void
  pushLog: (line: string) => void
  setSettingsOpen: (open: boolean) => void
}

export const useStore = create<ScoutStore>((set) => ({
  snapshot: null,
  settings: null,
  rate: null,
  logs: [],
  settingsOpen: false,

  setSnapshot: (s) => set({ snapshot: s }),
  setSettings: (s) => set({ settings: s }),
  setRate: (r) => set({ rate: { ...r, receivedAt: Date.now() } }),
  pushLog: (line) =>
    set((state) => ({
      logs: [`${new Date().toLocaleTimeString()}  ${line}`, ...state.logs].slice(0, 200)
    })),
  setSettingsOpen: (open) => set({ settingsOpen: open })
}))
