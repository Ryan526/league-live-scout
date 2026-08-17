// Orchestrates the whole scouting flow and owns the authoritative ScoutSnapshot
// pushed to the renderer.
//
// State machine: Idle -> ChampSelect (prewarm own team) -> InGame (load all 10)
// -> PostGame -> Idle. In champ select we can only see our own team (via LCU);
// the enemy team appears once the Live Client Data API comes online at the
// loading screen, at which point we fan out Riot API lookups for all 10.

import { EventEmitter } from 'events'
import type {
  GamePhase,
  LivePlayer,
  Role,
  ScoutSnapshot,
  ScoutedPlayer
} from '@shared/types'
import { RANKED_QUEUE_IDS } from '@shared/types'
import type { Settings } from './settings'
import { PeakRankStore } from './peakRank'
import { Lcu, type ChampSelectPlayer } from './lcu'
import { LiveClient } from './liveClient'
import { RateLimiter } from './riot/rateLimiter'
import { RiotClient, RiotApiError, toRankEntry } from './riot/client'
import { TtlCache } from './riot/cache'
import { DataDragon } from './riot/ddragon'
import { deriveStats, findParticipant } from './riot/stats'
import { inferEnemyRole, resolveTeamRoles } from './riot/roles'
import { detectPremades, premadeLabel, type PremadeInput } from './riot/premades'

export interface GameStateDeps {
  settings: Settings
  cacheFilePath: string
}

export interface GameStateEvents {
  snapshot: (snap: ScoutSnapshot) => void
  log: (line: string) => void
  rateStatus: (status: ReturnType<RateLimiter['status']>) => void
}

export declare interface GameState {
  on<K extends keyof GameStateEvents>(event: K, listener: GameStateEvents[K]): this
  emit<K extends keyof GameStateEvents>(
    event: K,
    ...args: Parameters<GameStateEvents[K]>
  ): boolean
}

/** Key a player by their Riot ID (stable across the identity lookup). */
function playerKey(p: LivePlayer): string {
  return p.riotId || `${p.gameName}#${p.tagLine}`
}

export class GameState extends EventEmitter {
  private readonly settings: Settings
  private readonly limiter: RateLimiter
  private readonly riot: RiotClient
  private readonly cache: TtlCache
  private readonly ddragon: DataDragon
  private readonly peakRanks: PeakRankStore
  private readonly lcu: Lcu
  private readonly live: LiveClient

  private phase: GamePhase = 'Idle'
  private gameMode?: string
  /** Current scouted players keyed by Riot ID. */
  private players = new Map<string, ScoutedPlayer>()
  /** Own-team roles observed from champ select, keyed by Riot ID (best-effort). */
  private ownRoles = new Map<string, Role>()
  /** Recent (matchId, historical teamId) pairs per player, for premade detection. */
  private matchHistory = new Map<string, Array<{ matchId: string; teamId: number }>>()
  private ownChampSelect: ChampSelectPlayer[] = []
  private emitTimer: NodeJS.Timeout | null = null
  private rateTimer: NodeJS.Timeout | null = null

  constructor(deps: GameStateDeps) {
    super()
    this.settings = deps.settings
    this.limiter = new RateLimiter()
    this.riot = new RiotClient({
      getApiKey: () => this.settings.getApiKey(),
      region: this.settings.getRegion(),
      limiter: this.limiter
    })
    this.cache = new TtlCache({ filePath: deps.cacheFilePath })
    this.ddragon = new DataDragon()
    this.peakRanks = new PeakRankStore()
    this.lcu = new Lcu()
    this.live = new LiveClient(this.settings.getLivePollMs())
    this.wire()
  }

  async init(): Promise<void> {
    await this.cache.load()
    try {
      await this.ddragon.ensureLoaded()
      this.log(`Data Dragon loaded (patch ${this.ddragon.currentPatch}).`)
    } catch (e) {
      this.log(`Data Dragon load failed: ${(e as Error).message}`)
    }
    this.lcu.start()
    // Poll the live client independent of the LCU: catches spectator/reconnect
    // and is cheap (localhost, no auth).
    this.live.start()
    this.startRateStatus()
  }

