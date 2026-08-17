// A tiny TTL cache with optional on-disk persistence, keyed by arbitrary
// strings (typically PUUID + a namespace). Used so re-scouting the same
// players between games is instant and stays within rate limits.

import { promises as fs } from 'fs'
import { dirname } from 'path'

interface Entry<T> {
  value: T
  /** Absolute expiry timestamp (ms). */
  expires: number
}

export interface CacheOptions {
  /** Default TTL in ms (defaults to 30 minutes). */
  ttlMs?: number
  /** Path to persist the cache as JSON. Omit for memory-only. */
  filePath?: string
  now?: () => number
}

export class TtlCache {
  private readonly map = new Map<string, Entry<unknown>>()
  private readonly ttlMs: number
  private readonly filePath?: string
  private readonly now: () => number
  private saveTimer: NodeJS.Timeout | null = null
  private loaded = false

  constructor(opts: CacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30 * 60_000
    this.filePath = opts.filePath
    this.now = opts.now ?? (() => Date.now())
  }

  /** Load persisted entries from disk (call once at startup). */
  async load(): Promise<void> {
    if (this.loaded || !this.filePath) {
      this.loaded = true
      return
    }
    this.loaded = true
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const data = JSON.parse(raw) as Record<string, Entry<unknown>>
      const t = this.now()
      for (const [k, e] of Object.entries(data)) {
        if (e && typeof e.expires === 'number' && e.expires > t) {
          this.map.set(k, e)
        }
      }
    } catch {
      // Missing/corrupt cache file is fine — start empty.
    }
  }

  get<T>(key: string): T | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (e.expires <= this.now()) {
      this.map.delete(key)
      return undefined
    }
    return e.value as T
  }

  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    this.map.set(key, {
      value,
      expires: this.now() + (ttlMs ?? this.ttlMs)
    })
    this.scheduleSave()
  }

  /** Return cached value or compute+store it. */
  async getOrCompute<T>(key: string, compute: () => Promise<T>, ttlMs?: number): Promise<T> {
    const hit = this.get<T>(key)
    if (hit !== undefined) return hit
    const value = await compute()
    this.set(key, value, ttlMs)
    return value
  }

  private scheduleSave(): void {
    if (!this.filePath || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, 1000)
    // Don't keep the event loop alive just for a cache flush.
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  async flush(): Promise<void> {
    if (!this.filePath) return
    // Prune expired before writing.
    const t = this.now()
    for (const [k, e] of this.map) if (e.expires <= t) this.map.delete(k)
    const obj: Record<string, Entry<unknown>> = {}
    for (const [k, e] of this.map) obj[k] = e
    try {
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, JSON.stringify(obj), 'utf8')
    } catch {
      // Non-fatal: cache persistence is best-effort.
    }
  }
}
