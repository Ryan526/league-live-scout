// Persistent per-PUUID peak Solo/Duo rank.
//
// The Riot API has no "all-time / season peak" endpoint — third-party sites keep
// their own historical database. We do the same, on a small scale: every time we
// observe a player's current Solo/Duo rank we record it and keep the highest ever
// seen. Peak therefore starts equal to the first rank we see for a player and can
// only climb, immediately flagging anyone now sitting below their best (a classic
// smurf / decliner signal).

import Store from 'electron-store'
import type { RankEntry } from '@shared/types'
import { rankScore } from '@shared/types'

interface PeakSchema {
  /** Map of PUUID -> highest observed Solo/Duo RankEntry. */
  peaks: Record<string, RankEntry>
}

/** Roughly a thousand games' worth of opponents; oldest entries fall off. */
const MAX_TRACKED_PLAYERS = 5000

export class PeakRankStore {
  private store: Store<PeakSchema>

  constructor() {
    this.store = new Store<PeakSchema>({ name: 'peak-ranks', defaults: { peaks: {} } })
  }

  /**
   * Record an observed rank; returns the (possibly updated) peak. A null/absent
   * observation doesn't lower an existing peak, and only an actual improvement
   * writes to disk.
   */
  observe(puuid: string, rank: RankEntry | null | undefined): RankEntry | null {
    const peaks = this.store.get('peaks')
    const current = peaks[puuid] ?? null
    if (rank && rankScore(rank) > rankScore(current)) {
      peaks[puuid] = rank
      this.store.set('peaks', trim(peaks))
      return rank
    }
    return current
  }

  /** Forget every tracked peak (exposed in Settings). */
  clear(): void {
    this.store.set('peaks', {})
  }
}

/** Bound the map so it can't grow for the lifetime of the install. Object key
 *  order is insertion order for string keys, so this drops the oldest. */
function trim(peaks: Record<string, RankEntry>): Record<string, RankEntry> {
  const keys = Object.keys(peaks)
  if (keys.length <= MAX_TRACKED_PLAYERS) return peaks
  const trimmed: Record<string, RankEntry> = {}
  for (const k of keys.slice(keys.length - MAX_TRACKED_PLAYERS)) trimmed[k] = peaks[k]
  return trimmed
}
