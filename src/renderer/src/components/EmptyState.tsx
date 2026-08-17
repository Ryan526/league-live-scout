import { useStore } from '../store'

export function EmptyState({ needsKey }: { needsKey: boolean }): JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const logs = useStore((s) => s.logs)

  const phase = snapshot?.phase ?? 'Idle'

  return (
    <div className="empty-state">
      <div className="empty-hero">
        <div className="empty-glyph">◈</div>
        {needsKey ? (
          <>
            <h1>Add your Riot API key to start scouting</h1>
            <p>
              Get a free personal key at{' '}
              <a href="https://developer.riotgames.com" target="_blank" rel="noreferrer">
                developer.riotgames.com
              </a>{' '}
              and paste it into Settings. The key is stored encrypted on this machine.
            </p>
            <button className="btn primary" onClick={() => setSettingsOpen(true)}>
              Open Settings
            </button>
          </>
        ) : (
          <>
            <h1>Waiting for a game</h1>
            <p>
              Keep this window open on a second monitor. When you enter champ select or a match,
              the 9 other players load automatically.
            </p>
            <p className="muted">
              Current phase: <strong>{phase}</strong>
              {snapshot?.lcuConnected ? ' · client connected' : ' · waiting for League client'}
            </p>
          </>
        )}
      </div>

      {logs.length > 0 && (
        <div className="log-strip">
          {logs.slice(0, 6).map((l, i) => (
            <div key={i} className="log-line">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
