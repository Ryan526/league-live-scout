// A tiny TTL cache with optional on-disk persistence, keyed by arbitrary
// strings (typically region + PUUID + a namespace). Used so re-scouting the
// same players between games is instant and stays within rate limits.

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
  /** Hard cap on retained entries; the soonest-to-expire are dropped first. */
  maxEntries?: number
  now?: () => number
}

export interface ComputeOptions {
  /** TTL for the value we are about to store. */
  ttlMs?: number
  /**
   * Ignore any cached value and fetch again. The freshly-fetched result is
   * still written with the normal TTL, so a forced refresh doesn't poison the
   * cache. This is what "Re-scout" needs: passing `ttlMs: 0` only ever affected
   * the *write*, which is why the button did nothing.
   */
  bypass?: boolean
}

const DEFAULT_TTL_MS = 30 * 60_000
const DEFAULT_MAX_ENTRIES = 4000
const SAVE_DEBOUNCE_MS = 2000

export class TtlCache {
  private readonly map = new Map<string, Entry<unknown>>()
  /** In-flight computations, for request de-duplication. */
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly ttlMs: number
  private readonly filePath?: string
  private readonly maxEntries: number
  private readonly now: () => number
  private saveTimer: NodeJS.Timeout | null = null
  private loaded = false
  /** Serializes writes so a debounced save and a shutdown flush can't interleave. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(opts: CacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.filePath = opts.filePath
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.now = opts.now ?? (() => Date.now())
  }

  /** Load persisted entries from disk (call once at startup). */
  async load(): Promise<void> {
    if (this.loaded || !this.filePath) {
      this.loaded = true
      return
    }
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
    } finally {
      // Set only once the read has finished, so a concurrent load() can't
      // observe `loaded` and race ahead of a half-populated map.
      this.loaded = true
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

  set<T>(key: string, value: T, ttlMs?: number): void {
    this.map.set(key, {
      value,
      expires: this.now() + (ttlMs ?? this.ttlMs)
    })
    this.evictIfNeeded()
    this.scheduleSave()
  }

  /**
   * Return cached value or compute+store it. Concurrent calls for the same key
   * share a single in-flight computation (request de-duplication) so repeated
   * lookups — e.g. the live poller re-scouting every few seconds before the
   * first request has resolved — never launch duplicate API calls.
   */
  async getOrCompute<T>(
    key: string,
    compute: () => Promise<T>,
    opts: ComputeOptions = {}
  ): Promise<T> {
    if (!opts.bypass) {
      const hit = this.get<T>(key)
      if (hit !== undefined) return hit
    }

    // Joining an in-flight compute is safe even when bypassing: that request
    // is already going to the network, so its result is as fresh as ours.
    const existing = this.pending.get(key)
    if (existing) return existing as Promise<T>

    const p = (async () => {
      const value = await compute()
      this.set(key, value, opts.ttlMs)
      return value
    })()
    this.pending.set(key, p)
    try {
      return await p
    } finally {
      // Clear on both success and failure; failures stay uncached so a later
      // call can retry, but never pile up while one is in flight.
      this.pending.delete(key)
    }
  }

  /** Drop everything (used when a setting invalidates the whole cache). */
  clear(): void {
    this.map.clear()
  }

  /** Number of live entries, for tests and diagnostics. */
  get size(): number {
    return this.map.size
  }

  private evictIfNeeded(): void {
    if (this.map.size <= this.maxEntries) return
    const byExpiry = [...this.map.entries()].sort((a, b) => a[1].expires - b[1].expires)
    const excess = this.map.size - this.maxEntries
    for (let i = 0; i < excess; i++) this.map.delete(byExpiry[i][0])
  }

  private scheduleSave(): void {
    if (!this.filePath || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
    // Don't keep the event loop alive just for a cache flush.
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  /** Cancel any pending debounced save (used on shutdown before a final flush). */
  cancelPendingSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  async flush(): Promise<void> {
    if (!this.filePath) return
    const path = this.filePath
    // Chain rather than run concurrently: two overlapping writers would
    // interleave into a corrupt file.
    this.writeChain = this.writeChain.then(async () => {
      // Prune expired before writing.
      const t = this.now()
      for (const [k, e] of this.map) if (e.expires <= t) this.map.delete(k)
      const obj: Record<string, Entry<unknown>> = {}
      for (const [k, e] of this.map) obj[k] = e
      const tmp = `${path}.tmp`
      try {
        await fs.mkdir(dirname(path), { recursive: true })
        // Write-then-rename: a crash mid-write can no longer truncate the real
        // cache file into unparseable JSON.
        await fs.writeFile(tmp, JSON.stringify(obj), 'utf8')
        await fs.rename(tmp, path)
      } catch {
        // Non-fatal: cache persistence is best-effort.
        await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    })
    return this.writeChain
  }
}
