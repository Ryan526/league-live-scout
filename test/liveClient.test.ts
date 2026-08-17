import { describe, it, expect } from 'vitest'
import { parsePlayers } from '../src/main/liveClient'

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
})
