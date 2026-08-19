import { useStore } from '../store'
import { TeamPanel } from './TeamPanel'
import type { ScoutedPlayer, TeamId } from '@shared/types'
import { roleRank } from '@shared/types'

/**
 * Top -> Jungle -> Mid -> Bot -> Support, with a stable tiebreak. Without the
 * secondary key, equal roles fell back to Map insertion order and the list
 * visibly jumped around as stats streamed in.
 */
function sortByRole(a: ScoutedPlayer, b: ScoutedPlayer): number {
  const byRole = roleRank(a.currentRole) - roleRank(b.currentRole)
  if (byRole !== 0) return byRole
  return identity(a).localeCompare(identity(b))
}

function identity(p: ScoutedPlayer): string {
  return p.live.riotId || p.live.gameName || p.live.championName || ''
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
