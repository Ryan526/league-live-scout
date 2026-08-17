import { describe, it, expect } from 'vitest'
import { TtlCache } from '../src/main/riot/cache'

describe('TtlCache', () => {
  it('returns stored values before expiry and undefined after', () => {
    let t = 0
    const cache = new TtlCache({ ttlMs: 1000, now: () => t })
    cache.set('k', 42)
    expect(cache.get<number>('k')).toBe(42)
    t = 999
    expect(cache.get<number>('k')).toBe(42)
    t = 1001
    expect(cache.get<number>('k')).toBeUndefined()
  })

  it('getOrCompute computes once then serves from cache', async () => {
    let t = 0
    let calls = 0
    const cache = new TtlCache({ ttlMs: 1000, now: () => t })
    const compute = async () => {
      calls++
      return 'v'
    }
    expect(await cache.getOrCompute('k', compute)).toBe('v')
    expect(await cache.getOrCompute('k', compute)).toBe('v')
    expect(calls).toBe(1)
    t = 2000
    expect(await cache.getOrCompute('k', compute)).toBe('v')
    expect(calls).toBe(2)
  })

  it('honors a per-entry TTL override', () => {
    let t = 0
    const cache = new TtlCache({ ttlMs: 1000, now: () => t })
    cache.set('short', 1, 10)
    t = 11
    expect(cache.get('short')).toBeUndefined()
  })
})
