// A central rate-limited request queue for the Riot API.
//
// A personal (development) key is limited to roughly:
//   - 20 requests / 1 second
//   - 100 requests / 120 seconds
// plus per-method limits returned in response headers. We honor the app-wide
// windows proactively and back off on 429 using the Retry-After header.
//
// The limiter is deliberately conservative and header-aware: whenever Riot
// returns X-App-Rate-Limit-Count we reconcile our local counters so we never
// drift past the real budget.

export interface RateWindow {
  /** Max requests permitted within the window. */
  limit: number
  /** Window length in milliseconds. */
  intervalMs: number
}

export interface RateLimiterOptions {
  /** App-wide windows (defaults to personal-key limits). */
  appWindows?: RateWindow[]
  /** Safety margin: only use this fraction of each window (0..1). */
  safety?: number
  /** Clock injection for tests. */
  now?: () => number
  /** Sleep injection for tests. */
  sleep?: (ms: number) => Promise<void>
}

interface QueueItem {
  run: () => void
  weight: number
}

const DEFAULT_APP_WINDOWS: RateWindow[] = [
  { limit: 20, intervalMs: 1000 },
  { limit: 100, intervalMs: 120_000 }
]

export class RateLimiter {
  private readonly appWindows: RateWindow[]
  private readonly safety: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  /** Timestamps of recent requests, one array per window. */
  private readonly hits: number[][]
  private readonly queue: QueueItem[] = []
  private draining = false
  private inFlight = 0
  /** Absolute time until which all requests must wait (429 backoff). */
  private retryAfterUntil = 0

  constructor(opts: RateLimiterOptions = {}) {
    this.appWindows = opts.appWindows ?? DEFAULT_APP_WINDOWS
    this.safety = opts.safety ?? 0.95
    this.now = opts.now ?? (() => Date.now())
    this.sleep =
      opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    this.hits = this.appWindows.map(() => [])
  }

  status(): { inFlight: number; queued: number; retryAfterUntil?: number } {
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      retryAfterUntil: this.retryAfterUntil > this.now() ? this.retryAfterUntil : undefined
    }
  }

  /** Schedule work; resolves with the result once a slot is available. */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        weight: 1,
        run: () => {
          this.inFlight++
          fn()
            .then(resolve, reject)
            .finally(() => {
              this.inFlight--
            })
        }
      })
      void this.drain()
    })
  }

  /** Force a backoff window, e.g. after a 429. `seconds` from Retry-After. */
  applyRetryAfter(seconds: number): void {
    const until = this.now() + Math.max(0, seconds) * 1000
    if (until > this.retryAfterUntil) this.retryAfterUntil = until
  }

  /**
   * Reconcile our local counters against Riot's authoritative count header,
   * formatted like "count:limit,count:limit" (X-App-Rate-Limit-Count).
   * If Riot thinks we've used more than we recorded, add synthetic hits so we
   * throttle sooner.
   */
  reconcileFromHeader(countHeader: string | null | undefined): void {
    if (!countHeader) return
    const parts = countHeader.split(',').map((p) => p.trim())
    for (const part of parts) {
      const [countStr, intervalStr] = part.split(':')
      const count = Number(countStr)
      const intervalMs = Number(intervalStr) * 1000
      if (!Number.isFinite(count) || !Number.isFinite(intervalMs)) continue
      const idx = this.appWindows.findIndex((w) => w.intervalMs === intervalMs)
      if (idx < 0) continue
      this.prune()
      const localCount = this.hits[idx].length
      if (count > localCount) {
        // Backfill synthetic hits dated "now" so they expire with the window.
        const t = this.now()
        for (let i = 0; i < count - localCount; i++) this.hits[idx].push(t)
      }
    }
  }

  /** Remove expired timestamps from every window. */
  private prune(): void {
    const t = this.now()
    for (let i = 0; i < this.appWindows.length; i++) {
      const cutoff = t - this.appWindows[i].intervalMs
      const arr = this.hits[i]
      let keep = 0
      while (keep < arr.length && arr[keep] <= cutoff) keep++
      if (keep > 0) arr.splice(0, keep)
    }
  }

  /** Ms until the next request is permitted by the app windows (0 if now). */
  private msUntilSlot(): number {
    this.prune()
    const t = this.now()
    let wait = Math.max(0, this.retryAfterUntil - t)
    for (let i = 0; i < this.appWindows.length; i++) {
      const w = this.appWindows[i]
      const cap = Math.max(1, Math.floor(w.limit * this.safety))
      const arr = this.hits[i]
      if (arr.length >= cap) {
        // Must wait until the oldest hit in this window expires.
        const oldest = arr[arr.length - cap]
        wait = Math.max(wait, oldest + w.intervalMs - t)
      }
    }
    return wait
  }

  private recordHit(): void {
    const t = this.now()
    for (const arr of this.hits) arr.push(t)
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const wait = this.msUntilSlot()
        if (wait > 0) {
          await this.sleep(wait)
          continue
        }
        const item = this.queue.shift()!
        this.recordHit()
        item.run()
      }
    } finally {
      this.draining = false
    }
  }
}
