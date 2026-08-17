// Best-effort premade / duo detection within a single team.
//
// Signal: two players who queued together will have played recent games
// *together on the same side*. We compare each teammate's recent match history
// and, for any match both appear in, require they shared the same historical
// team (teamId 100/200). Pairs that co-occurred on the same team at least
// `threshold` times are treated as premade, and we union them transitively so a
// trio/4-stack collapses into one group.
//
// This is inherently approximate (it can miss a brand-new duo with no shared
// history, and won't see premades whose match history is private), so callers
// should present it as a hint.

export interface PremadeInput {
  /** Stable key for the player (e.g. Riot ID). */
  key: string
  /** This player's recent matches as (matchId, historical teamId) pairs. */
  matches: Array<{ matchId: string; teamId: number }>
}

export interface PremadeGroup {
  /** 0-based group id, assigned in order of first member encountered. */
  group: number
  members: string[]
}

class UnionFind {
  private parent = new Map<string, string>()

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x)
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    // Path compression.
    let cur = x
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/** Count matches where both players were present on the same historical team. */
export function sharedSameTeamCount(a: PremadeInput, b: PremadeInput): number {
  const aMap = new Map(a.matches.map((m) => [m.matchId, m.teamId]))
  let count = 0
  for (const m of b.matches) {
    const at = aMap.get(m.matchId)
    if (at != null && at === m.teamId) count++
  }
  return count
}

/**
 * Group a team's players into premade cliques. Returns a map from player key to
 * a 0-based group id (only for players in a group of size >= 2). Solo players
 * are omitted from the map.
 */
export function detectPremades(
  team: PremadeInput[],
  threshold = 2
): Map<string, number> {
  const uf = new UnionFind()
  for (const p of team) uf.find(p.key) // ensure singletons exist

  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) {
      if (sharedSameTeamCount(team[i], team[j]) >= threshold) {
        uf.union(team[i].key, team[j].key)
      }
    }
  }

  // Collect components, keep only those with 2+ members.
  const byRoot = new Map<string, string[]>()
  for (const p of team) {
    const root = uf.find(p.key)
    const arr = byRoot.get(root) ?? []
    arr.push(p.key)
    byRoot.set(root, arr)
  }

  const result = new Map<string, number>()
  let group = 0
  // Deterministic order: by the first team member's index in each component.
  const order = [...byRoot.values()].sort((x, y) => {
    const ix = Math.min(...x.map((k) => team.findIndex((t) => t.key === k)))
    const iy = Math.min(...y.map((k) => team.findIndex((t) => t.key === k)))
    return ix - iy
  })
  for (const members of order) {
    if (members.length >= 2) {
      for (const k of members) result.set(k, group)
      group++
    }
  }
  return result
}

/** Label a premade group by its size. */
export function premadeLabel(size: number): string {
  switch (size) {
    case 2:
      return 'Duo'
    case 3:
      return 'Trio'
    case 4:
      return '4-stack'
    case 5:
      return '5-stack'
    default:
      return 'Premade'
  }
}
