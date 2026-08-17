import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppSettings,
  type RateLimiterStatus,
  type RegionConfig,
  type ScoutSnapshot
} from '../shared/types'

/** The typed API exposed to the renderer as `window.scout`. */
const api = {
  getSnapshot: (): Promise<ScoutSnapshot> => ipcRenderer.invoke(IPC.getSnapshot),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
  setApiKey: (key: string): Promise<AppSettings> => ipcRenderer.invoke(IPC.setApiKey, key),
  clearApiKey: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.clearApiKey),
  setRegion: (region: RegionConfig): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.setRegion, region),
  testApiKey: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.testApiKey),
  rescout: (): Promise<ScoutSnapshot> => ipcRenderer.invoke(IPC.rescout),

  onSnapshot: (cb: (snap: ScoutSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, snap: ScoutSnapshot): void => cb(snap)
    ipcRenderer.on(IPC.snapshot, listener)
    return () => ipcRenderer.removeListener(IPC.snapshot, listener)
  },
  onRateStatus: (cb: (status: RateLimiterStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: RateLimiterStatus): void => cb(status)
    ipcRenderer.on(IPC.rateStatus, listener)
    return () => ipcRenderer.removeListener(IPC.rateStatus, listener)
  },
  onLog: (cb: (line: string) => void): (() => void) => {
    const listener = (_e: unknown, line: string): void => cb(line)
    ipcRenderer.on(IPC.log, listener)
    return () => ipcRenderer.removeListener(IPC.log, listener)
  }
}

export type ScoutApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('scout', api)
} else {
  // Fallback for the unlikely case contextIsolation is off.
  ;(globalThis as unknown as { scout: ScoutApi }).scout = api
}
