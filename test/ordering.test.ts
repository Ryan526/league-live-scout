// End-to-end check of the thing the user actually sees: both teams listed
// Top / Jungle / Mid / Bot / Support, with no duplicate lanes, from a realistic
// mix of exact and inferred signals.

import { describe, it, expect } from 'vitest'
import { assignTeamRoles, type TeamMember } from '../src/main/riot/roles'
import { DataDragon } from '../src/main/riot/ddragon'
import { roleLabel, roleRank, type Role } from '../src/shared/types'
import { DDRAGON_SAMPLE } from './fixtures'

const dd = new DataDragon()
dd.ingest(DDRAGON_SAMPLE)

/** Our own team: the Live Client knows three lanes, champ select covers a
 *  fourth, and the last player has to be inferred. */
const OWN_TEAM: TeamMember[] = [
  {
    id: 'own-top',
    position: 'TOP',
    summonerSpells: ['Flash', 'Teleport'],
    champion: dd.resolve('Aatrox')
  },
  {
    id: 'own-jg',
    position: 'JUNGLE',
    summonerSpells: ['Smite', 'Flash'],
    champion: dd.resolve('LeeSin')
  },
  {
    id: 'own-mid',
    position: 'MIDDLE',
    summonerSpells: ['Flash', 'Ignite'],
    champion: dd.resolve('Ahri')
  },
  {
    // No Live Client position yet (loading screen), but champ select had it.
    id: 'own-sup',
    champSelectRole: 'UTILITY',
    summonerSpells: ['Flash', 'Exhaust'],
    champion: dd.resolve('Thresh')
  },
  {
    // Nothing exact at all — must be inferred into the one remaining lane.
    id: 'own-adc',
    summonerSpells: ['Flash', 'Heal'],
    champion: dd.resolve('MissFortune')
  }
]

/** Enemy team: no exact data whatsoever, including two Fighter-tagged flex
 *  picks that the old tag-collision logic scattered at random. */
const ENEMY_TEAM: TeamMember[] = [
  {
    id: 'enemy-a',
    summonerSpells: ['Flash', 'Teleport'],
    champion: dd.resolve('Aatrox') // Fighter/Tank + Teleport -> TOP
  },
  {
    id: 'enemy-b',
    summonerSpells: ['Smite', 'Flash'],
    champion: dd.resolve('LeeSin') // Smite -> JUNGLE
  },
  {
    id: 'enemy-c',
    summonerSpells: ['Flash', 'Ignite'],
    champion: dd.resolve('Sett'), // Fighter/Tank, but plays support
    mainRole: 'UTILITY',
    sampleSize: 9
  },
  {
    id: 'enemy-d',
    summonerSpells: ['Flash', 'Heal'],
    champion: dd.resolve('MissFortune') // Marksman + Heal -> BOTTOM
  },
  {
    id: 'enemy-e',
    summonerSpells: ['Flash', 'Barrier'],
    champion: dd.resolve('Ahri') // Mage -> MIDDLE
  }
]

function rolesOf(team: TeamMember[]): Map<string, Role> {
  const assigned = assignTeamRoles(team)
  return new Map([...assigned].map(([id, a]) => [id, a.role]))
}

/** Sort exactly the way Scoreboard.tsx does. */
function sortedLanes(team: TeamMember[]): string[] {
  const roles = rolesOf(team)
  return [...team]
    .sort((a, b) => {
      const byRole = roleRank(roles.get(a.id)) - roleRank(roles.get(b.id))
      return byRole !== 0 ? byRole : a.id.localeCompare(b.id)
    })
    .map((m) => roleLabel(roles.get(m.id) ?? 'UNKNOWN'))
}

describe('scoreboard ordering', () => {
  it('lists our own team Top/Jungle/Mid/Bot/Support', () => {
    expect(sortedLanes(OWN_TEAM)).toEqual(['Top', 'Jungle', 'Mid', 'Bot', 'Support'])
  })

  it('lists an inference-only enemy team Top/Jungle/Mid/Bot/Support', () => {
    expect(sortedLanes(ENEMY_TEAM)).toEqual(['Top', 'Jungle', 'Mid', 'Bot', 'Support'])
  })

  it('never assigns the same lane twice on either team', () => {
    for (const team of [OWN_TEAM, ENEMY_TEAM]) {
      const roles = [...rolesOf(team).values()]
      expect(roles).toHaveLength(5)
      expect(new Set(roles).size).toBe(5)
      expect(roles).not.toContain('UNKNOWN')
    }
  })

  it('places each specific player in the lane we expect', () => {
    const own = rolesOf(OWN_TEAM)
    expect(own.get('own-top')).toBe('TOP')
    expect(own.get('own-jg')).toBe('JUNGLE')
    expect(own.get('own-mid')).toBe('MIDDLE')
    expect(own.get('own-sup')).toBe('UTILITY')
    expect(own.get('own-adc')).toBe('BOTTOM')

    const enemy = rolesOf(ENEMY_TEAM)
    expect(enemy.get('enemy-a')).toBe('TOP')
    expect(enemy.get('enemy-b')).toBe('JUNGLE')
    // Ranked history beats the Fighter/Tank tags that used to force him TOP.
    expect(enemy.get('enemy-c')).toBe('UTILITY')
    expect(enemy.get('enemy-d')).toBe('BOTTOM')
    expect(enemy.get('enemy-e')).toBe('MIDDLE')
  })

  it('marks exact roles as fact and guesses as guesses', () => {
    const own = assignTeamRoles(OWN_TEAM)
    expect(own.get('own-top')?.source).toBe('live')
    expect(own.get('own-sup')?.source).toBe('champselect')
    expect(own.get('own-adc')?.source).toBe('inferred')
    for (const a of assignTeamRoles(ENEMY_TEAM).values()) {
      expect(a.source).toBe('inferred')
    }
  })

  it('stays stable across repeated assignment passes', () => {
    // The real app recomputes roles from scratch on every poll, so a wobbling
    // result would make the scoreboard visibly reshuffle as stats stream in.
    for (const team of [OWN_TEAM, ENEMY_TEAM]) {
      const first = sortedLanes(team)
      for (let i = 0; i < 10; i++) expect(sortedLanes(team)).toEqual(first)
    }
  })

  it('does not reorder when stats arrive and confirm the same roles', () => {
    const before = rolesOf(ENEMY_TEAM)
    // Enrichment lands: every player's main role now matches what we guessed.
    const enriched = ENEMY_TEAM.map((m) => ({
      ...m,
      mainRole: before.get(m.id),
      sampleSize: 10
    }))
    expect(rolesOf(enriched)).toEqual(before)
  })
})
