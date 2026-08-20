// A central rate-limited request queue for the Riot API.
//
// We start on the conservative *development*-key budget:
//   - 20 requests / 1 second
//   - 100 requests / 120 seconds
// but Riot tells us the real budget on every response via X-App-Rate-Limit, so
// the first reply reconfigures the windows. A production key is ~300x larger
// than a dev key, and hardcoding the dev numbers meant a production key spent
// four minutes populating a lobby it could have filled in seconds.
//
// X-App-Rate-Limit-Count carries the authoritative usage, which we reconcile
// against our local counters so we never drift past the real budget, and 429s
// force a backoff via Retry-After.
//
// Riot enforces TWO independent budgets and a request needs a slot in both:
//   - the *app* budget, shared by every endpoint (X-App-Rate-Limit)
//   - a *method* budget, per endpoint (X-Method-Rate-Limit)
// A single game fans out ~50 match-v5 lookups, which is nowhere near an app
// limit but can sit right on top of that method's own budget, so the method
// windows are tracked separately per endpoint and learned from the same
// headers. Until an endpoint has answered once its method budget is unknown
// and therefore unconstrained — the app window still bounds it.

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
  cancel: (reason: Error) => void
  /** Which method budget this request draws on, if known. */
  methodKey?: string
}

/** Per-endpoint budget, learned from X-Method-Rate-Limit. */
interface MethodState {
  windows: RateWindow[]
  hits: number[][]
  /** Backoff for this endpoint alone, from a method-scoped 429. */
  retryAfterUntil: number
}

const DEFAULT_APP_WINDOWS: RateWindow[] = [
  { limit: 20, intervalMs: 1000 },
  { limit: 100, intervalMs: 120_000 }
]

export class RateLimiter {
  private appWindows: RateWindow[]
  private readonly safety: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  /** Timestamps of recent requests, one array per window. */
  private hits: number[][]
  /** Per-endpoint budgets, keyed by method. */
  private readonly methods = new Map<string, MethodState>()
  private readonly queue: QueueItem[] = []
  private draining = false
  private inFlight = 0
  /** Resolves the drain loop's current wait early. See `waitForSlot`. */
  private wake: (() => void) | null = null
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