  shutdown(): void {
    this.lcu.stop()
    this.live.stop()
    if (this.rateTimer) clearInterval(this.rateTimer)
    void this.cache.flush()
  }

  onRegionChanged(): void {
    this.riot.setRegion(this.settings.getRegion())
  }

  getSnapshot(): ScoutSnapshot {
    return {
      phase: this.phase,
      lcuConnected: this.lcu.isConnected,
      liveConnected: this.live.isConnected,
      gameMode: this.gameMode,
      players: [...this.players.values()],
      patch: this.ddragon.currentPatch || undefined,
      updatedAt: Date.now()
    }
  }

  /** Force a re-scout of everyone currently tracked (bypasses cache). */
  async rescout(): Promise<void> {
    const current = [...this.players.values()].map((s) => s.live)
    this.players.clear()
    await this.ingestLivePlayers(current, true)
  }

  // ---- wiring ----

  private wire(): void {
    this.lcu.on('connected', () => {
      this.log('LCU connected.')
      this.scheduleEmit()
    })
    this.lcu.on('disconnected', () => {
      this.log('LCU disconnected.')
      this.scheduleEmit()
    })
    this.lcu.on('phase', (phase, raw) => this.onPhase(phase, raw))
    this.lcu.on('champSelect', (players) => this.onChampSelect(players))

    this.live.on('connected', () => {
      this.log('Live Client Data connected.')
      this.scheduleEmit()
    })
    this.live.on('disconnected', () => {
      this.scheduleEmit()
    })
    this.live.on('players', (players, mode) => {
      this.gameMode = mode
      void this.ingestLivePlayers(players, false)
    })
  }

  private onPhase(phase: GamePhase, raw: string): void {
    this.phase = phase
    this.log(`Phase -> ${phase} (${raw}).`)
    if (phase === 'ChampSelect') {
      void this.prewarmOwnTeam()
    } else if (phase === 'Idle' || phase === 'Lobby') {
      // Fresh lobby: clear the board for the next game.
      this.players.clear()
      this.ownRoles.clear()
      this.ownChampSelect = []
      this.gameMode = undefined
    }
    this.scheduleEmit()
  }

  private onChampSelect(players: ChampSelectPlayer[]): void {
    this.ownChampSelect = players
    void this.prewarmOwnTeam()
  }

  /** During champ select, warm identity+rank for our own team to spread load. */
  private async prewarmOwnTeam(): Promise<void> {
    const key = this.settings.getApiKey()
    if (!key) return
    const players =
      this.ownChampSelect.length > 0 ? this.ownChampSelect : await this.lcu.getChampSelect()
    this.ownChampSelect = players
    for (const p of players) {
      // Record the exact assigned role, keyed by both puuid and game name, so we
      // can reliably match this champ-select entry to a Live Client player later.
      // Champ select no longer exposes the tagLine, so we cannot key by full Riot
      // ID: puuid is the robust key; the bare game name is the early fallback used
      // before identities are resolved in-game.
      if (p.assignedPosition && p.assignedPosition !== 'UNKNOWN') {
        if (p.puuid) this.ownRoles.set(`puuid:${p.puuid}`, p.assignedPosition)
        if (p.summonerName) {
          this.ownRoles.set(`name:${p.summonerName.toLowerCase()}`, p.assignedPosition)
        }
      }
      // Identity prewarm needs a full Riot ID; skip when champ select only gave a
      // bare game name (the common case on current patches).
      if (!p.summonerName || !p.summonerName.includes('#')) continue
      const [gameName, tagLine] = splitName(p.summonerName)
      try {
        const account = await this.cachedAccount(gameName, tagLine)
        if (account) await this.cachedRank(account.puuid)
      } catch {
        // best-effort prewarm
      }
    }
  }

  // ---- ingest + enrich ----

