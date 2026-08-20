import { describe, it, expect } from 'vitest'
import { RateLimiter, parseLimitHeader } from '../src/main/riot/rateLimiter'

/** Let every pending continuation run. A single `await Promise.resolve()`
 *  only drains one microtask tick, which is not enough for the limiter's
 *  wake-up path (race -> finally -> resume caller). */
async function flush(ticks = 16): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
}

/** A controllable fake clock + sleep so tests are deterministic and instant. */
function fakeClock() {
  let t = 0
  const timers: Array<{ at: number; resolve: () => void }> = []
  return {
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => timers.push({ at: t + ms, resolve })),
    /** Advance virtual time, firing any sleeps that come due. */
    async advance(ms: number) {
      const target = t + ms
      // Fire timers in order until we reach the target time.
      timers.sort((a, b) => a.at - b.at)
      while (timers.length && timers[0].at <= target) {
        const timer = timers.shift()!
        t = timer.at
        timer.resolve()
        // Let scheduled continuations run.
        await flush()
        timers.sort((a, b) => a.at - b.at)
      }
      t = target
      await flush()
    }
  }
}

describe('RateLimiter', () => {
  it('runs requests immediately while under the window cap', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({
      appWindows: [{ limit: 5, intervalMs: 1000 }],
      safety: 1,
      now: clock.now,
      sleep: clock.sleep
    })
    const order: number[] = []
    const promises = Array.from({ length: 5 }, (_, i) =>
      limiter.schedule(async () => {
        order.push(i)
        return i
      })
    )
    await clock.advance(0)
    await Promise.all(promises)
    expect(order).toEqual([0, 1, 2, 3, 4])
  })

  it('throttles requests beyond the window cap', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({
      appWindows: [{ limit: 2, intervalMs: 1000 }],
      safety: 1,
      now: clock.now,
      sleep: clock.sleep
    })
    const done: number[] = []
    for (let i = 0; i < 4; i++) {
      void limiter.schedule(async () => {
        done.push(i)
      })
    }
    // First two fit immediately.
    await clock.advance(0)
    expect(done).toEqual([0, 1])

    // Nothing more until the 1s window rolls over.
    await clock.advance(500)
    expect(done).toEqual([0, 1])

    await clock.advance(600) // now > 1000ms since first two
    expect(done).toEqual([0, 1, 2, 3])
  })

  it('respects a Retry-After backoff', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({
      appWindows: [{ limit: 100, intervalMs: 1000 }],
      safety: 1,
      now: clock.now,
      sleep: clock.sleep
    })
    limiter.applyRetryAfter(2) // 2 second backoff
    const done: string[] = []
    void limiter.schedule(async () => {
      done.push('ran')
    })
    await clock.advance(1000)
    expect(done).toEqual([]) // still backing off
    await clock.advance(1500)
    expect(done).toEqual(['ran'])
  })

  it('reports backoff status while a retry window is active', () => {
    let t = 0
    const limiter = new RateLimiter({ now: () => t })
    limiter.applyRetryAfter(5)
    expect(limiter.status().retryAfterUntil).toBe(5000)
    t = 6000
    expect(limiter.status().retryAfterUntil).toBeUndefined()
  })

  it('reconciles local counters up to Riot header counts', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({
      appWindows: [{ limit: 10, intervalMs: 10 }],
      safety: 1,
      now: clock.now,
      sleep: clock.sleep
    })
    // Pretend Riot says we've already used 10 in the 10s window... wait, header
    // interval is in seconds. Interval 10ms won't match a header, so use a
    // limiter whose window is 10s.
    const l2 = new RateLimiter({
      appWindows: [{ limit: 10, intervalMs: 10_000 }],
      safety: 1,
      now: clock.now,
      sleep: clock.sleep
    })
    l2.reconcileFromHeader('10:10') // 10 used in the 10s window
    const done: string[] = []
    void l2.schedule(async () => done.push('ran'))
    await clock.advance(0)
    // Window is full per Riot; our request must wait.
    expect(done).toEqual([])
    await clock.advance(10_000)
    expect(done).toEqual(['ran'])
    void limiter // silence unused
  })
})

