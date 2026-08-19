// Thin wrapper around league-connect for LCU (League Client) access:
//  - discovers client credentials from the lockfile,
//  - subscribes to the gameflow websocket to drive our phase state machine,
//  - reads the champ-select session for our own team's picks + assigned roles.
//
// Everything is resilient to the client not running: we poll for a connection
// and auto-reconnect when the websocket drops.

import { EventEmitter } from 'events'
import {
  authenticate,
  connect,
  request,
  type Credentials,
  type LeagueWebSocket
} from 'league-connect'
import type { GamePhase, Role } from '@shared/types'
import { normalizeRole } from './riot/stats'

/** Raw LCU gameflow phase strings. */
type LcuPhase =
  | 'None'
  | 'Lobby'
  | 'Matchmaking'
  | 'CheckedIntoTournament'
  | 'ReadyCheck'
  | 'ChampSelect'
  | 'GameStart'
  | 'InProgress'
  | 'Reconnect'
  | 'WaitingForStats'
  | 'PreEndOfGame'
  | 'EndOfGame'
  | 'TerminatedInError'

export interface ChampSelectPlayer {
  summonerName?: string
  championId: number
  /** Assigned position from champ select, e.g. 'top','jungle','middle', etc. */
  assignedPosition: Role
  puuid?: string
}

export interface LcuEvents {
  connected: () => void
  disconnected: () => void
  phase: (phase: GamePhase, raw: string) => void
  champSelect: (players: ChampSelectPlayer[]) => void
}

function mapPhase(raw: LcuPhase | string): GamePhase {
  switch (raw) {
    case 'None':
      return 'Idle'
    case 'Lobby':
      return 'Lobby'
    case 'Matchmaking':
    case 'ReadyCheck':
    case 'CheckedIntoTournament':
      return 'Matchmaking'
    case 'ChampSelect':
      return 'ChampSelect'
    case 'GameStart':
    case 'InProgress':
      return 'InGame'
    case 'Reconnect':
      return 'Reconnect'
    case 'WaitingForStats':
    case 'PreEndOfGame':
    case 'EndOfGame':
      return 'PostGame'
    default:
      return 'Idle'
  }
}

export declare interface Lcu {
  on<K extends keyof LcuEvents>(event: K, listener: LcuEvents[K]): this
  emit<K extends keyof LcuEvents>(event: K, ...args: Parameters<LcuEvents[K]>): boolean
}

export class Lcu extends EventEmitter {
  private credentials: Credentials | null = null
  private ws: LeagueWebSocket | null = null
  private connectTimer: NodeJS.Timeout | null = null
  private stopped = false
  private currentPhase: GamePhase = 'Idle'

  get isConnected(): boolean {
    return this.credentials != null && this.ws != null
  }

  /** Begin trying to connect; retries until the client appears. */
  start(): void {
    this.stopped = false
    void this.tryConnect()
  }

  stop(): void {
    this.stopped = true
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    this.teardownWs()
    this.credentials = null
  }

  private scheduleReconnect(delayMs = 3000): void {
    if (this.stopped || this.connectTimer) return
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      void this.tryConnect()
    }, delayMs)
    if (typeof this.connectTimer.unref === 'function') this.connectTimer.unref()
  }

  private teardownWs(): void {
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
  }

  private async tryConnect(): Promise<void> {
    if (this.stopped) return
    try {
      this.credentials = await authenticate({ awaitConnection: false })
    } catch {
      // Client not running yet — retry quietly.
      this.credentials = null
      this.scheduleReconnect()
      return
    }

    try {
      this.ws = await connect(this.credentials)
    } catch {
      this.teardownWs()
      this.credentials = null
      this.scheduleReconnect()
      return
    }

    // A listener that throws here would escape before the websocket
    // subscriptions and the reconnect wiring below were ever installed,
    // leaving the LCU permanently disconnected with no retry scheduled.
    try {
      this.emit('connected')

      // Subscribe to gameflow phase changes.
      this.ws.subscribe('/lol-gameflow/v1/session', (data: unknown) => {
        const phaseRaw = (data as { phase?: string } | undefined)?.phase
        if (phaseRaw) this.handlePhase(phaseRaw)
      })

      // Subscribe to champ-select updates (our own team only).
      this.ws.subscribe('/lol-champ-select/v1/session', (data: unknown) => {
        try {
          const players = parseChampSelect(data)
          if (players.length) this.emit('champSelect', players)
        } catch (e) {
          console.error('[lcu] champSelect listener threw:', e)
        }
      })

      this.ws.on('close', () => {
        this.teardownWs()
        this.credentials = null
        this.emit('disconnected')
        this.scheduleReconnect()
      })
      this.ws.on('error', () => {
        // 'close' will follow; nothing to do here.
      })

      // Prime current phase immediately (websocket only pushes on change).
      await this.refreshPhase()
    } catch (e) {
      console.error('[lcu] connect handling failed:', e)
      this.teardownWs()
      this.credentials = null
      this.scheduleReconnect()
    }
  }

  private handlePhase(raw: string): void {
    const mapped = mapPhase(raw)
    if (mapped === this.currentPhase) return
    this.currentPhase = mapped
    // Emitted from a websocket callback: a throwing listener must not unwind
    // into league-connect and tear the socket down.
    try {
      this.emit('phase', mapped, raw)
    } catch (e) {
      console.error('[lcu] phase listener threw:', e)
    }
  }

  /** One-shot HTTP read of the current gameflow phase. */
  async refreshPhase(): Promise<void> {
    if (!this.credentials) return
    try {
      const res = await request(
        { method: 'GET', url: '/lol-gameflow/v1/session' },
        this.credentials
      )
      const body = (await res.json()) as { phase?: string }
      if (body?.phase) this.handlePhase(body.phase)
    } catch {
      // Not in a session — leave phase as-is.
    }
  }

  /** One-shot HTTP read of the champ-select session. */
  async getChampSelect(): Promise<ChampSelectPlayer[]> {
    if (!this.credentials) return []
    try {
      const res = await request(
        { method: 'GET', url: '/lol-champ-select/v1/session' },
        this.credentials
      )
      return parseChampSelect(await res.json())
    } catch {
      return []
    }
  }
}

function parseChampSelect(data: unknown): ChampSelectPlayer[] {
  const session = data as
    | {
        myTeam?: Array<{
          summonerName?: string
          gameName?: string
          championId?: number
          assignedPosition?: string
          puuid?: string
        }>
      }
    | undefined
  if (!session?.myTeam) return []
  return session.myTeam.map((m) => ({
    summonerName: m.gameName || m.summonerName,
    championId: m.championId ?? 0,
    assignedPosition: normalizeRole(m.assignedPosition),
    puuid: m.puuid
  }))
}
