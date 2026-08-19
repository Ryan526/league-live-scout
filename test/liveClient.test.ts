import { describe, it, expect } from 'vitest'
import { mergeLivePlayer, parsePlayers } from '../src/main/liveClient'
import type { LivePlayer } from '../src/shared/types'

// A trimmed sample of the /liveclientdata/allgamedata payload.
const SAMPLE = {
  gameData: { gameMode: 'CLASSIC', gameTime: 42 },
  allPlayers: [
    {
      riotIdGameName: 'Faker',
      riotIdTagLine: 'KR1',
      riotId: 'Faker#KR1',
      championName: 'Ahri',
      team: 'ORDER',
      position: 'MIDDLE',
      isBot: false,
      summonerSpells: {
        summonerSpellOne: { displayName: 'Flash' },
        summonerSpellTwo: { displayName: 'Ignite' }
      },
      scores: { kills: 3, deaths: 1, assists: 5, creepScore: 120, wardScore: 12.5 }
    },
    {
      // Older-style payload with only a combined riotId string.
      riotId: 'Some Jungler#NA1',
      championName: 'LeeSin',
      team: 'CHAOS',
      position: 'JUNGLE',
      isBot: false,
      summonerSpells: {
        summonerSpellOne: { displayName: 'Smite' },
        summonerSpellTwo: { displayName: 'Flash' }
      }
    },
    {
      summonerName: 'Bot Sona',
      championName: 'Sona',
      team: 'CHAOS',
      isBot: true
    }
  ]
}

describe('parsePlayers', () => {
  it('splits Riot IDs from explicit fields', () => {
    const players = parsePlayers(SAMPLE)
    const faker = players[0]
    expect(faker.gameName).toBe('Faker')
    expect(faker.tagLine).toBe('KR1')
    expect(faker.team).toBe('ORDER')
    expect(faker.summonerSpells).toEqual(['Flash', 'Ignite'])
    expect(faker.scores?.creepScore).toBe(120)
    expect(faker.isBot).toBe(false)
  })

  it('parses a combined name#tag string when split fields are absent', () => {
    const players = parsePlayers(SAMPLE)
    const jg = players[1]
    expect(jg.gameName).toBe('Some Jungler')
    expect(jg.tagLine).toBe('NA1')
    expect(jg.summonerSpells).toContain('Smite')
  })

  it('flags bots and tolerates missing spell/score data', () => {
    const players = parsePlayers(SAMPLE)
    const bot = players[2]
    expect(bot.isBot).toBe(true)
    expect(bot.summonerSpells).toEqual([])
    expect(bot.scores).toBeUndefined()
  })

  it('returns all players present', () => {
    expect(parsePlayers(SAMPLE)).toHaveLength(3)
  })

  it('populates the assigned position for both teams', () => {
    const players = parsePlayers(SAMPLE)
    expect(players[0].position).toBe('MIDDLE')
    // CHAOS is the enemy team — the Live Client tells us their lane too.
    expect(players[1].position).toBe('JUNGLE')
  })

  it('normalizes MID and SUPPORT spellings', () => {
    const players = parsePlayers({
      allPlayers: [
        { championName: 'Ahri', position: 'MID' },
        { championName: 'Thresh', position: 'SUPPORT' }
      ]
    })
    expect(players[0].position).toBe('MIDDLE')
    expect(players[1].position).toBe('UTILITY')
  })

  it('maps an empty or absent position to UNKNOWN', () => {
    const players = parsePlayers({
      allPlayers: [{ championName: 'Ahri', position: '' }, { championName: 'Ashe' }]
    })
    expect(players[0].position).toBe('UNKNOWN')
    expect(players[1].position).toBe('UNKNOWN')
  })
})

function player(over: Partial<LivePlayer> = {}): LivePlayer {
  return {
    riotId: 'Faker#KR1',
    gameName: 'Faker',
    tagLine: 'KR1',
    championName: 'Ahri',
    team: 'ORDER',
    position: 'MIDDLE',
    summonerSpells: ['Flash', 'Ignite'],
    isBot: false,
    scores: { kills: 3, deaths: 1, assists: 5, creepScore: 120, wardScore: 12 },
    ...over
  }
}

describe('mergeLivePlayer', () => {
  it('keeps a known position when a later poll reports UNKNOWN', () => {
    const merged = mergeLivePlayer(player(), player({ position: 'UNKNOWN' }))
    expect(merged.position).toBe('MIDDLE')
  })

  it('keeps the last scoreboard when a later poll omits scores', () => {
    const merged = mergeLivePlayer(player(), player({ scores: undefined }))
    expect(merged.scores?.kills).toBe(3)
    expect(merged.scores?.creepScore).toBe(120)
  })

  it('keeps a resolved champion id/key when the next poll has neither', () => {
    const existing = player({ championId: 103, championKey: 'Ahri' })
    const merged = mergeLivePlayer(
      existing,
      player({ championId: undefined, championKey: undefined })
    )
    expect(merged.championId).toBe(103)
    expect(merged.championKey).toBe('Ahri')
  })

  it('keeps a full Riot ID when a later poll drops the tag line', () => {
    const merged = mergeLivePlayer(player(), player({ riotId: '', tagLine: '' }))
    expect(merged.riotId).toBe('Faker#KR1')
    expect(merged.tagLine).toBe('KR1')
  })

  it('does take genuinely new values', () => {
    const merged = mergeLivePlayer(
      player({ position: 'UNKNOWN', scores: undefined }),
      player({ position: 'TOP', scores: { kills: 9, deaths: 2, assists: 1, creepScore: 200, wardScore: 4 } })
    )
    expect(merged.position).toBe('TOP')
    expect(merged.scores?.kills).toBe(9)
  })
})