  status(): {
    inFlight: number
    queued: number
    retryAfterUntil?: number
    etaMs?: number
  } {
    const etaMs = this.estimateDrainMs()
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      retryAfterUntil: this.retryAfterUntil > this.now() ? this.retryAfterUntil : undefined,
      etaMs: etaMs > 0 ? etaMs : undefined
    }
  }

  /** The windows currently in force, for tests and diagnostics. */
  get windows(): RateWindow[] {
    return this.appWindows.map((w) => ({ ...w }))
  }

  /** The learned budget for one endpoint, for tests and diagnostics. */
  methodWindows(methodKey: string): RateWindow[] {
    return (this.methods.get(methodKey)?.windows ?? []).map((w) => ({ ...w }))
  }

  /**
   * Schedule work; resolves with the result once a slot is available.
   *
   * `methodKey` names the endpoint (not the URL — the *method*, so every
   * match-v5 fetch shares one budget regardless of match id). Omitting it means
   * the request is bounded only by the app windows.
   */
  schedule<T>(fn: () => Promise<T>, methodKey?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        methodKey,
        cancel: reject,
        run: () => {
          this.inFlight++
          fn()
            .then(resolve, reject)
            .finally(() => {
              this.inFlight--
            })
        }
      })
      // A parked drain is waiting on the *previous* head's window. This new
      // request may be on an endpoint with budget to spare right now, so cut
      // the wait short and let the loop re-scan.
      this.wake?.()
      void this.drain()
    })
  }

  /**
   * Drop everything still queued. Called on shutdown: after a game ends there
   * can be well over a hundred queued match lookups that would otherwise keep
   * firing for minutes against a process that is trying to exit.
   */
  clearQueue(): void {
    const dropped = this.queue.splice(0, this.queue.length)
    for (const item of dropped) item.cancel(new Error('Rate limiter shut down'))
    // Otherwise the loop stays parked on a window that no longer has anything
    // waiting behind it — for up to two minutes on the slow app window.
    this.wake?.()
  }

  /**
   * Force a backoff window, e.g. after a 429. `seconds` from Retry-After.
   *
   * Riot's X-Rate-Limit-Type says which budget was exceeded. A method-scoped
   * 429 must not stall every other endpoint, so pass `methodKey` to confine the
   * backoff; without it the whole app backs off.
   */
  applyRetryAfter(seconds: number, methodKey?: string): void {
    if (!Number.isFinite(seconds)) return
    const until = this.now() + Math.max(0, seconds) * 1000
    if (methodKey) {
      const st = this.methodState(methodKey)
      if (until > st.retryAfterUntil) st.retryAfterUntil = until
      return
    }
    if (until > this.retryAfterUntil) this.retryAfterUntil = until
  }

  /**
   * Adopt the app-wide limits Riot advertises in X-App-Rate-Limit, formatted
   * like "20:1,100:120" (limit:seconds). Existing hit timestamps are carried
   * over into matching windows so we never forget requests we already made.
   */
  applyLimitsFromHeader(limitHeader: string | null | undefined): void {
    const parsed = parseLimitHeader(limitHeader)
    if (parsed.length === 0) return
    if (sameWindows(parsed, this.appWindows)) return

    const previous = this.appWindows
    const previousHits = this.hits
    this.appWindows = parsed
    this.hits = carryOverHits(parsed, previous, previousHits)
  }

  /**
   * Adopt one endpoint's budget from X-Method-Rate-Limit. Same format as the
   * app header, but scoped to `methodKey`.
   */
  applyMethodLimitsFromHeader(
    methodKey: string | undefined,
    limitHeader: string | null | undefined
  ): void {
    if (!methodKey) return
    const parsed = parseLimitHeader(limitHeader)
    if (parsed.length === 0) return
    const st = this.methodState(methodKey)
    if (sameWindows(parsed, st.windows)) return
    const previous = st.windows
    const previousHits = st.hits
    st.windows = parsed
    st.hits = carryOverHits(parsed, previous, previousHits)
  }

  /**
   * Reconcile our local counters against Riot's authoritative count header,
   * formatted like "count:interval,count:interval" (X-App-Rate-Limit-Count).
   * If Riot thinks we've used more than we recorded, add synthetic hits so we
   * throttle sooner.
   */
  reconcileFromHeader(countHeader: string | null | undefined): void {
    this.reconcile(this.appWindows, this.hits, countHeader)
  }

  /** As above, for one endpoint's X-Method-Rate-Limit-Count. */
  reconcileMethodFromHeader(
    methodKey: string | undefined,
    countHeader: string | null | undefined
  ): void {
    if (!methodKey) return
    const st = this.methods.get(methodKey)
    // Nothing to reconcile against until the budget itself is known.
    if (!st || st.windows.length === 0) return
    this.reconcile(st.windows, st.hits, countHeader)
  }

  private reconcile(
    windows: RateWindow[],
    hits: number[][],
    countHeader: string | null | undefined
  ): void {
    if (!countHeader) return
    for (const part of countHeader.split(',').map((p) => p.trim())) {
      const [countStr, intervalStr] = part.split(':')
      const count = Number(countStr)
      const intervalMs = Number(intervalStr) * 1000
      if (!Number.isFinite(count) || !Number.isFinite(intervalMs)) continue
      const idx = windows.findIndex((w) => w.intervalMs === intervalMs)
      if (idx < 0) continue
      pruneWindows(windows, hits, this.now())
      const localCount = hits[idx].length
      if (count > localCount) {
        // Backfill synthetic hits dated "now" so they expire with the window.
        const t = this.now()
        for (let i = 0; i < count - localCount; i++) hits[idx].push(t)
      }
    }
  }

  private methodState(methodKey: string): MethodState {
    let st = this.methods.get(methodKey)
    if (!st) {
      st = { windows: [], hits: [], retryAfterUntil: 0 }
      this.methods.set(methodKey, st)
    }
    return st
  }

  /** Ms until a request on `methodKey` is permitted (0 if right now). */
  private msUntilSlot(methodKey?: string): number {
    const t = this.now()
    pruneWindows(this.appWindows, this.hits, t)
    let wait = Math.max(0, this.retryAfterUntil - t)
    wait = Math.max(wait, this.windowWait(this.appWindows, this.hits, t))

    if (methodKey) {
      const st = this.methods.get(methodKey)
      if (st) {
        pruneWindows(st.windows, st.hits, t)
        wait = Math.max(wait, st.retryAfterUntil - t)
        wait = Math.max(wait, this.windowWait(st.windows, st.hits, t))
      }
    }
    return Math.max(0, wait)
  }

  /** Ms until the next slot opens across a set of windows. */
  private windowWait(windows: RateWindow[], hits: number[][], t: number): number {
    let wait = 0
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]
      const cap = this.capOf(w)
      const arr = hits[i]
      if (arr.length >= cap) {
        // Must wait until the oldest hit still counted in this window expires.
        const oldest = arr[arr.length - cap]
        wait = Math.max(wait, oldest + w.intervalMs - t)
      }
    }
    return wait
  }

  private capOf(w: RateWindow): number {
    return Math.max(1, Math.floor(w.limit * this.safety))
  }

  private recordHit(methodKey?: string): void {
    const t = this.now()
    for (const arr of this.hits) arr.push(t)
    if (!methodKey) return
    const st = this.methods.get(methodKey)
    // Record against the method budget only once it is known; an unknown
    // budget has no windows to charge against.
    if (st) for (const arr of st.hits) arr.push(t)
  }

  /**
   * Estimated ms until everything currently queued has been dispatched.
   *
   * Simulates the greedy schedule each budget would permit and takes the
   * binding one. It's an estimate, not a promise: it can't know about requests
   * a caller hasn't queued yet, retries, or a 429 that hasn't happened.
   */
  estimateDrainMs(): number {
    const q = this.queue.length
    if (q === 0) return 0
    const t = this.now()
    let finish = this.retryAfterUntil

    pruneWindows(this.appWindows, this.hits, t)
    finish = Math.max(finish, this.nthIssueTime(this.appWindows, this.hits, q, t))

    // Each endpoint's own budget can be the binding constraint.
    const perMethod = new Map<string, number>()
    for (const item of this.queue) {
      if (!item.methodKey) continue
      perMethod.set(item.methodKey, (perMethod.get(item.methodKey) ?? 0) + 1)
    }
    for (const [key, count] of perMethod) {
      const st = this.methods.get(key)
      if (!st || st.windows.length === 0) continue
      pruneWindows(st.windows, st.hits, t)
      finish = Math.max(finish, st.retryAfterUntil)
      finish = Math.max(finish, this.nthIssueTime(st.windows, st.hits, count, t))
    }
    return Math.max(0, finish - t)
  }

  /**
   * Absolute time at which the k-th additional request could be issued under a
   * set of windows, assuming they are dispatched as fast as the budget allows.
   *
   * A request is admitted once the hit `cap` places before it has aged out, so
   * issue times chain off the combined (existing + projected) sequence.
   */
  private nthIssueTime(
    windows: RateWindow[],
    hits: number[][],
    k: number,
    t: number
  ): number {
    let latest = t
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]
      const cap = this.capOf(w)
      const existing = hits[i]
      const projected: number[] = []
      for (let n = 1; n <= k; n++) {
        const idx = existing.length + n - cap - 1
        let at = t
        if (idx >= 0) {
          const prior =
            idx < existing.length ? existing[idx] : projected[idx - existing.length]
          at = Math.max(t, prior + w.intervalMs)
        }
        projected.push(at)
      }
      latest = Math.max(latest, projected[k - 1])
    }
    return latest
  }

  /**
   * Sleep until a slot opens, or until `wake` fires — whichever comes first.
   * A plain sleep would pin the loop to the head request's window, so anything
   * queued behind it sat idle even with budget available on its own endpoint.
   */
  private async waitForSlot(ms: number): Promise<void> {
    let resolveWake: () => void = () => {}
    const woken = new Promise<void>((resolve) => {
      resolveWake = resolve
    })
    this.wake = resolveWake
    try {
      await Promise.race([this.sleep(ms), woken])
    } finally {
      this.wake = null
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        // Pick the first request that can go now. Strict FIFO would let one
        // method-throttled endpoint block requests to endpoints with budget to
        // spare, stalling the whole board behind its slowest fan-out.
        let readyIdx = -1
        let shortest = Number.POSITIVE_INFINITY
        for (let i = 0; i < this.queue.length; i++) {
          const wait = this.msUntilSlot(this.queue[i].methodKey)
          if (wait <= 0) {
            readyIdx = i
            break
          }
          if (wait < shortest) shortest = wait
        }
        if (readyIdx < 0) {
          await this.waitForSlot(shortest)
          continue
        }
        const [item] = this.queue.splice(readyIdx, 1)
        if (!item) break
        this.recordHit(item.methodKey)
        item.run()
      }
    } finally {
      this.draining = false
    }
  }
}