  private async ingestLivePlayers(livePlayers: LivePlayer[], force: boolean): Promise<void> {
    await this.ddragon.ensureLoaded().catch(() => undefined)

    // Resolve champion ids and reconcile the tracked set.
    const seen = new Set<string>()
    for (const lp of livePlayers) {
      const rec = this.ddragon.resolve(lp.championName)
      if (rec) lp.championId = rec.id
      const key = playerKey(lp)
      seen.add(key)
      const existing = this.players.get(key)
      if (existing) {
        // Update live-updating fields (scoreboard) in place.
        existing.live = { ...existing.live, ...lp }
      } else {
        this.players.set(key, {
          live: lp,
          loading: { identity: 'idle', rank: 'idle', mastery: 'idle', matches: 'idle' }
        })
      }
    }
    // Drop players no longer present (shouldn't happen mid-game, but safe).
    for (const key of [...this.players.keys()]) {
      if (!seen.has(key)) this.players.delete(key)
    }

    // Infer enemy roles as a team so lanes don't collide.
    this.assignRoles()
    this.scheduleEmit()

    const key = this.settings.getApiKey()
    if (!key) {
      this.log('No Riot API key set — showing identities only. Add a key in Settings.')
      return
    }

    // Fan out enrichment. Progressive: identity -> rank+mastery -> matches.
    // Enrich each player only once per game: later Live Client polls (every few
    // seconds) just refresh the live scoreboard above and must NOT re-queue the
    // whole set of Riot API calls, or the request queue balloons. A player whose
    // identity is still 'idle' hasn't been started yet; `force` (Re-scout)
    // re-runs everyone. Players that errored are left for a manual Re-scout.
    const toEnrich = [...this.players.values()].filter(
      (s) => !s.live.isBot && (force || s.loading.identity === 'idle')
    )
    if (toEnrich.length === 0) return

    await Promise.all(toEnrich.map((s) => this.enrichPlayer(s, force)))

    // Identities are resolved now, so own-team champ-select roles can match by
    // puuid (the reliable key). Re-run assignment and refresh off-role flags
    // against the corrected roles.
    this.assignRoles()
    this.recomputeOffRoles()

    // Once match histories are in, detect premades per team.
    this.detectAndLabelPremades()
    this.scheduleEmit()
  }

  /** Group each team's players into premades from shared match history. */
  private detectAndLabelPremades(): void {
    for (const s of this.players.values()) {
      s.premadeGroup = undefined
      s.premadeLabel = undefined
    }
    for (const team of ['ORDER', 'CHAOS'] as const) {
      const teamPlayers = [...this.players.values()].filter((s) => s.live.team === team)
      const input: PremadeInput[] = teamPlayers
        .map((s) => ({
          key: playerKey(s.live),
          matches: this.matchHistory.get(playerKey(s.live)) ?? []
        }))
        .filter((p) => p.matches.length > 0)
      if (input.length < 2) continue

      const groups = detectPremades(input)
      // Count members per group to derive the label (Duo/Trio/…).
      const sizeByGroup = new Map<number, number>()
      for (const g of groups.values()) sizeByGroup.set(g, (sizeByGroup.get(g) ?? 0) + 1)

      for (const s of teamPlayers) {
        const g = groups.get(playerKey(s.live))
        if (g != null) {
          s.premadeGroup = g
          s.premadeLabel = premadeLabel(sizeByGroup.get(g) ?? 2)
        } else {
          s.premadeLabel = 'Solo'
        }
      }
    }
  }

  private assignRoles(): void {
    const all = [...this.players.values()]
    for (const s of all) {
      // Own team: exact role from champ select, matched by puuid (robust) or by
      // game name (available before identities resolve).
      const own = this.ownRoleFor(s)
      if (own && own !== 'UNKNOWN') {
        s.currentRole = own
      }
    }
    // Enemy team (and any unmatched): infer per team.
    for (const team of ['ORDER', 'CHAOS'] as const) {
      const teamPlayers = all.filter((s) => s.live.team === team && !s.currentRole)
      if (teamPlayers.length === 0) continue
      const resolved = resolveTeamRoles(
        teamPlayers.map((s) => ({
          id: playerKey(s.live),
          input: {
            summonerSpells: s.live.summonerSpells,
            champion:
              s.live.championId != null ? this.ddragon.byId(s.live.championId) : undefined
          }
        }))
      )
      for (const s of teamPlayers) {
        s.currentRole = resolved.get(playerKey(s.live)) ?? inferEnemyRole({
          summonerSpells: s.live.summonerSpells,
          champion: s.live.championId != null ? this.ddragon.byId(s.live.championId) : undefined
        })
      }
    }
  }

