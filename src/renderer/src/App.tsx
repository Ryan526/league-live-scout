import { useEffect } from 'react'
import { useStore } from './store'
import { useAutoFit } from './useAutoFit'
import { StatusBar } from './components/StatusBar'
import { Scoreboard } from './components/Scoreboard'
import { Settings } from './components/Settings'
import { EmptyState } from './components/EmptyState'

export default function App(): JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const settings = useStore((s) => s.settings)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const setSnapshot = useStore((s) => s.setSnapshot)
  const setSettings = useStore((s) => s.setSettings)
  const setRate = useStore((s) => s.setRate)
  const pushLog = useStore((s) => s.pushLog)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  useEffect(() => {
    // Prime from current main-process state.
    void window.scout.getSnapshot().then(setSnapshot)
    void window.scout.getSettings().then((s) => {
      setSettings(s)
      if (!s.hasApiKey) setSettingsOpen(true)
    })

    const offSnap = window.scout.onSnapshot(setSnapshot)
    const offRate = window.scout.onRateStatus(setRate)
    const offLog = window.scout.onLog(pushLog)
    return () => {
      offSnap()
      offRate()
      offLog()
    }
  }, [setSnapshot, setSettings, setRate, pushLog, setSettingsOpen])

  const hasPlayers = (snapshot?.players.length ?? 0) > 0
  const keyRejected = Boolean(snapshot?.apiKeyRejected)

  // Grow/shrink the window to fit whatever is currently on screen. The key is a
  // stable primitive so the effect doesn't rebuild on every snapshot push.
  useAutoFit(
    `${settingsOpen}|${keyRejected}|${snapshot?.players.length ?? 0}|${snapshot?.phase ?? ''}`
  )

  return (
    <div className="app">
      <StatusBar />
      {keyRejected && !settingsOpen && (
        <div className="key-banner">
          <span>
            Riot rejected your API key (401/403). Development keys expire every 24 hours.
          </span>
          <button className="btn small" onClick={() => setSettingsOpen(true)}>
            Paste a fresh key
          </button>
        </div>
      )}
      <main className="content">
        {settingsOpen && <Settings />}
        {!settingsOpen && hasPlayers && <Scoreboard />}
        {!settingsOpen && !hasPlayers && (
          <EmptyState needsKey={settings ? !settings.hasApiKey : false} />
        )}
      </main>
    </div>
  )
}
