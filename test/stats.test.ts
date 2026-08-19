import { describe, it, expect } from 'vitest'
import { deriveStats, normalizeRole, modeRole } from '../src/main/riot/stats'
import { match, participant } from './fixtures'

const ME = 'puuid-me'

describe('normalizeRole', () => {
  it('maps Riot position strings to canonical roles', () => {
    expect(normalizeRole('TOP')).toBe('TOP')
    expect(normalizeRole('MID')).toBe('MIDDLE')
    expect(normalizeRole('BOT')).toBe('BOTTOM')
    expect(normalizeRole('ADC')).toBe('BOTTOM')
    expect(normalizeRole('SUPPORT')).toBe('UTILITY')
    expect(normalizeRole('UTILITY')).toBe('UTILITY')
    expect(normalizeRole('')).toBe('UNKNOWN')
    expect(normalizeRole(undefined)).toBe('UNKNOWN')
  })
})

describe('deriveStats', () => {
  it('computes champion win rate for the picked champion only', () => {
    const matches = [
      match('m1', [participant({ puuid: ME, championId: 103, win: true })]),
      match('m2', [participant({ puuid: ME, championId: 103, win: false })]),
      match('m3', [participant({ puuid: ME, championId: 103, win: true })]),
      match('m4', [participant({ puuid: ME, championId: 266, win: false })]) // different champ
    ]
    const stats = deriveStats(ME, matches, { championId: 103 })
    expect(stats.championGames).toBe(3)
    expect(stats.championWins).toBe(2)
    expect(stats.championWinRate).toBeCloseTo(2 / 3)
    expect(stats.sampleSize).toBe(4)
  })

  it('computes KDA ratio over the whole sample with a death floor', () => {
    const matches = [
      match('m1', [participant({ puuid: ME, kills: 10, deaths: 0, assists: 0 })])
    ]
    const stats = deriveStats(ME, matches, {})
    // (10 + 0) / max(1, 0) = 10
    expect(stats.kdaRatio).toBe(10)
  })

  it('averages KDA correctly across games', () => {
    const matches = [
      match('m1', [participant({ puuid: ME, kills: 4, deaths: 2, assists: 6 })]),
      match('m2', [participant({ puuid: ME, kills: 6, deaths: 4, assists: 4 })])
    ]
    const stats = deriveStats(ME, matches, {})
    // total K=10, D=6, A=10 => (10+10)/6
    expect(stats.kdaRatio).toBeCloseTo(20 / 6)
    expect(stats.avgKills).toBe(5)
    expect(stats.avgDeaths).toBe(3)
    expect(stats.avgAssists).toBe(5)
  })

  it('derives main role as the mode of recent positions', () => {
    const matches = [
      match('m1', [participant({ puuid: ME, teamPosition: 'JUNGLE' })]),
      match('m2', [participant({ puuid: ME, teamPosition: 'JUNGLE' })]),
      match('m3', [participant({ puuid: ME, teamPosition: 'MIDDLE' })])
    ]
    const stats = deriveStats(ME, matches, {})
    expect(stats.mainRole).toBe('JUNGLE')
    expect(stats.roleCounts.JUNGLE).toBe(2)
    expect(stats.roleCounts.MIDDLE).toBe(1)
  })

  it('excludes remakes shorter than the minimum duration', () => {
    const matches = [
      match('m1', [participant({ puuid: ME, win: true })], { gameDuration: 120 }), // remake
      match('m2', [participant({ puuid: ME, win: false })], { gameDuration: 1800 })
    ]
    const stats = deriveStats(ME, matches, {})
    expect(stats.sampleSize).toBe(1)
    expect(stats.recentForm).toEqual(['L'])
  })

  it('includes only ranked queues when queueIds is set', () => {
    const matches = [
      match('m1', [participant({ puuid: ME, championId: 103, win: true })], { queueId: 420 }), // solo
      match('m2', [participant({ puuid: ME, championId: 103, win: true })], { queueId: 440 }), // flex
      match('m3', [participant({ puuid: ME, championId: 103, win: false })], { queueId: 400 }), // normal
      match('m4', [participant({ puuid: ME, championId: 103, win: false })], { queueId: 450 }) // ARAM
    ]
    const stats = deriveStats(ME, matches, { championId: 103, queueIds: [420, 440] })
    expect(stats.sampleSize).toBe(2) // normal + ARAM excluded
    expect(stats.championGames).toBe(2)
    expect(stats.championWinRate).toBe(1) // both ranked games were wins
  })

  it('handles no matching participant gracefully', () => {
    const matches = [match('m1', [participant({ puuid: 'someone-else' })])]
    const stats = deriveStats(ME, matches, { championId: 103 })
    expect(stats.sampleSize).toBe(0)
    expect(stats.championWinRate).toBeNull()
    expect(stats.kdaRatio).toBeNull()
    expect(stats.mainRole).toBe('UNKNOWN')
  })

  it('records recent form most-recent-first, capped at 10', () => {
    const matches = Array.from({ length: 12 }, (_, i) =>
      match(`m${i}`, [participant({ puuid: ME, win: i % 2 === 0 })])
    )
    const stats = deriveStats(ME, matches, {})
    expect(stats.recentForm).toHaveLength(10)
    expect(stats.recentForm[0]).toBe('W')
    expect(stats.recentForm[1]).toBe('L')
  })
})

describe('modeRole', () => {
  it('returns UNKNOWN when empty', () => {
    expect(modeRole({})).toBe('UNKNOWN')
  })
})
