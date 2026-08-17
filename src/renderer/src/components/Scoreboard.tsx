import { useStore } from '../store'
import { TeamPanel } from './TeamPanel'
import type { ScoutedPlayer, TeamId } from '@shared/types'

const ROLE_ORDER: Record<string, number> = {
  TOP: 0,
  JUNGLE: 1,
  MIDDLE: 2,
  BOTTOM: 3,
  UTILITY: 4,
  UNKNOWN: 5
}

function sortByRole(a: ScoutedPlayer, b: ScoutedPlayer): number {
  const ra = ROLE_ORDER[a.currentRole ?? 'UNKNOWN'] ?? 5
  const rb = ROLE_ORDER[b.currentRole ?? 'UNKNOWN'] ?? 5
  return ra - rb
}

export function Scoreboard(): JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const patch = snapshot?.patch

  const players = snapshot?.players ?? []
  const teamOf = (t: TeamId): ScoutedPlayer[] =>
    players.filter((p) => p.live.team === t).sort(sortByRole)

  const order = teamOf('ORDER')
  const chaos = teamOf('CHAOS')
  const unknown = teamOf('UNKNOWN')

  // Some modes (or early loading) may not carry team info; show them together.
  if (order.length === 0 && chaos.length === 0) {
    return (
      <div className="scoreboard single">
        <TeamPanel title="Players" side="neutral" players={unknown} patch={patch} />
      </div>
    )
  }

  return (
    <div className="scoreboard">
      <TeamPanel title="Blue Team" side="blue" players={order} patch={patch} />
      <TeamPanel title="Red Team" side="red" players={chaos} patch={patch} />
      {unknown.length > 0 && (
        <TeamPanel title="Unassigned" side="neutral" players={unknown} patch={patch} />
      )}
    </div>
  )
}