describe('parseLimitHeader', () => {
  it('parses the limit:seconds pairs Riot sends', () => {
    expect(parseLimitHeader('20:1,100:120')).toEqual([
      { limit: 20, intervalMs: 1000 },
      { limit: 100, intervalMs: 120_000 }
    ])
  })

  it('ignores empty and malformed input', () => {
    expect(parseLimitHeader(null)).toEqual([])
    expect(parseLimitHeader('')).toEqual([])
    expect(parseLimitHeader('nonsense')).toEqual([])
    expect(parseLimitHeader('0:1,20:0,30:60')).toEqual([{ limit: 30, intervalMs: 60_000 }])
  })
})

describe('applyLimitsFromHeader', () => {
  it('adopts the budget Riot advertises', () => {
    const limiter = new RateLimiter()
    // A production key is roughly 300x a dev key; hardcoding the dev numbers
    // throttled it for no reason.
    limiter.applyLimitsFromHeader('500:10,30000:600')
    expect(limiter.windows).toEqual([
      { limit: 500, intervalMs: 10_000 },
      { limit: 30000, intervalMs: 600_000 }
    ])
  })

  it('carries recorded hits over into a matching window', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({
      appWindows: [{ limit: 2, intervalMs: 1000 }],
      safety: 1,
      now: clock.now,
      sleep: clock.sleep
    })
    await limiter.schedule(async () => 'a')
    await limiter.schedule(async () => 'b')
    // Same interval, bigger allowance: the two requests we already made must
    // still count against it.
    limiter.applyLimitsFromHeader('10:1')
    expect(limiter.windows).toEqual([{ limit: 10, intervalMs: 1000 }])

    // Eight more fit inside the widened window without waiting.
    let done = 0
    for (let i = 0; i < 8; i++) void limiter.schedule(async () => done++)
    await clock.advance(0)
    expect(done).toBe(8)
    // The ninth does not: 2 + 8 = 10 is the cap.
    let ninth = false
    void limiter.schedule(async () => (ninth = true))
    await clock.advance(0)
    expect(ninth).toBe(false)
  })

  it('leaves the windows alone for empty or identical headers', () => {
    const limiter = new RateLimiter()
    const before = limiter.windows
    limiter.applyLimitsFromHeader(null)
    limiter.applyLimitsFromHeader('20:1,100:120')
    expect(limiter.windows).toEqual(before)
  })
})

describe('clearQueue', () => {
  it('rejects everything still waiting', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({
      appWindows: [{ limit: 1, intervalMs: 10_000 }],
      safety: 1,
      now: clock.now,
      sleep: clock.sleep
    })
    await limiter.schedule(async () => 'first') // consumes the only slot
    const queued = limiter.schedule(async () => 'never')
    await clock.advance(0)
    expect(limiter.status().queued).toBe(1)

    limiter.clearQueue()
    await expect(queued).rejects.toThrow('Rate limiter shut down')
    expect(limiter.status().queued).toBe(0)
  })
})

