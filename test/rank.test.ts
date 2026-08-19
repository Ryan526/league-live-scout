import { describe, it, expect } from 'vitest'
import { rankScore, type RankEntry } from '../src/shared/types'

function r(tier: string, rank: string, lp: number): RankEntry {
  return { queueType: 'RANKED_SOLO_5x5', tier, rank, leaguePoints: lp, wins: 0, losses: 0 }
}

describe('rankScore', () => {
  it('orders tiers correctly', () => {
    expect(rankScore(r('GOLD', 'IV', 0))).toBeGreaterThan(rankScore(r('SILVER', 'I', 99)))
    expect(rankScore(r('DIAMOND', 'IV', 0))).toBeGreaterThan(rankScore(r('EMERALD', 'I', 100)))
  })

  it('orders divisions within a tier (I is highest)', () => {
    expect(rankScore(r('GOLD', 'I', 0))).toBeGreaterThan(rankScore(r('GOLD', 'IV', 99)))
    expect(rankScore(r('GOLD', 'II', 50))).toBeGreaterThan(rankScore(r('GOLD', 'III', 50)))
  })

  it('uses LP to separate apex tiers', () => {
    expect(rankScore(r('CHALLENGER', 'I', 800))).toBeGreaterThan(
      rankScore(r('GRANDMASTER', 'I', 500))
    )
    expect(rankScore(r('MASTER', 'I', 300))).toBeGreaterThan(rankScore(r('MASTER', 'I', 100)))
  })

  it('scores unranked/undefined as -1', () => {
    expect(rankScore(null)).toBe(-1)
    expect(rankScore(undefined)).toBe(-1)
  })
})

