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

  it('de-duplicates concurrent in-flight computes for the same key', async () => {
    let calls = 0
    let resolveInner: (v: string) => void = () => {}
    const cache = new TtlCache({ ttlMs: 1000, now: () => 0 })
    const compute = () => {
      calls++
      return new Promise<string>((res) => {
        resolveInner = res
      })
    }
    // Fire 5 concurrent requests before the first resolves.
    const ps = Array.from({ length: 5 }, () => cache.getOrCompute('k', compute))
    resolveInner('v')
    const results = await Promise.all(ps)
    expect(results).toEqual(['v', 'v', 'v', 'v', 'v'])
    expect(calls).toBe(1) // only one underlying compute despite 5 callers
  })

  it('does not cache a rejected compute, allowing a later retry', async () => {
    let calls = 0
    const cache = new TtlCache({ ttlMs: 1000, now: () => 0 })
    const compute = async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return 'ok'
    }
    await expect(cache.getOrCompute('k', compute)).rejects.toThrow('boom')
    expect(await cache.getOrCompute('k', compute)).toBe('ok')
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
