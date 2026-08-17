import { describe, it, expect } from 'vitest'
import {
  detectPremades,
  sharedSameTeamCount,
  premadeLabel,
  type PremadeInput
} from '../src/main/riot/premades'

function m(matchId: string, teamId: number) {
  return { matchId, teamId }
}

describe('sharedSameTeamCount', () => {
  it('counts only matches shared on the same historical team', () => {
    const a: PremadeInput = { key: 'a', matches: [m('1', 100), m('2', 100), m('3', 200)] }
    const b: PremadeInput = { key: 'b', matches: [m('1', 100), m('2', 200), m('3', 200)] }
    // m1: same team (100/100) -> counts. m2: 100 vs 200 -> no. m3: 200/200 -> counts.
    expect(sharedSameTeamCount(a, b)).toBe(2)
  })
})

describe('detectPremades', () => {
  it('flags a duo that shares 2+ same-team games', () => {
    const team: PremadeInput[] = [
      { key: 'a', matches: [m('1', 100), m('2', 100)] },
      { key: 'b', matches: [m('1', 100), m('2', 100)] },
      { key: 'c', matches: [m('9', 200)] },
      { key: 'd', matches: [m('8', 100)] },
      { key: 'e', matches: [m('7', 100)] }
    ]
    const groups = detectPremades(team, 2)
    expect(groups.get('a')).toBe(0)
    expect(groups.get('b')).toBe(0)
    expect(groups.has('c')).toBe(false)
    expect(groups.has('d')).toBe(false)
  })

  it('does not flag players who only meet as enemies', () => {
    const team: PremadeInput[] = [
      { key: 'a', matches: [m('1', 100), m('2', 100)] },
      { key: 'b', matches: [m('1', 200), m('2', 200)] } // opposite team both times
    ]
    expect(detectPremades(team, 2).size).toBe(0)
  })

  it('unions a trio transitively into one group', () => {
    const team: PremadeInput[] = [
      { key: 'a', matches: [m('1', 100), m('2', 100)] },
      { key: 'b', matches: [m('1', 100), m('2', 100), m('3', 100), m('4', 100)] },
      { key: 'c', matches: [m('3', 100), m('4', 100)] }
    ]
    const groups = detectPremades(team, 2)
    // a-b share {1,2}, b-c share {3,4}; a-c share nothing but union via b.
    expect(groups.get('a')).toBe(groups.get('b'))
    expect(groups.get('b')).toBe(groups.get('c'))
    expect(new Set(groups.values()).size).toBe(1)
  })

  it('respects the threshold (1 shared game is not enough by default)', () => {
    const team: PremadeInput[] = [
      { key: 'a', matches: [m('1', 100)] },
      { key: 'b', matches: [m('1', 100)] }
    ]
    expect(detectPremades(team, 2).size).toBe(0)
    expect(detectPremades(team, 1).get('a')).toBe(0)
  })
})

describe('premadeLabel', () => {
  it('labels group sizes', () => {
    expect(premadeLabel(2)).toBe('Duo')
    expect(premadeLabel(3)).toBe('Trio')
    expect(premadeLabel(5)).toBe('5-stack')
  })
})