  /** Look up an own-team champ-select role for a tracked player, if we recorded
   *  one. Prefers the puuid key (exact) and falls back to game name. */
  private ownRoleFor(s: ScoutedPlayer): Role | undefined {
    if (s.puuid) {
      const byPuuid = this.ownRoles.get(`puuid:${s.puuid}`)
      if (byPuuid) return byPuuid
    }
    if (s.live.gameName) {
      return this.ownRoles.get(`name:${s.live.gameName.toLowerCase()}`)
    }
    return undefined
  }

  /** Recompute off-role flags from the current role assignment and each player's
   *  derived main role. Called after roles may have changed post-enrichment. */
  private recomputeOffRoles(): void {
    for (const s of this.players.values()) {
      if (
        s.currentRole &&
        s.currentRole !== 'UNKNOWN' &&
        s.stats &&
        s.stats.mainRole !== 'UNKNOWN'
      ) {
        s.offRole = s.currentRole !== s.stats.mainRole
      }
    }
  }

  private async enrichPlayer(s: ScoutedPlayer, force: boolean): Promise<void> {
    if (!s.live.gameName || !s.live.tagLine) {
      s.loading.identity = 'error'
      s.error = 'Missing Riot ID'
      return
    }
    try {
      // 1) Identity (PUUID)
      s.loading.identity = 'loading'
      this.scheduleEmit()
      const account = await this.cachedAccount(s.live.gameName, s.live.tagLine, force)
      if (!account) {
        s.loading.identity = 'error'
        return
      }
      s.puuid = account.puuid
      s.loading.identity = 'done'
      this.scheduleEmit()

      // 2) Cheap data first: rank + mastery in parallel.
      const rankP = this.loadRank(s, force)
      const masteryP = this.loadMastery(s, force)
      await Promise.all([rankP, masteryP])

      // 3) Expensive: match-derived stats.
      await this.loadMatches(s, force)
    } catch (e) {
      s.error = e instanceof Error ? e.message : String(e)
      this.log(`Enrich failed for ${playerKey(s.live)}: ${s.error}`)
      this.scheduleEmit()
    }
  }

  private async loadRank(s: ScoutedPlayer, force: boolean): Promise<void> {
    if (!s.puuid) return
    s.loading.rank = 'loading'
    try {
      const entries = await this.cachedRank(s.puuid, force)
      const soloDto = entries.find((e) => e.queueType === 'RANKED_SOLO_5x5')
      const flexDto = entries.find((e) => e.queueType === 'RANKED_FLEX_SR')
      s.soloRank = soloDto ? toRankEntry(soloDto) : null
      s.flexRank = flexDto ? toRankEntry(flexDto) : null
      // Record/observe the all-time peak Solo/Duo rank we've seen for them.
      if (s.puuid) s.peakSoloRank = this.peakRanks.observe(s.puuid, s.soloRank)
      s.loading.rank = 'done'
    } catch {
      s.loading.rank = 'error'
    }
    this.scheduleEmit()
  }

  private async loadMastery(s: ScoutedPlayer, force: boolean): Promise<void> {
    if (!s.puuid || s.live.championId == null) {
      s.loading.mastery = 'done'
      return
    }
    s.loading.mastery = 'loading'
    try {
      const championId = s.live.championId
      const dto = await this.cache.getOrCompute(
        `mastery:${s.puuid}:${championId}`,
        () => this.riot.getMastery(s.puuid!, championId),
        force ? 0 : undefined
      )
      s.mastery = dto ? { championLevel: dto.championLevel, championPoints: dto.championPoints } : null
      s.loading.mastery = 'done'
    } catch {
      s.loading.mastery = 'error'
    }
    this.scheduleEmit()
  }

