import { describe, it, expect } from 'vitest'
import { RateLimiter, parseLimitHeader } from '../src/main/riot/rateLimiter'

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
        await Promise.resolve()
        timers.sort((a, b) => a.at - b.at)
      }
      t = target
      await Promise.resolve()
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
