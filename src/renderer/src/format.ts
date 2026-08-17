import type { RankEntry } from '@shared/types'

export function pct(v: number | null | undefined, digits = 0): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

export function num(v: number | null | undefined, digits = 1): string {
  if (v == null) return '—'
  return v.toFixed(digits)
}

/** Compact rank string, e.g. "Gold II · 45 LP". */
export function rankLabel(r: RankEntry | null | undefined): string {
  if (!r) return 'Unranked'
  const tier = r.tier.charAt(0) + r.tier.slice(1).toLowerCase()
  // Apex tiers (Master+) have no division.
  const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(r.tier)
  return apex ? `${tier} · ${r.leaguePoints} LP` : `${tier} ${r.rank} · ${r.leaguePoints} LP`
}

export function rankWinRate(r: RankEntry | null | undefined): number | null {
  if (!r) return null
  const total = r.wins + r.losses
  return total > 0 ? r.wins / total : null
}

/** Data Dragon square icon URL for a champion internal key (e.g. "Aatrox"). */
export function championIcon(patch: string | undefined, championKey: string): string | null {
  if (!patch || !championKey) return null
  return `https://ddragon.leagueoflegends.com/cdn/${patch}/img/champion/${championKey}.png`
}

/** Short tier code for a colored rank chip, e.g. "G2". */
export function tierClass(r: RankEntry | null | undefined): string {
  if (!r) return 'tier-unranked'
  return `tier-${r.tier.toLowerCase()}`
}

/** Map a KDA ratio to a qualitative class for coloring. */
export function kdaClass(kda: number | null | undefined): string {
  if (kda == null) return ''
  if (kda >= 4) return 'good'
  if (kda >= 2.5) return 'ok'
  if (kda < 1.5) return 'bad'
  return ''
}

/** Map a win rate (0..1) to a qualitative class for coloring. */
export function wrClass(wr: number | null | undefined): string {
  if (wr == null) return ''
  if (wr >= 0.58) return 'good'
  if (wr >= 0.52) return 'ok'
  if (wr < 0.45) return 'bad'
  return ''
}
