import { useStore } from '../store'

export function StatusBar(): JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const rate = useStore((s) => s.rate)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const phase = snapshot?.phase ?? 'Idle'
  const lcu = snapshot?.lcuConnected
  const live = snapshot?.liveConnected
  const backingOff = rate?.retryAfterUntil && rate.retryAfterUntil > Date.now()

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
          <span className={`pill muted rate ${backingOff ? 'warn' : ''}`} title="Riot API request queue">
            Q {rate.queued} · {rate.inFlight} live{backingOff ? ' · backoff' : ''}
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