/** Parse "20:1,100:120" into rate windows, ignoring malformed segments. */
export function parseLimitHeader(header: string | null | undefined): RateWindow[] {
  if (!header) return []
  const windows: RateWindow[] = []
  for (const part of header.split(',')) {
    const [limitStr, secondsStr] = part.trim().split(':')
    const limit = Number(limitStr)
    const seconds = Number(secondsStr)
    if (!Number.isFinite(limit) || !Number.isFinite(seconds)) continue
    if (limit <= 0 || seconds <= 0) continue
    windows.push({ limit, intervalMs: seconds * 1000 })
  }
  return windows
}

function sameWindows(a: RateWindow[], b: RateWindow[]): boolean {
  return (
    a.length === b.length &&
    a.every((w, i) => w.limit === b[i].limit && w.intervalMs === b[i].intervalMs)
  )
}

/** Carry recorded hits into a new window set, matching on interval length. */
function carryOverHits(
  next: RateWindow[],
  previous: RateWindow[],
  previousHits: number[][]
): number[][] {
  return next.map((w) => {
    const idx = previous.findIndex((p) => p.intervalMs === w.intervalMs)
    return idx >= 0 ? [...previousHits[idx]] : []
  })
}

/** Remove expired timestamps from every window. */
function pruneWindows(windows: RateWindow[], hits: number[][], t: number): void {
  for (let i = 0; i < windows.length; i++) {
    const cutoff = t - windows[i].intervalMs
    const arr = hits[i]
    if (!arr) continue
    let keep = 0
    while (keep < arr.length && arr[keep] <= cutoff) keep++
    if (keep > 0) arr.splice(0, keep)
  }
}
