// Best-effort current-role inference for enemy players, who are NOT revealed by
// the LCU champ-select API. We combine two weak signals available from Live
// Client Data: summoner spells (Smite => Jungle is near-certain) and the
// picked champion's Data Dragon tags. This is explicitly approximate and the UI
// labels enemy roles as inferred.

import type { Role } from '@shared/types'
import type { ChampionRecord } from './ddragon'

/** Riot spell display names as they appear in Live Client Data. */
const SMITE = 'Smite'

/** Rough mapping from a champion's primary tag to a likely lane. This is only a
 *  fallback when spells are inconclusive. */
function roleFromTags(tags: string[]): Role {
  const t = new Set(tags)
  if (t.has('Support')) return 'UTILITY'
  if (t.has('Marksman')) return 'BOTTOM'
  if (t.has('Mage')) return 'MIDDLE'
  if (t.has('Assassin')) return 'MIDDLE'
  if (t.has('Tank')) return 'TOP'
  if (t.has('Fighter')) return 'TOP'
  return 'UNKNOWN'
}

export interface InferInput {
  summonerSpells: string[]
  champion?: ChampionRecord
}

/**
 * Infer a single enemy's role. Returns UNKNOWN when we have no usable signal.
 * Confidence is intentionally not modeled — callers should present this as a
 * hint, not fact.
 */
export function inferEnemyRole(input: InferInput): Role {
  if (input.summonerSpells.some((s) => s.toLowerCase() === SMITE.toLowerCase())) {
    return 'JUNGLE'
  }
  if (input.champion) {
    const byTag = roleFromTags(input.champion.tags)
    if (byTag !== 'UNKNOWN') return byTag
  }
  return 'UNKNOWN'
}

/**
 * Given a full team of inferred roles, resolve collisions so each of the five
 * lanes is assigned at most once where possible. Jungle (from Smite) is treated
 * as fixed; the remaining players are distributed over the open lanes by their
 * tag preference, then arbitrarily to fill gaps.
 */
export function resolveTeamRoles(
  players: Array<{ id: string; input: InferInput }>
): Map<string, Role> {
  const result = new Map<string, Role>()
  const lanes: Role[] = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']
  const taken = new Set<Role>()

  // Pass 1: lock in high-confidence Smite junglers.
  for (const p of players) {
    if (p.input.summonerSpells.some((s) => s.toLowerCase() === SMITE.toLowerCase())) {
      if (!taken.has('JUNGLE')) {
        result.set(p.id, 'JUNGLE')
        taken.add('JUNGLE')
      }
    }
  }

  // Pass 2: assign tag-preferred lane if still open.
  for (const p of players) {
    if (result.has(p.id)) continue
    const pref = p.input.champion ? roleFromTags(p.input.champion.tags) : 'UNKNOWN'
    if (pref !== 'UNKNOWN' && !taken.has(pref)) {
      result.set(p.id, pref)
      taken.add(pref)
    }
  }

  // Pass 3: fill any remaining players into remaining lanes.
  for (const p of players) {
    if (result.has(p.id)) continue
    const open = lanes.find((l) => !taken.has(l))
    if (open) {
      result.set(p.id, open)
      taken.add(open)
    } else {
      result.set(p.id, 'UNKNOWN')
    }
  }

  return result
}
