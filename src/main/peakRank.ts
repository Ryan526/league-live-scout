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

export class PeakRankStore {
  private store: Store<PeakSchema>

  constructor() {
    this.store = new Store<PeakSchema>({ name: 'peak-ranks', defaults: { peaks: {} } })
  }

  getPeak(puuid: string): RankEntry | null {
    return this.store.get('peaks')[puuid] ?? null
  }

  /**
   * Record an observed rank; returns the (possibly updated) peak. A null/absent
   * observation doesn't lower an existing peak.
   */
  observe(puuid: string, rank: RankEntry | null | undefined): RankEntry | null {
    const peaks = this.store.get('peaks')
    const current = peaks[puuid] ?? null
    if (rank && rankScore(rank) > rankScore(current)) {
      peaks[puuid] = rank
      this.store.set('peaks', peaks)
      return rank
    }
    return current
  }
}
