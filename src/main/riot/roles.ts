// Current-role assignment for a team.
//
// For each player we may have anywhere from an exact answer to nothing at all:
//
//   * The Live Client's `position` field and the LCU's champ-select
//     `assignedPosition` are exact. Callers apply those themselves and pass the
//     lanes they consumed in as `taken`, so we never hand out a lane twice.
//   * For everyone else we score every (player, lane) pair from three weak
//     signals - the player's most-played ranked role, their summoner spells and
//     their champion's Data Dragon tags - and then pick the assignment that
//     maximises the whole team's score rather than greedily satisfying whoever
//     happens to come first. Five players over five lanes is 120 permutations,
//     so the true optimum is free.
//
// The old greedy version mapped Tank and Fighter both to TOP and Mage and
// Assassin both to MIDDLE, then dumped the loser of each collision into
// whatever lane was still open, which is why flex picks (Sett, Yasuo, Senna,
// Swain) mislabelled constantly.

import type { Role, RoleSource } from '@shared/types'
import { LANES } from '@shared/types'
import type { ChampionRecord } from './ddragon'

/** Riot spell display names as they appear in Live Client Data. */
const SMITE = 'Smite'

/** Smite is as close to proof as this app gets, so it outweighs everything. */
const SMITE_SCORE = 100

/** Weight per ranked game played in a lane, capped so a large sample can't
 *  drown out a Smite but comfortably beats champion tags. */
const MAIN_ROLE_PER_GAME = 4
const MAIN_ROLE_MAX_GAMES = 10

/** Champion-tag preference lists: first choice scores more than second. */
const TAG_FIRST_CHOICE = 10
const TAG_SECOND_CHOICE = 5

/**
 * Summoner spell hints. Values are deliberately smaller than the champion-tag
 * weights except for Smite, because a spell only narrows the field (Teleport is
 * common mid, Heal is occasionally support).
 */
const SPELL_HINTS: Record<string, Partial<Record<Role, number>>> = {
  smite: { JUNGLE: SMITE_SCORE },
  teleport: { TOP: 15 },
  heal: { BOTTOM: 15 },
  cleanse: { BOTTOM: 8 },
  exhaust: { UTILITY: 10, MIDDLE: 3 },
  ghost: { TOP: 8 },
  ignite: { MIDDLE: 5, TOP: 4, UTILITY: 4 },
  barrier: { MIDDLE: 5, BOTTOM: 5 }
}

/** Ordered lane preferences per Data Dragon tag. */
const TAG_PREFERENCES: Record<string, Role[]> = {
  Support: ['UTILITY'],
  Marksman: ['BOTTOM'],
  Mage: ['MIDDLE', 'UTILITY'],
  Assassin: ['MIDDLE', 'JUNGLE'],
  Fighter: ['TOP', 'MIDDLE'],
  Tank: ['TOP', 'UTILITY']
}

/** Rough single-lane guess from a champion's tags, used by inferEnemyRole. */
function roleFromTags(tags: string[]): Role {
  for (const tag of ['Support', 'Marksman', 'Mage', 'Assassin', 'Tank', 'Fighter']) {
    if (tags.includes(tag)) return TAG_PREFERENCES[tag][0]
  }
  return 'UNKNOWN'
}

export interface InferInput {
  summonerSpells: string[]
  champion?: ChampionRecord
}

/** A player to place, plus whatever extra signals the caller has gathered. */
export interface RoleCandidate {
  id: string
  input: InferInput
  /** Most-played ranked role from match history, when we have one. */
  mainRole?: Role
  /** How many ranked games that main role was derived from. */
  sampleSize?: number
}

function hasSmite(spells: string[]): boolean {
  return spells.some((s) => s.toLowerCase() === SMITE.toLowerCase())
}

/**
 * Infer a single enemy's role in isolation. Returns UNKNOWN when we have no
 * usable signal. Kept for the single-player case; prefer resolveTeamRoles when
 * a whole team is available, because it can avoid collisions.
 */
export function inferEnemyRole(input: InferInput): Role {
  if (hasSmite(input.summonerSpells)) return 'JUNGLE'
  if (input.champion) {
    const byTag = roleFromTags(input.champion.tags)
    if (byTag !== 'UNKNOWN') return byTag
  }
  return 'UNKNOWN'
}

/** Score one player against one lane. Higher is a better fit. */
export function scoreLane(candidate: RoleCandidate, lane: Role): number {
  let score = 0

  for (const spell of candidate.input.summonerSpells) {
    const hint = SPELL_HINTS[spell.toLowerCase()]
    if (hint) score += hint[lane] ?? 0
  }

  if (candidate.mainRole && candidate.mainRole === lane) {
    const games = Math.min(candidate.sampleSize ?? 0, MAIN_ROLE_MAX_GAMES)
    score += MAIN_ROLE_PER_GAME * games
  }

  for (const tag of candidate.input.champion?.tags ?? []) {
    const prefs = TAG_PREFERENCES[tag]
    if (!prefs) continue
    const idx = prefs.indexOf(lane)
    if (idx === 0) score += TAG_FIRST_CHOICE
    else if (idx > 0) score += TAG_SECOND_CHOICE
  }

  return score
}