  private async loadMatches(s: ScoutedPlayer, force: boolean): Promise<void> {
    if (!s.puuid) return
    s.loading.matches = 'loading'
    this.scheduleEmit()
    try {
      const puuid = s.puuid
      const ids = await this.cache.getOrCompute(
        `matchIds:${puuid}`,
        () => this.riot.getMatchIds(puuid, 15),
        force ? 0 : 10 * 60_000 // match id lists change often; short TTL
      )
      // Fetch each match, cached individually (matches are immutable).
      const matches = await Promise.all(
        ids.map((id) =>
          this.cache
            .getOrCompute(`match:${id}`, () => this.riot.getMatch(id), 24 * 60 * 60_000)
            .catch(() => null)
        )
      )
      const valid = matches.filter((m): m is NonNullable<typeof m> => m != null)
      // Ranked-only: ids were fetched with type=ranked; filter defensively too.
      s.stats = deriveStats(puuid, valid, {
        championId: s.live.championId,
        queueIds: RANKED_QUEUE_IDS
      })
      // Record (matchId, historical team) pairs for premade detection.
      const history: Array<{ matchId: string; teamId: number }> = []
      for (const m of valid) {
        const part = findParticipant(m, puuid)
        if (part) history.push({ matchId: m.metadata.matchId, teamId: part.teamId })
      }
      this.matchHistory.set(playerKey(s.live), history)
      // Off-role flag: current role vs derived main role.
      if (s.currentRole && s.currentRole !== 'UNKNOWN' && s.stats.mainRole !== 'UNKNOWN') {
        s.offRole = s.currentRole !== s.stats.mainRole
      }
      s.loading.matches = 'done'
    } catch (e) {
      s.loading.matches = 'error'
      if (e instanceof RiotApiError && e.status === 429) {
        this.log('Rate limited while loading matches — backing off.')
      }
    }
    this.scheduleEmit()
  }

  // ---- cached Riot lookups ----

  private async cachedAccount(gameName: string, tagLine: string, force = false) {
    return this.cache.getOrCompute(
      `account:${gameName.toLowerCase()}#${tagLine.toLowerCase()}`,
      () => this.riot.getAccountByRiotId(gameName, tagLine),
      force ? 0 : 24 * 60 * 60_000 // Riot IDs are stable; cache a day.
    )
  }

  private async cachedRank(puuid: string, force = false) {
    return this.cache.getOrCompute(
      `rank:${puuid}`,
      () => this.riot.getLeagueEntriesByPuuid(puuid),
      force ? 0 : undefined
    )
  }

  // ---- emit throttling ----

  private scheduleEmit(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('snapshot', this.getSnapshot())
    }, 120)
    if (typeof this.emitTimer.unref === 'function') this.emitTimer.unref()
  }

  private startRateStatus(): void {
    this.rateTimer = setInterval(() => {
      this.emit('rateStatus', this.limiter.status())
    }, 1000)
    if (typeof this.rateTimer.unref === 'function') this.rateTimer.unref()
  }

  private log(line: string): void {
    this.emit('log', line)
  }

  /** Validate a key by making one cheap authenticated call. */
  async testApiKey(): Promise<{ ok: boolean; message: string }> {
    const key = this.settings.getApiKey()
    if (!key) return { ok: false, message: 'No API key set.' }
    try {
      // account-v1 lookup of a well-known account is a light validity probe.
      await this.riot.getAccountByRiotId('RiotGames', 'NA1')
      return { ok: true, message: 'Key is valid.' }
    } catch (e) {
      if (e instanceof RiotApiError) {
        if (e.status === 401 || e.status === 403) {
          return { ok: false, message: 'Key rejected (401/403). It may be expired.' }
        }
        if (e.status === 404) {
          // Probe account not found, but the key itself authenticated fine.
          return { ok: true, message: 'Key is valid.' }
        }
        return { ok: false, message: `Riot API error ${e.status}.` }
      }
      return { ok: false, message: (e as Error).message }
    }
  }
}

function splitName(riotId: string): [string, string] {
  const hash = riotId.lastIndexOf('#')
  if (hash > 0) return [riotId.slice(0, hash), riotId.slice(hash + 1)]
  return [riotId, '']
}
