import { describe, it, expect } from 'vitest'
import { parseRetryAfter, projectMatch, type MatchDto } from '../src/main/riot/client'

describe('parseRetryAfter', () => {
  it('reads plain delay-seconds', () => {
    expect(parseRetryAfter('5')).toBe(5)
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('reads an HTTP-date instead of returning NaN', () => {
    // Number('Wed, 21 Oct 2015 07:28:00 GMT') is NaN, which used to disable the
    // backoff gate entirely and make setTimeout(fn, NaN) fire immediately —
    // four retries straight back at an endpoint that had just 429'd.
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:30 GMT', now)).toBe(30)
  })

  it('never returns a negative wait for a date in the past', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:30:00 GMT')
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(0)
  })

  it('falls back to one second for missing or unparseable values', () => {
    expect(parseRetryAfter(null)).toBe(1)
    expect(parseRetryAfter('')).toBe(1)
    expect(parseRetryAfter('soon-ish')).toBe(1)
  })

  it('always returns a finite number', () => {
    for (const h of [null, '', 'nonsense', '3', 'Thu, 01 Jan 1970 00:00:10 GMT']) {
      expect(Number.isFinite(parseRetryAfter(h, 0))).toBe(true)
    }
  })
})

describe('projectMatch', () => {
  it('keeps only the fields the app reads', () => {
    // A raw match-v5 participant carries ~150 fields; caching them whole meant
    // re-serializing tens of MB after a few games.
    const raw = {
      metadata: { matchId: 'NA1_1', participants: Array(10).fill('puuid-x'), dataVersion: '2' },
      info: {
        queueId: 420,
        gameDuration: 1800,
        gameCreation: 1_700_000_000,
        gameVersion: '14.16.1',
        participants: [
          {
            puuid: 'p1',
            teamId: 100,
            championId: 103,
            kills: 5,
            deaths: 2,
            assists: 9,
            win: true,
            teamPosition: 'MIDDLE',
            individualPosition: 'MIDDLE',
            totalMinionsKilled: 180,
            neutralMinionsKilled: 12,
            summoner1Id: 4,
            perks: { statPerks: {}, styles: [] },
            challenges: { kda: 7 },
            item0: 3020
          }
        ]
      }
    } as unknown as MatchDto

    const projected = projectMatch(raw)
    expect(Object.keys(projected.metadata)).toEqual(['matchId'])
    expect(Object.keys(projected.info).sort()).toEqual([
      'gameDuration',
      'participants',
      'queueId'
    ])
    const p = projected.info.participants[0]
    expect(Object.keys(p)).not.toContain('perks')
    expect(Object.keys(p)).not.toContain('challenges')
    expect(Object.keys(p)).not.toContain('item0')
    // Everything the stats derivation actually uses survives.
    expect(p.puuid).toBe('p1')
    expect(p.teamId).toBe(100)
    expect(p.championId).toBe(103)
    expect(p.teamPosition).toBe('MIDDLE')
    expect(p.totalMinionsKilled).toBe(180)
    expect(p.neutralMinionsKilled).toBe(12)
    expect(projected.info.queueId).toBe(420)
    expect(projected.metadata.matchId).toBe('NA1_1')
  })

  it('tolerates a payload with no participants', () => {
    const projected = projectMatch({
      metadata: { matchId: 'NA1_2' },
      info: { queueId: 420, gameDuration: 0, participants: [] }
    })
    expect(projected.info.participants).toEqual([])
  })
})