describe('method rate limits', () => {
  /** Roomy app budget so the method window is provably what binds. */
  const roomy = [{ limit: 1000, intervalMs: 1000 }]

  it('starts unconstrained until the endpoint has answered once', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ appWindows: roomy, now: clock.now, sleep: clock.sleep })
    let done = 0
    for (let i = 0; i < 5; i++) void limiter.schedule(async () => done++, 'match-v5.getMatch')
    await clock.advance(0)
    expect(done).toBe(5)
    expect(limiter.methodWindows('match-v5.getMatch')).toEqual([])
  })

  it('throttles on the method budget even when the app budget is idle', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ appWindows: roomy, now: clock.now, sleep: clock.sleep })
    limiter.applyMethodLimitsFromHeader('match-v5.getMatch', '2:10')

    let done = 0
    for (let i = 0; i < 4; i++) void limiter.schedule(async () => done++, 'match-v5.getMatch')
    await clock.advance(0)
    // safety 0.95 of 2 -> cap 1 per 10s.
    expect(done).toBe(1)
    await clock.advance(10_000)
    expect(done).toBe(2)
  })

  it('keeps each endpoint on its own budget', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ appWindows: roomy, now: clock.now, sleep: clock.sleep })
    limiter.applyMethodLimitsFromHeader('match-v5.getMatch', '2:10')

    const order: string[] = []
    // The throttled endpoint is queued first; a different endpoint must not be
    // stuck behind it.
    for (let i = 0; i < 3; i++) {
      void limiter.schedule(async () => order.push('match'), 'match-v5.getMatch')
    }
    void limiter.schedule(async () => order.push('rank'), 'league-v4.getEntriesByPUUID')
    await clock.advance(0)
    expect(order).toEqual(['match', 'rank'])
  })

  it('confines a method-scoped 429 to that endpoint', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ appWindows: roomy, now: clock.now, sleep: clock.sleep })
    limiter.applyRetryAfter(5, 'match-v5.getMatch')

    const order: string[] = []
    void limiter.schedule(async () => order.push('match'), 'match-v5.getMatch')
    void limiter.schedule(async () => order.push('rank'), 'league-v4.getEntriesByPUUID')
    await clock.advance(0)
    expect(order).toEqual(['rank'])
    // A method backoff is not an app backoff.
    expect(limiter.status().retryAfterUntil).toBeUndefined()
    await clock.advance(5000)
    expect(order).toEqual(['rank', 'match'])
  })

  it('reconciles a method count only once its budget is known', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ appWindows: roomy, now: clock.now, sleep: clock.sleep })
    // No budget yet: nothing to charge against, and no crash.
    limiter.reconcileMethodFromHeader('match-v5.getMatch', '9:10')
    limiter.applyMethodLimitsFromHeader('match-v5.getMatch', '10:10')
    limiter.reconcileMethodFromHeader('match-v5.getMatch', '9:10')

    let done = 0
    for (let i = 0; i < 2; i++) void limiter.schedule(async () => done++, 'match-v5.getMatch')
    await clock.advance(0)
    // cap is floor(10*0.95)=9 and Riot says 9 are already spent.
    expect(done).toBe(0)
    await clock.advance(10_000)
    expect(done).toBe(2)
  })

  it('carries method hits across a budget change', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ appWindows: roomy, now: clock.now, sleep: clock.sleep })
    limiter.applyMethodLimitsFromHeader('m', '10:10')
    await limiter.schedule(async () => 'a', 'm')
    limiter.applyMethodLimitsFromHeader('m', '2:10')
    expect(limiter.methodWindows('m')).toEqual([{ limit: 2, intervalMs: 10_000 }])
    let done = 0
    void limiter.schedule(async () => done++, 'm')
    await clock.advance(0)
    // The earlier hit carried over and already fills the cap of 1.
    expect(done).toBe(0)
  })
})

describe('queue ETA', () => {
  it('is absent when nothing is queued', () => {
    const limiter = new RateLimiter()
    expect(limiter.status().etaMs).toBeUndefined()
  })

  it('estimates the wait imposed by the app window', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({
      appWindows: [{ limit: 2, intervalMs: 1000 }],
      now: clock.now,
      sleep: clock.sleep
    })
    // cap is floor(2*0.95)=1, so these go one per second.
    for (let i = 0; i < 4; i++) void limiter.schedule(async () => 'x')
    await clock.advance(0)
    // One dispatched, three still queued: they land at +1s, +2s, +3s.
    const { queued, etaMs } = limiter.status()
    expect(queued).toBe(3)
    expect(etaMs).toBe(3000)
  })

  it('accounts for a method budget the app budget would not reveal', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({
      appWindows: [{ limit: 1000, intervalMs: 1000 }],
      now: clock.now,
      sleep: clock.sleep
    })
    limiter.applyMethodLimitsFromHeader('m', '2:10')
    for (let i = 0; i < 3; i++) void limiter.schedule(async () => 'x', 'm')
    await clock.advance(0)
    // App budget alone would say "now"; the method cap of 1/10s says 20s.
    expect(limiter.status().etaMs).toBe(20_000)
  })

  it('includes an active backoff', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ now: clock.now, sleep: clock.sleep })
    limiter.applyRetryAfter(30)
    void limiter.schedule(async () => 'x')
    await clock.advance(0)
    expect(limiter.status().etaMs).toBe(30_000)
  })
})
