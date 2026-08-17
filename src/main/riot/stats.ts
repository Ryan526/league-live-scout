// Pure functions that derive per-player stats from match-v5 data. Kept free of
// I/O so they can be unit-tested against recorded fixtures.

import type { MatchDerivedStats, Role } from '@shared/types'
import type { MatchDto, MatchParticipantDto } from './client'

export const ROLES: Role[] = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']

/** Normalize the various position strings Riot returns to our Role union. */
export function normalizeRole(pos: string | undefined): Role {
  switch ((pos ?? '').toUpperCase()) {
    case 'TOP':
      return 'TOP'
    case 'JUNGLE':
      return 'JUNGLE'
    case 'MIDDLE':
    case 'MID':
      return 'MIDDLE'
    case 'BOTTOM':
    case 'BOT':
    case 'ADC':
      return 'BOTTOM'
    case 'UTILITY':
    case 'SUPPORT':
      return 'UTILITY'
    default:
      return 'UNKNOWN'
  }
}

/** Find a given player's participant record within a match. */
export function findParticipant(
  match: MatchDto,
  puuid: string
): MatchParticipantDto | undefined {
  return match.info.participants.find((p) => p.puuid === puuid)
}

export interface DeriveOptions {
  /** Numeric champion id of the currently-picked champion, for win-rate filter. */
  championId?: number
  /** Only count "real" games (exclude very short remakes < 5 min). */
  minDurationSec?: number
  /** When set, only include matches whose queueId is in this list (e.g. ranked
   *  queues). Defensive: match ids are already fetched with type=ranked. */
  queueIds?: number[]
}

/**
 * Derive aggregate stats for `puuid` from a set of that player's matches.
 * Matches should already be the player's own recent games (match-v5 by-puuid).
 */
export function deriveStats(
  puuid: string,
  matches: MatchDto[],
  opts: DeriveOptions = {}
): MatchDerivedStats {
  const minDuration = opts.minDurationSec ?? 300
  const queueFilter = opts.queueIds ? new Set(opts.queueIds) : null
  const roleCounts: Partial<Record<Role, number>> = {}
  const recentForm: Array<'W' | 'L'> = []

  let sampleSize = 0
  let sumK = 0
  let sumD = 0
  let sumA = 0
  let champGames = 0
  let champWins = 0

  // match-v5 returns most-recent-first when fetched via the id list order.
  for (const match of matches) {
    const p = findParticipant(match, puuid)
    if (!p) continue
    // Ranked-only: skip any non-ranked queue that slipped through.
    if (queueFilter && !queueFilter.has(match.info.queueId)) continue
    // Skip remakes / very short games from the aggregate.
    if (match.info.gameDuration > 0 && match.info.gameDuration < minDuration) continue

    sampleSize++
    sumK += p.kills
    sumD += p.deaths
    sumA += p.assists

    const role = normalizeRole(p.teamPosition || p.individualPosition)
    if (role !== 'UNKNOWN') roleCounts[role] = (roleCounts[role] ?? 0) + 1

    recentForm.push(p.win ? 'W' : 'L')

    if (opts.championId != null && p.championId === opts.championId) {
      champGames++
      if (p.win) champWins++
    }
  }

  // KDA ratio over the whole sample: (totalKills + totalAssists) / totalDeaths,
  // with a floor of 1 death to avoid divide-by-zero (a "perfect" sample).
  const kdaRatio = sampleSize > 0 ? (sumK + sumA) / Math.max(1, sumD) : null

  return {
    sampleSize,
    championWinRate: champGames > 0 ? champWins / champGames : null,
    championGames: champGames,
    championWins: champWins,
    avgKda: kdaRatio,
    avgKills: sampleSize > 0 ? sumK / sampleSize : 0,
    avgDeaths: sampleSize > 0 ? sumD / sampleSize : 0,
    avgAssists: sampleSize > 0 ? sumA / sampleSize : 0,
    mainRole: modeRole(roleCounts),
    roleCounts,
    recentForm: recentForm.slice(0, 10)
  }
}

/** Most-played role, or UNKNOWN if none recorded. */
export function modeRole(roleCounts: Partial<Record<Role, number>>): Role {
  let best: Role = 'UNKNOWN'
  let bestN = 0
  for (const role of ROLES) {
    const n = roleCounts[role] ?? 0
    if (n > bestN) {
      bestN = n
      best = role
    }
  }
  return best
}

/** Overall ranked win rate from wins/losses. */
export function winRate(wins: number, losses: number): number | null {
  const total = wins + losses
  return total > 0 ? wins / total : null
}
