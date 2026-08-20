import { useEffect, useState } from 'react'
import { useStore } from '../store'

/** "12s" / "1m 40s" — a countdown, so keep it short enough to sit in a pill. */
function formatEta(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
}

export function StatusBar(): JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const rate = useStore((s) => s.rate)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const phase = snapshot?.phase ?? 'Idle'
  const lcu = snapshot?.lcuConnected
  const live = snapshot?.liveConnected
  const backingOff = rate?.retryAfterUntil && rate.retryAfterUntil > Date.now()

  // The main process only pushes when the queue moves, which can be as slow as
  // once a second — and while backing off, not at all. Tick locally so the
  // countdown stays honest between pushes instead of freezing on a stale value.
  const [now, setNow] = useState(() => Date.now())
  const pending = (rate?.queued ?? 0) > 0 || (rate?.inFlight ?? 0) > 0
  useEffect(() => {
    if (!pending) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [pending])

  // Both clocks are anchored to the moment the snapshot arrived, so they decay
  // together rather than one jumping while the other slides.
  const receivedAt = rate?.receivedAt ?? now
  const elapsed = Math.max(0, now - receivedAt)
  const etaMs = rate?.etaMs != null ? rate.etaMs - elapsed : null
  const backoffMs = rate?.retryAfterUntil ? rate.retryAfterUntil - now : null

  return (
    <header className="statusbar">
      <div className="brand">
        <span className="brand-mark">◈</span>
        <span className="brand-name">League Live Scout</span>
      </div>

      <div className="status-pills">
        <Pill on={!!lcu} label="Client" />
        <Pill on={!!live} label="In-Game" />
        <span className={`pill phase phase-${phase.toLowerCase()}`}>{phase}</span>
        {snapshot?.gameMode && <span className="pill muted">{snapshot.gameMode}</span>}
        {snapshot?.patch && <span className="pill muted">v{snapshot.patch}</span>}
        {rate && (
          <span
            className={`pill muted rate ${backingOff ? 'warn' : ''}`}
            title={
              backingOff
                ? 'Rate limited by Riot — waiting out the backoff before resuming'
                : 'Riot API request queue · estimated time until every player is filled in'
            }
          >
            Q {rate.queued} · {rate.inFlight} live
            {backingOff && backoffMs != null && backoffMs > 0
              ? ` · backoff ${formatEta(backoffMs)}`
              : etaMs != null && etaMs > 0
                ? ` · ~${formatEta(etaMs)}`
                : ''}
          </span>
        )}
      </div>

      <div className="actions">
        <button
          className="btn"
          onClick={() => void window.scout.rescout()}
          disabled={!snapshot?.players.length}
          title="Re-fetch stats for the current players"
        >
          Re-scout
        </button>
        <button
          className={`btn ${settingsOpen ? 'active' : ''}`}
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          Settings
        </button>
      </div>
    </header>
  )
}

function Pill({ on, label }: { on: boolean; label: string }): JSX.Element {
  return (
    <span className={`pill dot ${on ? 'ok' : 'off'}`}>
      <span className="dot-mark" />
      {label}
    </span>
  )
}
