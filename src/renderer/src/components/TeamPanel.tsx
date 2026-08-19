import type { ScoutedPlayer } from '@shared/types'
import { PlayerCard } from './PlayerCard'

interface Props {
  title: string
  side: 'blue' | 'red' | 'neutral'
  players: ScoutedPlayer[]
  patch?: string
}

/**
 * Stable identity for React. The Live Client swaps between a bare game name
 * and a full Riot ID mid-load, so the PUUID (once known) and then the champion
 * are the only things that don't change under us.
 */
function playerKey(p: ScoutedPlayer): string {
  return p.puuid ?? `${p.live.team}:${p.live.championName || p.live.riotId}`
}

/** Distinct accent colors for premade groups within a team. */
const GROUP_COLORS = ['#f0b429', '#4fd1c5', '#f56565', '#b794f4']

export function TeamPanel({ title, side, players, patch }: Props): JSX.Element {
  // Which premade groups actually have 2+ members shown here.
  const groupSizes = new Map<number, number>()
  for (const p of players) {
    if (p.premadeGroup != null) {
      groupSizes.set(p.premadeGroup, (groupSizes.get(p.premadeGroup) ?? 0) + 1)
    }
  }

  return (
    <section className={`team-panel side-${side}`}>
      <div className="team-header">
        <h2>{title}</h2>
        <span className="team-count">{players.length}</span>
      </div>
      <div className="team-cards">
        {players.map((p) => {
          const groupColor =
            p.premadeGroup != null && (groupSizes.get(p.premadeGroup) ?? 0) >= 2
              ? GROUP_COLORS[p.premadeGroup % GROUP_COLORS.length]
              : undefined
          return (
            <PlayerCard
              key={playerKey(p)}
              player={p}
              patch={patch}
              groupColor={groupColor}
            />
          )
        })}
        {players.length === 0 && <div className="empty-note">Waiting for players…</div>}
      </div>
    </section>
  )
}
