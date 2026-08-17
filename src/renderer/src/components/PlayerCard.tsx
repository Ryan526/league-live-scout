import type { ScoutedPlayer } from '@shared/types'
import { roleLabel, rankScore } from '@shared/types'
import {
  championIcon,
  kdaClass,
  num,
  pct,
  rankLabel,
  rankWinRate,
  tierClass,
  wrClass
} from '../format'

interface Props {
  player: ScoutedPlayer
  patch?: string
  /** Accent color when this player is part of a premade group. */
  groupColor?: string
}

export function PlayerCard({ player, patch, groupColor }: Props): JSX.Element {
  const { live, stats, soloRank, peakSoloRank, mastery, loading } = player
  const icon = championIcon(patch, live.championName)
  const solo = soloRank ?? null
  const soloWr = rankWinRate(solo)
  const peak = peakSoloRank ?? null
  // Only call out peak when it's meaningfully above the current rank.
  const belowPeak = peak != null && rankScore(peak) > rankScore(solo)

  const cardStyle = groupColor
    ? { borderLeft: `3px solid ${groupColor}` }
    : undefined

  return (
    <div className={`player-card ${live.isBot ? 'bot' : ''}`} style={cardStyle}>
      <div className="pc-top">
        <div className="pc-champ">
          {icon ? (
            <img src={icon} alt={live.championName} width={44} height={44} />
          ) : (
            <div className="champ-fallback">{initials(live.championName)}</div>
          )}
          {mastery && mastery.championLevel > 0 && (
            <span className="mastery-badge" title={`${mastery.championPoints.toLocaleString()} mastery pts`}>
              M{mastery.championLevel}
            </span>
          )}
        </div>

        <div className="pc-id">
          <div className="pc-name" title={live.riotId}>
            {live.gameName || 'Unknown'}
            {live.isBot && <span className="tag bot-tag">BOT</span>}
          </div>
          <div className="pc-sub">
            <span className="champ-name">{live.championName || '—'}</span>
            {player.currentRole && player.currentRole !== 'UNKNOWN' && (
              <span className="role-chip" title={roleTitle(player)}>
                {roleLabel(player.currentRole)}
                {player.offRole && <span className="offrole" title="Off their main role">off-role</span>}
              </span>
            )}
          </div>
        </div>

        <div className="pc-rank">
          <span className={`rank-chip ${tierClass(solo)}`} title="Ranked Solo/Duo">
            {rankLabel(solo)}
          </span>
          {soloWr != null && solo && (
            <span className={`rank-wr ${wrClass(soloWr)}`}>
              {pct(soloWr)} <span className="muted">({solo.wins}W {solo.losses}L)</span>
            </span>
          )}
          {peak != null && (
            <span
              className={`peak-rank ${belowPeak ? 'below' : ''} ${tierClass(peak)}`}
              title="Peak Solo/Duo rank observed by this app over time (the Riot API has no all-time peak)"
            >
              ▲ Peak {rankLabel(peak)}
            </span>
          )}
        </div>
      </div>

      <div className="pc-stats">
        <Stat
          label={`Ranked WR · ${live.championName || 'champ'}`}
          value={
            stats?.championWinRate != null
              ? `${pct(stats.championWinRate)} (${stats.championGames}g)`
              : loading.matches === 'loading'
                ? '…'
                : stats
                  ? 'no games'
                  : '—'
          }
          cls={wrClass(stats?.championWinRate)}
        />
        <Stat
          label="Ranked KDA"
          value={stats?.avgKda != null ? `${num(stats.avgKda, 2)}` : loading.matches === 'loading' ? '…' : '—'}
          sub={
            stats && stats.sampleSize > 0
              ? `${num(stats.avgKills)}/${num(stats.avgDeaths)}/${num(stats.avgAssists)}`
              : undefined
          }
          cls={kdaClass(stats?.avgKda)}
        />
        <Stat
          label="Main role"
          value={stats?.mainRole && stats.mainRole !== 'UNKNOWN' ? roleLabel(stats.mainRole) : '—'}
        />
        <Stat
          label="Premade"
          value={player.premadeLabel ?? '—'}
          cls={player.premadeGroup != null ? 'premade' : ''}
        />
      </div>

      <div className="pc-footer">
        {stats && stats.recentForm.length > 0 && (
          <div className="form" title="Recent games (most recent first)">
            {stats.recentForm.map((r, i) => (
              <span key={i} className={`form-dot ${r === 'W' ? 'win' : 'loss'}`}>
                {r}
              </span>
            ))}
          </div>
        )}
        {live.scores && (
          <div className="live-score" title="Live scoreboard">
            {live.scores.kills}/{live.scores.deaths}/{live.scores.assists} · {live.scores.creepScore} CS
          </div>
        )}
        {player.error && loading.identity === 'error' && (
          <div className="pc-error" title={player.error}>
            {player.error}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  cls
}: {
  label: string
  value: string
  sub?: string
  cls?: string
}): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${cls ?? ''}`}>
        {value}
        {sub && <span className="stat-sub"> {sub}</span>}
      </div>
    </div>
  )
}

function roleTitle(p: ScoutedPlayer): string {
  const cur = p.currentRole && p.currentRole !== 'UNKNOWN' ? roleLabel(p.currentRole) : 'unknown'
  const main =
    p.stats?.mainRole && p.stats.mainRole !== 'UNKNOWN' ? roleLabel(p.stats.mainRole) : 'unknown'
  return `Current role: ${cur} (inferred for enemies) · Main: ${main}`
}

function initials(name: string): string {
  return (name || '?').slice(0, 2).toUpperCase()
}
