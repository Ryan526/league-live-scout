import { describe, it, expect } from 'vitest'
import { inferEnemyRole, resolveTeamRoles } from '../src/main/riot/roles'
import { DataDragon } from '../src/main/riot/ddragon'
import { DDRAGON_SAMPLE } from './fixtures'

const dd = new DataDragon()
dd.ingest(DDRAGON_SAMPLE)

describe('inferEnemyRole', () => {
  it('returns JUNGLE when the player has Smite', () => {
    expect(inferEnemyRole({ summonerSpells: ['Smite', 'Flash'] })).toBe('JUNGLE')
  })

  it('falls back to champion tags', () => {
    expect(
      inferEnemyRole({ summonerSpells: ['Flash', 'Heal'], champion: dd.resolve('MissFortune') })
    ).toBe('BOTTOM')
    expect(
      inferEnemyRole({ summonerSpells: ['Flash', 'Ignite'], champion: dd.resolve('Ahri') })
    ).toBe('MIDDLE')
  })

  it('returns UNKNOWN with no usable signal', () => {
    expect(inferEnemyRole({ summonerSpells: ['Flash', 'Barrier'] })).toBe('UNKNOWN')
  })
})

describe('resolveTeamRoles', () => {
  it('assigns each of the five lanes at most once', () => {
    const players = [
      { id: 'jg', input: { summonerSpells: ['Smite', 'Flash'], champion: dd.resolve('LeeSin') } },
      { id: 'adc', input: { summonerSpells: ['Flash', 'Heal'], champion: dd.resolve('MissFortune') } },
      { id: 'mid', input: { summonerSpells: ['Flash', 'Ignite'], champion: dd.resolve('Ahri') } },
      { id: 'sup', input: { summonerSpells: ['Flash', 'Exhaust'], champion: dd.resolve('Thresh') } },
      { id: 'top', input: { summonerSpells: ['Flash', 'Teleport'], champion: dd.resolve('Aatrox') } }
    ]
    const roles = resolveTeamRoles(players)
    expect(roles.get('jg')).toBe('JUNGLE')
    expect(roles.get('adc')).toBe('BOTTOM')
    expect(roles.get('mid')).toBe('MIDDLE')
    expect(roles.get('sup')).toBe('UTILITY')
    expect(roles.get('top')).toBe('TOP')
    // No lane assigned twice.
    expect(new Set(roles.values()).size).toBe(5)
  })

  it('resolves collisions when two champions prefer the same lane', () => {
    const players = [
      { id: 'a', input: { summonerSpells: ['Flash', 'Ignite'], champion: dd.resolve('Ahri') } }, // MIDDLE
      { id: 'b', input: { summonerSpells: ['Flash', 'Ignite'], champion: dd.resolve('Ahri') } } // MIDDLE too
    ]
    const roles = resolveTeamRoles(players)
    expect(new Set([roles.get('a'), roles.get('b')]).size).toBe(2) // pushed apart
  })
})
