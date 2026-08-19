import { describe, it, expect } from 'vitest'
import {
  assignTeamRoles,
  inferEnemyRole,
  resolveTeamRoles,
  type RoleCandidate
} from '../src/main/riot/roles'
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

  it('picks the whole-team optimum, not greedy first-come', () => {
    // Ashe is tagged Marksman+Support, so she fits both BOTTOM and UTILITY;
    // Miss Fortune is Marksman only. A greedy pass in this order would give
    // Ashe BOTTOM and shunt Miss Fortune somewhere arbitrary.
    const players: RoleCandidate[] = [
      { id: 'ashe', input: { summonerSpells: ['Flash'], champion: dd.resolve('Ashe') } },
      { id: 'mf', input: { summonerSpells: ['Flash'], champion: dd.resolve('MissFortune') } }
    ]
    const roles = resolveTeamRoles(players)
    expect(roles.get('mf')).toBe('BOTTOM')
    expect(roles.get('ashe')).toBe('UTILITY')
  })

  it('never re-issues a lane that is already taken', () => {
    const players: RoleCandidate[] = [
      // Would love JUNGLE, but it's spoken for.
      { id: 'smiter', input: { summonerSpells: ['Smite', 'Flash'], champion: dd.resolve('LeeSin') } },
      { id: 'adc', input: { summonerSpells: ['Flash', 'Heal'], champion: dd.resolve('MissFortune') } }
    ]
    const taken = new Set(['JUNGLE', 'TOP'] as const)
    const roles = resolveTeamRoles(players, new Set(taken))
    expect([...roles.values()]).not.toContain('JUNGLE')
    expect([...roles.values()]).not.toContain('TOP')
    expect(roles.get('adc')).toBe('BOTTOM')
  })

  it('puts a Smiter in JUNGLE regardless of champion tags', () => {
    // Miss Fortune is a pure Marksman, but Smite is decisive.
    const players: RoleCandidate[] = [
      { id: 'smite-mf', input: { summonerSpells: ['Smite', 'Flash'], champion: dd.resolve('MissFortune') } },
      { id: 'real-adc', input: { summonerSpells: ['Flash', 'Heal'], champion: dd.resolve('Ashe') } }
    ]
    const roles = resolveTeamRoles(players)
    expect(roles.get('smite-mf')).toBe('JUNGLE')
    expect(roles.get('real-adc')).toBe('BOTTOM')
  })

  it('prefers a known main role over champion tags', () => {
    // Sett is Fighter+Tank, i.e. a TOP pick by tags — but this player has ten
    // ranked games in the support role.
    const players: RoleCandidate[] = [
      {
        id: 'sett-sup',
        input: { summonerSpells: ['Flash', 'Ignite'], champion: dd.resolve('Sett') },
        mainRole: 'UTILITY',
        sampleSize: 10
      }
    ]
    expect(resolveTeamRoles(players).get('sett-sup')).toBe('UTILITY')
  })

  it('ignores a main role backed by no games', () => {
    const players: RoleCandidate[] = [
      {
        id: 'sett',
        input: { summonerSpells: ['Flash', 'Teleport'], champion: dd.resolve('Sett') },
        mainRole: 'UTILITY',
        sampleSize: 0
      }
    ]
    expect(resolveTeamRoles(players).get('sett')).toBe('TOP')
  })

  it('sends a second Fighter to its second preference, not a random gap', () => {
    const players: RoleCandidate[] = [
      { id: 'aatrox', input: { summonerSpells: ['Flash', 'Teleport'], champion: dd.resolve('Aatrox') } },
      { id: 'sett', input: { summonerSpells: ['Flash', 'Ignite'], champion: dd.resolve('Sett') } }
    ]
    const roles = resolveTeamRoles(players)
    // Aatrox has Teleport, so he keeps TOP; Sett takes the Fighter second
    // choice rather than being dumped into whichever lane came first.
    expect(roles.get('aatrox')).toBe('TOP')
    expect(roles.get('sett')).toBe('MIDDLE')
  })

  it('is deterministic across repeated calls', () => {
    const players: RoleCandidate[] = [
      { id: 'a', input: { summonerSpells: ['Flash'] } },
      { id: 'b', input: { summonerSpells: ['Flash'] } },
      { id: 'c', input: { summonerSpells: ['Flash'] } }
    ]
    const first = [...resolveTeamRoles(players).entries()]
    for (let i = 0; i < 5; i++) {
      expect([...resolveTeamRoles(players).entries()]).toEqual(first)
    }
  })
})

describe('assignTeamRoles', () => {
  it('trusts the Live Client position over any inference', () => {
    const assigned = assignTeamRoles([
      {
        id: 'p1',
        // Marksman with Heal — everything says BOTTOM — but the game says TOP.
        position: 'TOP',
        summonerSpells: ['Flash', 'Heal'],
        champion: dd.resolve('MissFortune')
      }
    ])
    expect(assigned.get('p1')).toEqual({ role: 'TOP', source: 'live' })
  })

  it('falls back to champ select, then to inference', () => {
    const assigned = assignTeamRoles([
      { id: 'live', position: 'JUNGLE', summonerSpells: ['Flash'] },
      { id: 'cs', champSelectRole: 'UTILITY', summonerSpells: ['Flash'] },
      {
        id: 'guess',
        summonerSpells: ['Flash', 'Heal'],
        champion: dd.resolve('MissFortune')
      }
    ])
    expect(assigned.get('live')).toEqual({ role: 'JUNGLE', source: 'live' })
    expect(assigned.get('cs')).toEqual({ role: 'UTILITY', source: 'champselect' })
    expect(assigned.get('guess')).toEqual({ role: 'BOTTOM', source: 'inferred' })
  })

  it('reserves exact lanes so inference cannot duplicate them', () => {
    const assigned = assignTeamRoles([
      // Exact: this player holds JUNGLE.
      { id: 'real-jg', position: 'JUNGLE', summonerSpells: ['Flash'] },
      // Has Smite and would otherwise be assigned JUNGLE too.
      {
        id: 'smiter',
        summonerSpells: ['Smite', 'Flash'],
        champion: dd.resolve('LeeSin')
      }
    ])
    expect(assigned.get('real-jg')?.role).toBe('JUNGLE')
    expect(assigned.get('smiter')?.role).not.toBe('JUNGLE')
  })

  it('ignores an UNKNOWN position and infers instead', () => {
    const assigned = assignTeamRoles([
      {
        id: 'p1',
        position: 'UNKNOWN',
        summonerSpells: ['Smite', 'Flash'],
        champion: dd.resolve('LeeSin')
      }
    ])
    expect(assigned.get('p1')).toEqual({ role: 'JUNGLE', source: 'inferred' })
  })
})
