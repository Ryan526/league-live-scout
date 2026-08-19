// Poller for the in-game Live Client Data API:
//   https://127.0.0.1:2999/liveclientdata/allgamedata
// No auth; available from the loading screen to the end of the game. This is
// where we obtain the enemy team (LCU champ-select only reveals our own side).
//
// The endpoint serves a self-signed Riot certificate. Riot publishes the cert,
// but bundling it is brittle across patches, so we scope an unverified TLS agent
// strictly to 127.0.0.1:2999 (localhost only) as the plan allows.

import { EventEmitter } from 'events'
import { Agent } from 'https'
import { get } from 'https'
import type { LivePlayer, LiveScores, TeamId } from '@shared/types'
import { normalizeRole } from './riot/stats'

const HOST = '127.0.0.1'
const PORT = 2999
const REQUEST_TIMEOUT_MS = 4000
const MIN_POLL_MS = 1000

// Unverified agent, localhost-only. Never used for any other host.
const localhostAgent = new Agent({ rejectUnauthorized: false, keepAlive: true })

export interface LiveClientEvents {
  players: (players: LivePlayer[], gameMode: string) => void
  connected: () => void
  disconnected: () => void
}

export declare interface LiveClient {
  on<K extends keyof LiveClientEvents>(event: K, listener: LiveClientEvents[K]): this
  emit<K extends keyof LiveClientEvents>(
    event: K,
    ...args: Parameters<LiveClientEvents[K]>
  ): boolean
}

interface AllGameData {
  gameData?: { gameMode?: string; gameTime?: number }
  allPlayers?: Array<{
    riotId?: string
    riotIdGameName?: string
    riotIdTagLine?: string
    summonerName?: string
    championName?: string
    rawChampionName?: string
    team?: string
    /** TOP | JUNGLE | MIDDLE | BOTTOM | UTILITY, empty outside laned queues. */
    position?: string
    isBot?: boolean
    summonerSpells?: {
      summonerSpellOne?: { displayName?: string }
      summonerSpellTwo?: { displayName?: string }
    }
    scores?: {
      kills?: number
      deaths?: number
      assists?: number
      creepScore?: number
      wardScore?: number
    }
  }>
}

export class LiveClient extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private active = false
  private wasConnected = false
  private pollMs: number

  constructor(pollMs = 5000) {
    super()
    this.pollMs = Math.max(MIN_POLL_MS, pollMs)
  }

  get isConnected(): boolean {
    return this.wasConnected
  }

  setPollInterval(ms: number): void {
    this.pollMs = Math.max(MIN_POLL_MS, ms)
  }

  start(): void {
    if (this.active) return
    this.active = true
    void this.tick()
  }

  stop(): void {
    this.active = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.wasConnected) {
      this.wasConnected = false
      this.emit('disconnected')
    }
  }

  /** Single fetch of all game data; returns null when no game is running. */
  async fetchOnce(): Promise<AllGameData | null> {
    return new Promise<AllGameData | null>((resolve) => {
      const req = get(
        {
          host: HOST,
          port: PORT,
          path: '/liveclientdata/allgamedata',
          agent: localhostAgent,
          timeout: REQUEST_TIMEOUT_MS
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume()
            resolve(null)
            return
          }
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (body += c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(body) as AllGameData)
            } catch {
              resolve(null)
            }
          })
        }
      )
      req.on('error', () => resolve(null))
      req.on('timeout', () => {
        req.destroy()
        resolve(null)
      })
    })
  }

  private async tick(): Promise<void> {
    if (!this.active) return
    try {
      const data = await this.fetchOnce()
      // stop() may have landed while the fetch was in flight; emitting now
      // would resurrect `wasConnected` and, with a start() in between, leave
      // two polling chains running at twice the rate.
      if (!this.active) return
      if (data && data.allPlayers) {
        if (!this.wasConnected) {
          this.wasConnected = true
          this.emit('connected')
        }
        const players = parsePlayers(data)
        this.emit('players', players, data.gameData?.gameMode ?? 'CLASSIC')
      } else if (this.wasConnected) {
        this.wasConnected = false
        this.emit('disconnected')
      }
    } catch (e) {
      // A listener that throws must not take the poller down with it: without
      // this the timer below never re-arms and the app silently stops seeing
      // the game for the rest of the session.
      console.error('[liveClient] tick failed:', e)
    } finally {
      if (this.active) {
        this.timer = setTimeout(() => void this.tick(), this.pollMs)
        if (typeof this.timer.unref === 'function') this.timer.unref()
      }
    }
  }
}

