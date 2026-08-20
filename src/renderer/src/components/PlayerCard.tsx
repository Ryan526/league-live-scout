import { useEffect, useState } from 'react'
import type { ScoutedPlayer } from '@shared/types'
import { roleLabel, rankScore } from '@shared/types'
import {
  championIcon,
  csPerMin,
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

/** Below this many games, a champion win rate is noise, not a signal. */
const SMALL_SAMPLE = 5

export function PlayerCard({ player, patch, groupColor }: Props): JSX.Element {
  const { live, stats, soloRank, peakSoloRank, mastery, loading } = player
  // Data Dragon names its files by internal key ("MasterYi"), not by the
  // display name the Live Client reports ("Master Yi").
  const icon = championIcon(patch, live.championKey)
  const [iconFailed, setIconFailed] = useState(false)
  useEffect(() => setIconFailed(false), [icon])

  const solo = soloRank ?? null
  const soloWr = rankWinRate(solo)
  const peak = peakSoloRank ?? null
  // Only call out peak when it's meaningfully above the current rank.
  const belowPeak = peak != null && rankScore(peak) > rankScore(solo)
  const inferredRole = player.roleSource === 'inferred'
  const smallSample =
    stats?.championWinRate != null && stats.championGames < SMALL_SAMPLE

  const cardStyle = groupColor
    ? { borderLeft: `3px solid ${groupColor}` }
    : undefined

  return (
    <div className={`player-card ${live.isBot ? 'bot' : ''}`} style={cardStyle}>
      <div className="pc-top">
        <div className="pc-champ">
          {icon && !iconFailed ? (
            <img
              src={icon}
              alt={live.championName}
              width={44}
              height={44}
              // A brand-new champion (or a Data Dragon lag) should degrade to
              // initials, not a broken-image glyph.
              onError={() => setIconFailed(true)}
            />
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
            {live.isSelf && (
              <span className="tag self-tag" title="This is you">
                YOU
              </span>
            )}
          </div>
          <div className="pc-sub">
            <span className="champ-name">{live.championName || '—'}</span>
            {player.currentRole && player.currentRole !== 'UNKNOWN' && (
              <span
                className={`role-chip ${inferredRole ? 'inferred' : ''}`}
                title={roleTitle(player)}
              >
                {roleLabel(player.currentRole)}
                {inferredRole && <span className="role-guess">?</span>}
                {player.offRole && <span className="offrole" title="Off their main role">off-role</span>}
              </span>
            )}
          </div>
        </div>

        <div className="pc-rank">
          <span className={`rank-chip ${tierClass(solo)}`} title={rankTitle(player)}>
            {player.noRankData && !solo ? 'No ranked data' : rankLabel(solo)}
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
          sub={smallSample ? 'small sample' : undefined}
          cls={smallSample ? '' : wrClass(stats?.championWinRate)}
        />
        <Stat
          label="Ranked KDA"
          value={stats?.kdaRatio != null ? `${num(stats.kdaRatio, 2)}` : loading.matches === 'loading' ? '…' : '—'}
          sub={
            stats && stats.sampleSize > 0
              ? `${num(stats.avgKills)}/${num(stats.avgDeaths)}/${num(stats.avgAssists)}`
              : undefined
          }
          cls={kdaClass(stats?.kdaRatio)}
        />
        <Stat
          label="Main role"
          value={stats?.mainRole && stats.mainRole !== 'UNKNOWN' ? roleLabel(stats.mainRole) : '—'}
          sub={stats && stats.sampleSize > 0 ? `${csPerMin(stats.avgCsPerMin)} cs/m` : undefined}
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
            {live.scores.kills}/{live.scores.deaths}/{live.scores.assists} ·{' '}
            {live.scores.creepScore} CS · {Math.round(live.scores.wardScore)} vision
          </div>
        )}
        {player.error && (
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
  const source =
    p.roleSource === 'live'
      ? 'reported by the game'
      : p.roleSource === 'champselect'
        ? 'from champ select'
        : 'inferred from spells, champion and ranked history'
  return `Current role: ${cur} (${source}) · Main: ${main}`
}

function rankTitle(p: ScoutedPlayer): string {
  if (p.noRankData && !p.soloRank) {
    return 'Riot returned no ranked entries: either genuinely unranked, or this player is not on the configured region.'
  }
  return 'Ranked Solo/Duo'
}

function initials(name: string): string {
  return (name || '?').slice(0, 2).toUpperCase()
}
