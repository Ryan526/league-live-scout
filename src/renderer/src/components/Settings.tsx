import { useState } from 'react'
import { useStore } from '../store'
import {
  LIVE_POLL_MAX_MS,
  LIVE_POLL_MIN_MS,
  REGIONS,
  type RegionOption
} from '@shared/types'

/** Poll intervals offered in the UI, in milliseconds. */
const POLL_CHOICES = [2000, 5000, 10_000].filter(
  (ms) => ms >= LIVE_POLL_MIN_MS && ms <= LIVE_POLL_MAX_MS
)

export function Settings(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const logs = useStore((s) => s.logs)

  const [keyInput, setKeyInput] = useState('')
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const region = settings?.region

  function fail(e: unknown): void {
    setTestMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
  }

  async function saveKey(): Promise<void> {
    if (!keyInput.trim()) return
    setBusy(true)
    try {
      const next = await window.scout.setApiKey(keyInput.trim())
      setSettings(next)
      setKeyInput('')
      setTestMsg({ ok: true, text: 'Key saved.' })
    } catch (e) {
      // Without this the user is told nothing and assumes the key was stored.
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function clearKey(): Promise<void> {
    try {
      setSettings(await window.scout.clearApiKey())
      setTestMsg(null)
    } catch (e) {
      fail(e)
    }
  }

  async function test(): Promise<void> {
    setBusy(true)
    try {
      const result = await window.scout.testApiKey()
      setTestMsg({ ok: result.ok, text: result.message })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function changeRegion(platform: string): Promise<void> {
    const option = REGIONS.find((r) => r.platform === platform)
    if (!option) return
    try {
      setSettings(
        await window.scout.setRegion({
          platform: option.platform,
          regional: option.regional,
          account: option.account
        })
      )
    } catch (e) {
      fail(e)
    }
  }

  async function changePollMs(ms: number): Promise<void> {
    try {
      setSettings(await window.scout.setLivePollMs(ms))
    } catch (e) {
      fail(e)
    }
  }

  async function clearPeaks(): Promise<void> {
    try {
      await window.scout.clearPeakRanks()
      setTestMsg({ ok: true, text: 'Peak rank history cleared.' })
    } catch (e) {
      fail(e)
    }
  }

  // An unrecognized stored platform used to silently display "NA" while
  // operating on something else; show it explicitly instead.
  const known: RegionOption | undefined = REGIONS.find((r) => r.platform === region?.platform)

  return (
    <div className="settings">
      <div className="settings-head">
        <h1>Settings</h1>
        <button className="btn" onClick={() => setSettingsOpen(false)}>
          Done
        </button>
      </div>

      <section className="settings-section">
        <h2>Riot API key</h2>
        <p className="muted">
          Personal keys from{' '}
          <a href="https://developer.riotgames.com" target="_blank" rel="noreferrer">
            developer.riotgames.com
          </a>{' '}
          expire every 24 hours — paste a fresh one when scouting stops working. Stored encrypted
          via your OS keychain.
        </p>
        <div className="key-row">
          <input
            type="password"
            placeholder={settings?.hasApiKey ? '•••••••• (a key is saved)' : 'RGAPI-…'}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <button className="btn primary" onClick={() => void saveKey()} disabled={busy || !keyInput.trim()}>
            Save
          </button>
        </div>
        <div className="key-actions">
          <span className={`key-status ${settings?.hasApiKey ? 'ok' : 'off'}`}>
            {settings?.hasApiKey ? 'Key saved' : 'No key saved'}
          </span>
          <button className="btn small" onClick={() => void test()} disabled={busy || !settings?.hasApiKey}>
            Test key
          </button>
          <button className="btn small danger" onClick={() => void clearKey()} disabled={!settings?.hasApiKey}>
            Remove
          </button>
        </div>
        {testMsg && (
          <div className={`test-msg ${testMsg.ok ? 'ok' : 'err'}`}>{testMsg.text}</div>
        )}
      </section>

      <section className="settings-section">
        <h2>Region</h2>
        <select
          value={known?.platform ?? ''}
          onChange={(e) => void changeRegion(e.target.value)}
        >
          {!known && (
            <option value="">
              {region ? `Unrecognized (${region.platform}) — pick a region` : 'Pick a region'}
            </option>
          )}
          {REGIONS.map((r) => (
            <option key={r.platform} value={r.platform}>
              {r.label}
            </option>
          ))}
        </select>
      </section>

      <section className="settings-section">
        <h2>In-game refresh</h2>
        <p className="muted">
          How often the live scoreboard (K/D/A, CS) is re-read from the game client. This is a
          local call and costs no Riot API quota.
        </p>
        <select
          value={settings?.livePollMs ?? 5000}
          onChange={(e) => void changePollMs(Number(e.target.value))}
        >
          {POLL_CHOICES.map((ms) => (
            <option key={ms} value={ms}>
              Every {ms / 1000}s
            </option>
          ))}
        </select>
      </section>

      <section className="settings-section">
        <h2>Peak rank history</h2>
        <p className="muted">
          Peak ranks are observed by this app over time and stored locally. Clearing forgets every
          player seen so far.
        </p>
        <button className="btn small danger" onClick={() => void clearPeaks()}>
          Clear peak ranks
        </button>
      </section>

      <section className="settings-section">
        <h2>Activity log</h2>
        <div className="log-box">
          {logs.length === 0 && <div className="muted">No activity yet.</div>}
          {logs.map((l, i) => (
            <div key={i} className="log-line">
              {l}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