function toTeam(team: string | undefined): TeamId {
  if (team === 'ORDER') return 'ORDER'
  if (team === 'CHAOS') return 'CHAOS'
  return 'UNKNOWN'
}

function splitRiotId(p: NonNullable<AllGameData['allPlayers']>[number]): {
  riotId: string
  gameName: string
  tagLine: string
} {
  // Prefer the split fields when present; fall back to parsing "name#tag".
  if (p.riotIdGameName) {
    return {
      riotId: p.riotId || `${p.riotIdGameName}#${p.riotIdTagLine ?? ''}`,
      gameName: p.riotIdGameName,
      tagLine: p.riotIdTagLine ?? ''
    }
  }
  const raw = p.riotId || p.summonerName || ''
  const hash = raw.lastIndexOf('#')
  if (hash > 0) {
    return { riotId: raw, gameName: raw.slice(0, hash), tagLine: raw.slice(hash + 1) }
  }
  return { riotId: raw, gameName: raw, tagLine: '' }
}

export function parsePlayers(data: AllGameData): LivePlayer[] {
  const out: LivePlayer[] = []
  for (const p of data.allPlayers ?? []) {
    const { riotId, gameName, tagLine } = splitRiotId(p)
    const spells: string[] = []
    const s1 = p.summonerSpells?.summonerSpellOne?.displayName
    const s2 = p.summonerSpells?.summonerSpellTwo?.displayName
    if (s1) spells.push(s1)
    if (s2) spells.push(s2)
    const scores: LiveScores | undefined = p.scores
      ? {
          kills: p.scores.kills ?? 0,
          deaths: p.scores.deaths ?? 0,
          assists: p.scores.assists ?? 0,
          creepScore: p.scores.creepScore ?? 0,
          wardScore: p.scores.wardScore ?? 0
        }
      : undefined
    out.push({
      riotId,
      gameName,
      tagLine,
      championName: p.championName || p.rawChampionName || '',
      team: toTeam(p.team),
      // The Live Client knows the assigned lane for BOTH teams. It costs no
      // Riot API quota and beats any inference we could do.
      position: normalizeRole(p.position),
      summonerSpells: spells,
      isBot: Boolean(p.isBot),
      scores
    })
  }
  return out
}

/**
 * Merge a freshly-polled player over the one we are already tracking.
 *
 * A naive `{ ...existing, ...next }` loses data: the Live Client intermittently
 * omits `scores` (making the live K/D/A flicker) and reports an empty
 * `position` on some payloads, and `parsePlayers` always emits every key. This
 * treats "absent" and "UNKNOWN" as "no news" and keeps the better value.
 */
export function mergeLivePlayer(existing: LivePlayer, next: LivePlayer): LivePlayer {
  const merged: LivePlayer = { ...existing }

  if (next.riotId) merged.riotId = next.riotId
  if (next.gameName) merged.gameName = next.gameName
  if (next.tagLine) merged.tagLine = next.tagLine
  if (next.championName) merged.championName = next.championName
  if (next.championId != null) merged.championId = next.championId
  if (next.championKey) merged.championKey = next.championKey
  if (next.team !== 'UNKNOWN') merged.team = next.team
  if (next.position && next.position !== 'UNKNOWN') merged.position = next.position
  if (next.summonerSpells.length > 0) merged.summonerSpells = next.summonerSpells
  if (next.scores) merged.scores = next.scores
  merged.isBot = next.isBot

  return merged
}
