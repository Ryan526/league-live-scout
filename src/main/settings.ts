// Persistent settings: region + prefs via electron-store, and the Riot API key
// encrypted at rest with Electron's safeStorage (OS keychain / DPAPI). We never
// expose the raw key to the renderer — only a boolean "hasApiKey".

import { safeStorage } from 'electron'
import Store from 'electron-store'
import type { AppSettings, RegionConfig } from '@shared/types'

interface StoreSchema {
  /** Base64 of the safeStorage-encrypted API key. */
  apiKeyEnc?: string
  /** Plaintext fallback only when OS encryption is unavailable. */
  apiKeyPlain?: string
  region: RegionConfig
  livePollMs: number
}

const DEFAULTS: StoreSchema = {
  region: { platform: 'na1', regional: 'americas' },
  livePollMs: 5000
}

export class Settings {
  private store: Store<StoreSchema>

  constructor() {
    this.store = new Store<StoreSchema>({ name: 'settings', defaults: DEFAULTS })
  }

  getRegion(): RegionConfig {
    return this.store.get('region', DEFAULTS.region)
  }

  setRegion(region: RegionConfig): void {
    this.store.set('region', region)
  }

  getLivePollMs(): number {
    return this.store.get('livePollMs', DEFAULTS.livePollMs)
  }

  hasApiKey(): boolean {
    return Boolean(this.store.get('apiKeyEnc') || this.store.get('apiKeyPlain'))
  }

  /** Decrypt and return the API key, or null if none stored. */
  getApiKey(): string | null {
    const enc = this.store.get('apiKeyEnc')
    if (enc) {
      try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'))
      } catch {
        return null
      }
    }
    const plain = this.store.get('apiKeyPlain')
    return plain ?? null
  }

  setApiKey(key: string): void {
    const trimmed = key.trim()
    if (!trimmed) {
      this.clearApiKey()
      return
    }
    if (safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(trimmed).toString('base64')
      this.store.set('apiKeyEnc', enc)
      this.store.delete('apiKeyPlain')
    } else {
      // Best-effort fallback; documented as less secure in the README.
      this.store.set('apiKeyPlain', trimmed)
      this.store.delete('apiKeyEnc')
    }
  }

  clearApiKey(): void {
    this.store.delete('apiKeyEnc')
    this.store.delete('apiKeyPlain')
  }

  toAppSettings(): AppSettings {
    return {
      hasApiKey: this.hasApiKey(),
      region: this.getRegion(),
      livePollMs: this.getLivePollMs()
    }
  }
}
