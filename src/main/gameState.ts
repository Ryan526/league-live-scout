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
  RateLimiterStatus,
  Role,
  ScoutSnapshot,
  ScoutedPlayer
} from '@shared/types'
import { RANKED_QUEUE_IDS } from '@shared/types'
import type { Settings } from './settings'
import { PeakRankStore } from './peakRank'
import { Lcu, type ChampSelectPlayer } from './lcu'
import { LiveClient, mergeLivePlayer } from './liveClient'
import { RateLimiter } from './riot/rateLimiter'
import { RiotClient, RiotApiError, toRankEntry } from './riot/client'
import { TtlCache } from './riot/cache'
import { DataDragon } from './riot/ddragon'
import { deriveStats, findParticipant } from './riot/stats'
import { assignTeamRoles, type TeamMember } from './riot/roles'
import { detectPremades, premadeLabel, type PremadeInput } from './riot/premades'

// ---- tuning constants ----

/** Recent ranked games sampled per player. Every game is one API request per
 *  player, so this is the single biggest lever on time-to-data. */
const MATCH_SAMPLE_SIZE = 10
/** Match-id lists change after every game, so they get a short TTL. */
const MATCH_IDS_TTL_MS = 10 * 60_000
/** Riot IDs and finished matches are effectively immutable. */
const ACCOUNT_TTL_MS = 24 * 60 * 60_000
const MATCH_TTL_MS = 24 * 60 * 60_000
/** Coalesce snapshot pushes: stats stream in far faster than the UI needs. */
const EMIT_DEBOUNCE_MS = 120
/** How often the Riot queue readout is recomputed (only pushed when it moves). */
const RATE_STATUS_INTERVAL_MS = 1000
/** Backoff before retrying a player whose enrichment failed. */
const ENRICH_RETRY_BASE_MS = 15_000
const ENRICH_RETRY_MAX_MS = 5 * 60_000
const ENRICH_MAX_ATTEMPTS = 4

/** Only Summoner's Rift has the five assigned lanes this app reasons about. */
const SR_GAME_MODE = 'CLASSIC'

export interface GameStateDeps {
  settings: Settings
  cacheFilePath: string
}

export interface GameStateEvents {
  snapshot: (snap: ScoutSnapshot) => void
  log: (line: string) => void
  rateStatus: (status: RateLimiterStatus) => void
}

export declare interface GameState {
  on<K extends keyof GameStateEvents>(event: K, listener: GameStateEvents[K]): this
  emit<K extends keyof GameStateEvents>(
    event: K,
    ...args: Parameters<GameStateEvents[K]>
  ): boolean
}

/**
 * A stable key for a tracked player.
 *
 * Riot IDs are NOT stable here: the Live Client commonly reports only
 * `riotIdGameName` on the loading screen and a full `riotId` in game, so keying
 * on the Riot ID re-keyed every player mid-load and threw away all enrichment.
 * A champion is unique within a team in every mode, and the team+champion pair
 * is known from the very first payload, so that is the durable identity. Index
 * is the last resort for a payload with neither.
 */
function playerKey(p: LivePlayer, index: number): string {
  if (p.championName) return `c:${p.team}:${p.championName.toLowerCase()}`
  if (p.riotId) return `r:${p.riotId.toLowerCase()}`
  return `i:${index}`
}

