import { describe, it, expect } from 'vitest'
import { DataDragon } from '../src/main/riot/ddragon'
import { DDRAGON_SAMPLE } from './fixtures'

describe('DataDragon.resolve', () => {
  const dd = new DataDragon()
  dd.ingest(DDRAGON_SAMPLE)

  it('resolves by internal key (Live Client championName)', () => {
    expect(dd.resolve('Aatrox')?.id).toBe(266)
    expect(dd.resolve('MissFortune')?.id).toBe(21)
  })

  it('resolves by display name including spaces', () => {
    expect(dd.resolve('Miss Fortune')?.id).toBe(21)
    expect(dd.resolve('Lee Sin')?.id).toBe(64)
  })

  it('is case-insensitive', () => {
    expect(dd.resolve('aatrox')?.id).toBe(266)
  })

  it('maps numeric id back to a record', () => {
    expect(dd.byId(103)?.name).toBe('Ahri')
    expect(dd.byId(999)).toBeUndefined()
  })

  it('exposes the patch version', () => {
    expect(dd.currentPatch).toBe('14.16.1')
  })

  it('resolves the internal key used by the CDN icon URLs', () => {
    // The Live Client sends display names; Data Dragon files are named by key.
    expect(dd.resolve('Master Yi')?.key).toBe('MasterYi')
    expect(dd.resolve('MasterYi')?.key).toBe('MasterYi')
    expect(dd.resolve('Wukong')?.key).toBe('MonkeyKing')
    expect(dd.resolve('Miss Fortune')?.key).toBe('MissFortune')
  })

  it('resolves punctuated and spaced names without a linear scan', () => {
    expect(dd.resolve('master yi')?.id).toBe(11)
    expect(dd.resolve('MISS FORTUNE')?.id).toBe(21)
  })

  it('returns undefined for unknown champions', () => {
    expect(dd.resolve('Nonexistent')).toBeUndefined()
    expect(dd.resolve('')).toBeUndefined()
  })
})