/**
 * Assign lanes to a group of players so the team's total fit score is maximal.
 *
 * `taken` lets the caller reserve lanes already claimed by exact data (Live
 * Client position / champ select) so an inferred player can never be handed a
 * lane someone else already holds. Players left over once the lanes run out get
 * UNKNOWN. The result is deterministic: ties resolve towards the earlier lane
 * in ROLE_ORDER and the earlier player in the input list.
 */
export function resolveTeamRoles(
  players: RoleCandidate[],
  taken: Set<Role> = new Set()
): Map<string, Role> {
  const result = new Map<string, Role>()
  const lanes = LANES.filter((l) => !taken.has(l))
  if (players.length === 0) return result

  const scores = players.map((p) => lanes.map((lane) => scoreLane(p, lane)))

  // Exhaustive search over permutations. Bounded by 5 lanes, so the worst case
  // is 5! = 120 leaves; the greedy fallback below only exists for the
  // impossible-in-practice case of an oversized "team".
  const best = players.length <= LANES.length ? bestAssignment(scores, lanes.length) : null
  if (best) {
    players.forEach((p, i) => {
      const laneIdx = best[i]
      result.set(p.id, laneIdx < 0 ? 'UNKNOWN' : lanes[laneIdx])
    })
    return result
  }

  // Fallback: highest-scoring pairs first.
  const pairs: Array<{ p: number; l: number; score: number }> = []
  scores.forEach((row, p) => row.forEach((score, l) => pairs.push({ p, l, score })))
  pairs.sort((a, b) => b.score - a.score || a.p - b.p || a.l - b.l)
  const usedPlayer = new Set<number>()
  const usedLane = new Set<number>()
  for (const { p, l } of pairs) {
    if (usedPlayer.has(p) || usedLane.has(l)) continue
    usedPlayer.add(p)
    usedLane.add(l)
    result.set(players[p].id, lanes[l])
  }
  for (const p of players) {
    if (!result.has(p.id)) result.set(p.id, 'UNKNOWN')
  }
  return result
}

/**
 * Depth-first search over lane permutations, returning the lane index chosen
 * for each player (-1 when no lane was available). Keeps the first assignment
 * found at the best score, which makes the outcome stable across calls.
 */
function bestAssignment(scores: number[][], laneCount: number): number[] {
  const playerCount = scores.length
  const current = new Array<number>(playerCount).fill(-1)
  // Held on an object rather than in plain `let`s: TypeScript keeps the
  // declaration-site narrowing for locals assigned only inside a closure.
  const best: { choice: number[] | null; score: number } = { choice: null, score: -Infinity }
  const used = new Array<boolean>(laneCount).fill(false)

  const walk = (player: number, total: number): void => {
    if (player === playerCount) {
      if (total > best.score) {
        best.score = total
        best.choice = [...current]
      }
      return
    }
    let placed = false
    for (let lane = 0; lane < laneCount; lane++) {
      if (used[lane]) continue
      placed = true
      used[lane] = true
      current[player] = lane
      walk(player + 1, total + scores[player][lane])
      used[lane] = false
      current[player] = -1
    }
    // More players than open lanes: this one goes unassigned.
    if (!placed) walk(player + 1, total)
  }

  walk(0, 0)
  return best.choice ?? current
}

/** One player on one team, with every role signal we have for them. */
export interface TeamMember {
  id: string
  /** Lane reported by the Live Client. Exact, and available for both teams. */
  position?: Role
  /** Lane read from the LCU champ-select session. Exact, own team only. */
  champSelectRole?: Role
  summonerSpells: string[]
  champion?: ChampionRecord
  /** Most-played ranked role, once match history has loaded. */
  mainRole?: Role
  sampleSize?: number
}

export interface AssignedRole {
  role: Role
  source: RoleSource
}

/**
 * Assign a lane to every member of one team, in strict priority order:
 *
 *   1. `position` from the Live Client - exact, free, both teams.
 *   2. `champSelectRole` from the LCU - exact, own team.
 *   3. A scored inference over whatever lanes remain.
 *
 * Exact assignments reserve their lane before inference runs, so an inferred
 * player can never be handed a lane someone else already holds. Pure and
 * idempotent: the same input always produces the same output, which is what
 * lets the caller recompute from scratch on every poll instead of freezing an
 * early bad guess in place.
 */
export function assignTeamRoles(members: TeamMember[]): Map<string, AssignedRole> {
  const result = new Map<string, AssignedRole>()
  const taken = new Set<Role>()
  const remaining: TeamMember[] = []

  for (const m of members) {
    if (m.position && m.position !== 'UNKNOWN' && !taken.has(m.position)) {
      result.set(m.id, { role: m.position, source: 'live' })
      taken.add(m.position)
      continue
    }
    if (
      m.champSelectRole &&
      m.champSelectRole !== 'UNKNOWN' &&
      !taken.has(m.champSelectRole)
    ) {
      result.set(m.id, { role: m.champSelectRole, source: 'champselect' })
      taken.add(m.champSelectRole)
      continue
    }
    remaining.push(m)
  }

  if (remaining.length > 0) {
    const inferred = resolveTeamRoles(
      remaining.map((m) => ({
        id: m.id,
        input: { summonerSpells: m.summonerSpells, champion: m.champion },
        mainRole: m.mainRole,
        sampleSize: m.sampleSize
      })),
      taken
    )
    for (const m of remaining) {
      result.set(m.id, { role: inferred.get(m.id) ?? 'UNKNOWN', source: 'inferred' })
    }
  }

  return result
}
