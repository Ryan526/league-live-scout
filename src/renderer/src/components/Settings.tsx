import { useState } from 'react'
import { useStore } from '../store'

const REGIONS: Array<{ label: string; platform: string; regional: string }> = [
  { label: 'North America (NA)', platform: 'na1', regional: 'americas' },
  { label: 'EU West (EUW)', platform: 'euw1', regional: 'europe' },
  { label: 'EU Nordic & East (EUNE)', platform: 'eun1', regional: 'europe' },
  { label: 'Korea (KR)', platform: 'kr', regional: 'asia' },
  { label: 'Oceania (OCE)', platform: 'oc1', regional: 'americas' },
  { label: 'Brazil (BR)', platform: 'br1', regional: 'americas' }
]

export function Settings(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const logs = useStore((s) => s.logs)

  const [keyInput, setKeyInput] = useState('')
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const region = settings?.region

  async function saveKey(): Promise<void> {
    if (!keyInput.trim()) return
    setBusy(true)
    try {
      const next = await window.scout.setApiKey(keyInput.trim())
      setSettings(next)
      setKeyInput('')
      const result = await window.scout.testApiKey()
      setTestMsg({ ok: result.ok, text: result.message })
    } finally {
      setBusy(false)
    }
  }

  async function clearKey(): Promise<void> {
    const next = await window.scout.clearApiKey()
    setSettings(next)
    setTestMsg(null)
  }

  async function test(): Promise<void> {
    setBusy(true)
    try {
      const result = await window.scout.testApiKey()
      setTestMsg({ ok: result.ok, text: result.message })
    } finally {
      setBusy(false)
    }
  }

  async function changeRegion(platform: string, regional: string): Promise<void> {
    const next = await window.scout.setRegion({ platform, regional })
    setSettings(next)
  }

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
          value={region ? `${region.platform}|${region.regional}` : 'na1|americas'}
          onChange={(e) => {
            const [platform, regional] = e.target.value.split('|')
            void changeRegion(platform, regional)
          }}
        >
          {REGIONS.map((r) => (
            <option key={r.platform} value={`${r.platform}|${r.regional}`}>
              {r.label}
            </option>
          ))}
        </select>
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