/** Champ select hands out an all-zero placeholder PUUID for other players. */
function isRealPuuid(puuid: string | undefined): boolean {
  return Boolean(puuid) && !/^[0-]+$/.test(puuid as string)
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
  /** Current scouted players keyed by playerKey(). */
  private players = new Map<string, ScoutedPlayer>()
  /** Own-team roles observed from champ select, keyed by puuid/name. */
  private ownRoles = new Map<string, Role>()
  /** Recent (matchId, historical teamId) pairs per PUUID, for premade detection. */
  private matchHistory = new Map<string, Array<{ matchId: string; teamId: number }>>()
  private ownChampSelect: ChampSelectPlayer[] = []
  private emitTimer: NodeJS.Timeout | null = null
  private rateTimer: NodeJS.Timeout | null = null
  private lastRateStatus = ''
  /** Latch so the "no API key" hint is logged once, not on every 5s poll. */
  private noKeyLogged = false
  /** Set when Riot answers 401/403 — surfaced to the UI as a banner. */
  private apiKeyRejected = false
  /** Re-entrancy guard: the live poller fires every few seconds and must never
   *  overlap with itself or with a Re-scout. */
  private enriching = false
  private rerunRequested = false
  private rerunForce = false
  /** Per-player retry bookkeeping after a failed enrichment. */
  private retry = new Map<string, { attempts: number; nextAt: number }>()
  private stopped = false

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
    // Data Dragon is a network round-trip; don't hold up the window for it.
    void this.ddragon
      .ensureLoaded()
      .then(() => this.log(`Data Dragon loaded (patch ${this.ddragon.currentPatch}).`))
      .catch((e: Error) => this.log(`Data Dragon load failed: ${e.message}`))
    this.lcu.start()
    // Poll the live client independent of the LCU: catches spectator/reconnect
    // and is cheap (localhost, no auth).
    this.live.start()
    this.startRateStatus()
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.lcu.stop()
    this.live.stop()
    if (this.rateTimer) {
      clearInterval(this.rateTimer)
      this.rateTimer = null
    }
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    // Anything still queued is for a game that is over.
    this.limiter.clearQueue()
    this.cache.cancelPendingSave()
    await this.cache.flush()
  }

  onRegionChanged(): void {
    this.riot.setRegion(this.settings.getRegion())
    this.apiKeyRejected = false
    // Cache keys are region-scoped, so stale entries can't be served for the
    // new region — but in-memory player state was fetched against the old one.
    this.resetPlayerData()
    this.scheduleEmit()
  }

  /** Called when the stored key changes: clears the "rejected" banner state. */
  onApiKeyChanged(): void {
    this.apiKeyRejected = false
    this.noKeyLogged = false
    this.retry.clear()
    this.scheduleEmit()
  }

  onLivePollMsChanged(): void {
    this.live.setPollInterval(this.settings.getLivePollMs())
  }

  clearPeakRanks(): void {
    this.peakRanks.clear()
    for (const s of this.players.values()) s.peakSoloRank = null
    this.log('Cleared locally-tracked peak ranks.')
    this.scheduleEmit()
  }

  getSnapshot(): ScoutSnapshot {
    return {
      phase: this.phase,
      lcuConnected: this.lcu.isConnected,
      liveConnected: this.live.isConnected,
      gameMode: this.gameMode,
      players: [...this.players.values()],
      patch: this.ddragon.currentPatch || undefined,
      apiKeyRejected: this.apiKeyRejected || undefined,
      updatedAt: Date.now()
    }
  }

  /** Force a re-scout of everyone currently tracked (bypasses the cache). */
  async rescout(): Promise<void> {
    // Reset in place rather than clearing the map: clearing made the UI flash
    // its empty state, and left a window where an in-flight live poll could
    // repopulate the map behind our back.
    this.resetPlayerData()
    this.apiKeyRejected = false
    this.noKeyLogged = false
    this.log('Re-scouting: refetching all players, ignoring cached data.')
    this.scheduleEmit()
    await this.runEnrichment(true)
  }

  private resetPlayerData(): void {
    for (const s of this.players.values()) {
      s.loading = { identity: 'idle', rank: 'idle', mastery: 'idle', matches: 'idle' }
      s.error = undefined
      s.soloRank = undefined
      s.flexRank = undefined
      s.noRankData = undefined
      s.mastery = undefined
      s.stats = undefined
      s.premadeGroup = undefined
      s.premadeLabel = undefined
    }
    this.retry.clear()
    this.matchHistory.clear()
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
    this.live.on('players', (players, mode) => this.onLivePlayers(players, mode))
  }

  private onPhase(phase: GamePhase, raw: string): void {
    this.phase = phase
    this.log(`Phase -> ${phase} (${raw}).`)
    if (phase === 'ChampSelect') {
      // A new lobby is the natural moment to notice a patch bump.
      void this.ddragon.refreshIfStale().catch(() => undefined)
      void this.prewarmOwnTeam()
    } else if (phase === 'Idle' || phase === 'Lobby' || phase === 'Matchmaking') {
      // Fresh lobby: clear the board for the next game. Matchmaking is included
      // because a dodge goes ChampSelect -> Matchmaking -> ChampSelect without
      // ever touching Idle, and the previous lobby's roles would otherwise be
      // applied to the new game.
      this.resetForNewGame()
    }
    this.scheduleEmit()
  }

  private resetForNewGame(): void {
    this.players.clear()
    this.ownRoles.clear()
    this.ownChampSelect = []
    this.matchHistory.clear()
    this.retry.clear()
    this.noKeyLogged = false
    this.gameMode = undefined
  }

  private onChampSelect(players: ChampSelectPlayer[]): void {
    this.ownChampSelect = players
    void this.prewarmOwnTeam()
  }

  /** During champ select, record our own team's assigned roles and (when a key
   *  is configured) warm identity+rank to spread the load. */
  private async prewarmOwnTeam(): Promise<void> {
    const players =
      this.ownChampSelect.length > 0 ? this.ownChampSelect : await this.lcu.getChampSelect()
    this.ownChampSelect = players

    // Roles come from the LCU and cost zero Riot quota, so they are recorded
    // before (and independently of) the API-key check below. Without this, the
    // app's own "identities only" mode fell back to guessing our own team.
    for (const p of players) {
      if (!p.assignedPosition || p.assignedPosition === 'UNKNOWN') continue
      if (isRealPuuid(p.puuid)) this.ownRoles.set(`puuid:${p.puuid}`, p.assignedPosition)
      if (p.summonerName) {
        this.ownRoles.set(`name:${p.summonerName.toLowerCase()}`, p.assignedPosition)
      }
    }
    this.assignRoles()
    this.scheduleEmit()

    if (!this.settings.getApiKey()) return

    for (const p of players) {
      // Identity prewarm needs a full Riot ID; skip when champ select only gave
      // a bare game name (the common case on current patches).
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

  private onLivePlayers(livePlayers: LivePlayer[], mode: string): void {
    this.gameMode = mode
    this.syncPlayers(livePlayers)
    this.assignRoles()
    this.scheduleEmit()

    if (!this.settings.getApiKey()) {
      if (!this.noKeyLogged) {
        this.noKeyLogged = true
        this.log('No Riot API key set — showing identities only. Add a key in Settings.')
      }
      return
    }
    void this.runEnrichment(false)
  }

  /** Reconcile the tracked player set against a fresh Live Client payload. */
  private syncPlayers(livePlayers: LivePlayer[]): void {
    // Cheap and rate-limited internally. Covers the case where the app started
    // mid-game, or Data Dragon was unreachable at launch: without champion data
    // there is no championId, so mastery would be skipped for the whole game.
    void this.ddragon.refreshIfStale().catch(() => undefined)

    const seen = new Set<string>()
    livePlayers.forEach((lp, index) => {
      const rec = this.ddragon.resolve(lp.championName)
      if (rec) {
        lp.championId = rec.id
        // The CDN names its files by internal key ("MasterYi"), not by the
        // display name the Live Client sends ("Master Yi").
        lp.championKey = rec.key
      }
      const key = playerKey(lp, index)
      seen.add(key)
      const existing = this.players.get(key)
      if (existing) {
        existing.live = mergeLivePlayer(existing.live, lp)
      } else {
        this.players.set(key, {
          live: lp,
          loading: { identity: 'idle', rank: 'idle', mastery: 'idle', matches: 'idle' }
        })
      }
    })
    // Drop players no longer present (shouldn't happen mid-game, but safe).
    for (const key of [...this.players.keys()]) {
      if (!seen.has(key)) this.players.delete(key)
    }
  }

  /**
   * Run the enrichment fan-out, never more than once at a time. A request that
   * arrives while one is running is coalesced into a single follow-up pass.
   */
  private async runEnrichment(force: boolean): Promise<void> {
    if (this.enriching) {
      this.rerunRequested = true
      this.rerunForce = this.rerunForce || force
      return
    }
    this.enriching = true
    try {
      let runForce = force
      do {
        this.rerunRequested = false
        await this.enrichAll(runForce)
        runForce = this.rerunForce
        this.rerunForce = false
      } while (this.rerunRequested)
    } catch (e) {
      this.log(`Enrichment pass failed: ${(e as Error).message}`)
    } finally {
      this.enriching = false
    }
  }

  private async enrichAll(force: boolean): Promise<void> {
    // Enrich each player only once per game: later Live Client polls just
    // refresh the live scoreboard and must NOT re-queue the whole set of Riot
    // API calls, or the request queue balloons. Players that errored are
    // retried on a later poll, with backoff.
    const now = Date.now()
    const toEnrich = [...this.players.entries()].filter(([key, s]) => {
      if (s.live.isBot) return false
      if (force || s.loading.identity === 'idle') return true
      if (s.loading.identity !== 'error') return false
      const r = this.retry.get(key)
      return !r || (r.attempts < ENRICH_MAX_ATTEMPTS && now >= r.nextAt)
    })
    if (toEnrich.length === 0) return

    await Promise.all(toEnrich.map(([key, s]) => this.enrichPlayer(key, s, force)))

    // Identities are resolved now, so own-team champ-select roles can match by
    // puuid (the reliable key) and inference can use each player's main role.
    this.assignRoles()
    this.recomputeOffRoles()
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
      const withHistory = teamPlayers.filter(
        (s) => (this.matchHistory.get(s.puuid ?? '')?.length ?? 0) > 0
      )
      // No history means no evidence either way. Saying "Solo" there would be
      // presenting absence of evidence as evidence of absence.
      const unknown = teamPlayers.filter((s) => !withHistory.includes(s))
      for (const s of unknown) s.premadeLabel = 'Unknown'
      if (withHistory.length < 2) continue

      const input: PremadeInput[] = withHistory.map((s) => ({
        key: s.puuid!,
        matches: this.matchHistory.get(s.puuid!) ?? []
      }))
      const groups = detectPremades(input)
      const sizeByGroup = new Map<number, number>()
      for (const g of groups.values()) sizeByGroup.set(g, (sizeByGroup.get(g) ?? 0) + 1)

      for (const s of withHistory) {
        const g = groups.get(s.puuid!)
        if (g != null) {
          s.premadeGroup = g
          s.premadeLabel = premadeLabel(sizeByGroup.get(g) ?? 2)
        } else {
          s.premadeLabel = 'Solo'
        }
      }
    }
  }

  /**
   * Recompute every player's role from scratch, per team, in priority order:
   *
   *   1. The Live Client's own `position` — exact, free, and available for BOTH
   *      teams. This is the answer whenever the payload carries it.
   *   2. The LCU champ-select assignment — exact, own team only.
   *   3. A scored inference over whatever lanes are left.
   *
   * Deliberately idempotent: an early call (before Data Dragon finished
   * loading, say) used to freeze a bad guess in place forever, because roles
   * were only ever assigned to players who didn't already have one.
   */
  private assignRoles(): void {
    const all = [...this.players.values()]
    if (!this.isSummonersRift()) {
      // ARAM/Arena have no assigned lanes. Inventing five distinct ones per
      // team and then flagging everyone off-role against ranked SR history
      // produces pure noise.
      for (const s of all) {
        s.currentRole = undefined
        s.roleSource = undefined
        s.offRole = undefined
      }
      return
    }

    for (const team of ['ORDER', 'CHAOS'] as const) {
      const teamPlayers = all.filter((s) => s.live.team === team)
      if (teamPlayers.length === 0) continue

      const members: TeamMember[] = teamPlayers.map((s, i) => ({
        id: playerKey(s.live, i),
        position: s.live.position,
        champSelectRole: this.ownRoleFor(s),
        summonerSpells: s.live.summonerSpells,
        champion: s.live.championId != null ? this.ddragon.byId(s.live.championId) : undefined,
        mainRole: s.stats?.mainRole !== 'UNKNOWN' ? s.stats?.mainRole : undefined,
        sampleSize: s.stats?.sampleSize
      }))

      const assigned = assignTeamRoles(members)
      teamPlayers.forEach((s, i) => {
        const a = assigned.get(members[i].id)
        s.currentRole = a?.role ?? 'UNKNOWN'
        s.roleSource = a?.source
      })
    }
  }

  private isSummonersRift(): boolean {
    return !this.gameMode || this.gameMode === SR_GAME_MODE
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
      if (!this.isSummonersRift()) {
        s.offRole = undefined
        continue
      }
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

  private async enrichPlayer(key: string, s: ScoutedPlayer, force: boolean): Promise<void> {
    if (!s.live.gameName || !s.live.tagLine) {
      s.loading.identity = 'error'
      s.error = 'Missing Riot ID'
      return
    }
    try {
      // 1) Identity (PUUID)
      s.loading.identity = 'loading'
      s.error = undefined
      this.scheduleEmit()
      const account = await this.cachedAccount(s.live.gameName, s.live.tagLine, force)
      if (!account) {
        this.markEnrichFailed(key, s, 'No account returned')
        return
      }
      s.puuid = account.puuid
      s.loading.identity = 'done'
      this.retry.delete(key)
      this.scheduleEmit()

      // 2) Cheap data first: rank + mastery in parallel.
      await Promise.all([this.loadRank(s, force), this.loadMastery(s, force)])

      // 3) Expensive: match-derived stats.
      await this.loadMatches(s, force)
    } catch (e) {
      this.noteApiError(e)
      this.markEnrichFailed(key, s, e instanceof Error ? e.message : String(e))
      this.log(`Enrich failed for ${s.live.riotId || s.live.gameName}: ${s.error}`)
      this.scheduleEmit()
    }
  }

  /**
   * Record a terminal failure so the card stops spinning forever, and schedule
   * a backed-off retry. Previously the catch left `identity: 'loading'`, which
   * the re-entry filter (idle only) never picked up again.
   */
  private markEnrichFailed(key: string, s: ScoutedPlayer, message: string): void {
    s.loading.identity = 'error'
    s.error = message
    const prev = this.retry.get(key)
    const attempts = (prev?.attempts ?? 0) + 1
    const delay = Math.min(ENRICH_RETRY_BASE_MS * 2 ** (attempts - 1), ENRICH_RETRY_MAX_MS)
    this.retry.set(key, { attempts, nextAt: Date.now() + delay })
  }

  /** Riot development keys expire every 24h; a bare 401/403 was invisible. */
  private noteApiError(e: unknown): void {
    if (!(e instanceof RiotApiError)) return
    if (e.status === 401 || e.status === 403) {
      if (!this.apiKeyRejected) {
        this.apiKeyRejected = true
        this.log(
          `Riot API rejected the key (${e.status}). Development keys expire every 24 hours — paste a fresh one in Settings.`
        )
      }
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
      // An empty list is ambiguous: genuinely unranked, or the right player on
      // the wrong platform. Don't let the UI assert "Unranked".
      s.noRankData = entries.length === 0
      // Record/observe the all-time peak Solo/Duo rank we've seen for them.
      s.peakSoloRank = this.peakRanks.observe(s.puuid, s.soloRank)
      s.loading.rank = 'done'
    } catch (e) {
      this.noteApiError(e)
      s.loading.rank = 'error'
      s.error = s.error ?? `Rank lookup failed: ${(e as Error).message}`
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
        this.cacheKey(`mastery:${s.puuid}:${championId}`),
        () => this.riot.getMastery(s.puuid!, championId),
        { bypass: force }
      )
      s.mastery = dto
        ? { championLevel: dto.championLevel, championPoints: dto.championPoints }
        : null
      s.loading.mastery = 'done'
    } catch (e) {
      this.noteApiError(e)
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
        this.cacheKey(`matchIds:${puuid}`),
        () => this.riot.getMatchIds(puuid, MATCH_SAMPLE_SIZE),
        { bypass: force, ttlMs: MATCH_IDS_TTL_MS }
      )
      // Fetch each match, cached individually (matches are immutable).
      const matches = await Promise.all(
        ids.map((id) =>
          this.cache
            .getOrCompute(this.cacheKey(`match:${id}`), () => this.riot.getMatch(id), {
              ttlMs: MATCH_TTL_MS
            })
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
      this.matchHistory.set(puuid, history)
      s.loading.matches = 'done'
    } catch (e) {
      this.noteApiError(e)
      s.loading.matches = 'error'
      if (e instanceof RiotApiError && e.status === 429) {
        this.log('Rate limited while loading matches — backing off.')
      }
    }
    this.scheduleEmit()
  }

  // ---- cached Riot lookups ----

  /** Cache keys carry the platform: switching NA -> EUW previously kept serving
   *  the old region's data for up to a day. */
  private cacheKey(key: string): string {
    return `${this.settings.getRegion().platform}|${key}`
  }

  private async cachedAccount(gameName: string, tagLine: string, force = false) {
    return this.cache.getOrCompute(
      this.cacheKey(`account:${gameName.toLowerCase()}#${tagLine.toLowerCase()}`),
      () => this.riot.getAccountByRiotId(gameName, tagLine),
      { bypass: force, ttlMs: ACCOUNT_TTL_MS } // Riot IDs are stable; cache a day.
    )
  }

  private async cachedRank(puuid: string, force = false) {
    return this.cache.getOrCompute(
      this.cacheKey(`rank:${puuid}`),
      () => this.riot.getLeagueEntriesByPuuid(puuid),
      { bypass: force }
    )
  }

  // ---- emit throttling ----

  private scheduleEmit(): void {
    if (this.emitTimer || this.stopped) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('snapshot', this.getSnapshot())
    }, EMIT_DEBOUNCE_MS)
    if (typeof this.emitTimer.unref === 'function') this.emitTimer.unref()
  }

  private startRateStatus(): void {
    this.rateTimer = setInterval(() => {
      const status = this.limiter.status()
      // Only push when it actually moves; this used to IPC every second for the
      // entire life of the process even while completely idle.
      const fingerprint = `${status.inFlight}|${status.queued}|${status.retryAfterUntil ?? 0}`
      if (fingerprint === this.lastRateStatus) return
      this.lastRateStatus = fingerprint
      this.emit('rateStatus', status)
    }, RATE_STATUS_INTERVAL_MS)
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
      // Any authenticated 200 or 404 proves the key works. We probe a Riot ID
      // that almost certainly does not exist rather than a real account,
      // because a real account only lives on its own cluster — the old
      // "RiotGames#NA1" probe 404'd everywhere but americas and was then
      // treated as success, so it validated almost nothing outside NA.
      await this.riot.getAccountByRiotId('ScoutKeyProbe', 'ZZZZ9')
      this.apiKeyRejected = false
      return { ok: true, message: 'Key is valid.' }
    } catch (e) {
      if (e instanceof RiotApiError) {
        if (e.status === 401 || e.status === 403) {
          this.apiKeyRejected = true
          this.scheduleEmit()
          return { ok: false, message: 'Key rejected (401/403). It may be expired.' }
        }
        if (e.status === 404) {
          // Probe account not found, but the key itself authenticated fine.
          this.apiKeyRejected = false
          this.scheduleEmit()
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
