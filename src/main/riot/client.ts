// Typed Riot Games API client. All requests go through the shared RateLimiter,
// reconcile against Riot's rate-limit headers, and retry on 429/5xx with
// respect for Retry-After.

import type { RankEntry, RegionConfig } from '@shared/types'
import { accountRoute } from '@shared/types'
import { RateLimiter } from './rateLimiter'

/** Give up on a hung connection. Without this the limiter's in-flight counter
 *  never decrements and the affected player loads forever. */
const REQUEST_TIMEOUT_MS = 12_000
/** Default match-id page size when a caller doesn't specify one. */
export const DEFAULT_MATCH_COUNT = 10

/**
 * Riot budgets rate limits per *method*, not per URL, so every match lookup
 * shares one bucket no matter which match id it names. These keys mirror that
 * grouping; they are what the limiter charges against.
 */
export const RiotMethod = {
  AccountByRiotId: 'account-v1.getByRiotId',
  LeagueByPuuid: 'league-v4.getEntriesByPUUID',
  MasteryByChampion: 'champion-mastery-v4.getChampionMasteryByPUUID',
  MatchIdsByPuuid: 'match-v5.getMatchIdsByPUUID',
  MatchById: 'match-v5.getMatch'
} as const

export interface AccountDto {
  puuid: string
  gameName: string
  tagLine: string
}

export interface LeagueEntryDto {
  queueType: string
  tier: string
  rank: string
  leaguePoints: number
  wins: number
  losses: number
}

export interface ChampionMasteryDto {
  championId: number
  championLevel: number
  championPoints: number
}

/**
 * The slice of match-v5 we actually use. A raw MatchDto is enormous (~150
 * fields per participant) and a single game caches 10 of them per player, so
 * `getMatch` projects down to this before anything touches the cache.
 */
export interface MatchDto {
  metadata: { matchId: string }
  info: {
    queueId: number
    gameDuration: number
    participants: MatchParticipantDto[]
  }
}

export interface MatchParticipantDto {
  puuid: string
  /** 100 (blue) or 200 (red) in the historical match. */
  teamId: number
  championId: number
  kills: number
  deaths: number
  assists: number
  win: boolean
  teamPosition: string
  individualPosition: string
  totalMinionsKilled: number
  neutralMinionsKilled: number
}

export class RiotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string
  ) {
    super(message)
    this.name = 'RiotApiError'
  }
}

export interface RiotClientOptions {
  getApiKey: () => string | null
  region: RegionConfig
  limiter: RateLimiter
  fetchImpl?: typeof fetch
  /** Max retries for 429/5xx before giving up. */
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
}

export class RiotClient {
  private readonly getApiKey: () => string | null
  private region: RegionConfig
  private readonly limiter: RateLimiter
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: RiotClientOptions) {
    this.getApiKey = opts.getApiKey
    this.region = opts.region
    this.limiter = opts.limiter
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.maxRetries = opts.maxRetries ?? 3
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  setRegion(region: RegionConfig): void {
    this.region = region
  }

  private platformHost(): string {
    return `https://${this.region.platform}.api.riotgames.com`
  }

  /** match-v5 and friends. May be 'sea', which account-v1 does not serve. */
  private matchHost(): string {
    return `https://${this.region.regional}.api.riotgames.com`
  }

  /** account-v1 only routes to americas/asia/europe. */
  private accountHost(): string {
    return `https://${accountRoute(this.region)}.api.riotgames.com`
  }

  /** Core request: rate-limited, header-reconciled, retrying.
   *  `method` names the endpoint so its own budget is tracked separately. */
  private async request<T>(host: string, path: string, method: string): Promise<T> {
    const key = this.getApiKey()
    if (!key) throw new RiotApiError('No Riot API key configured', 401, path)
    const url = `${host}${path}`

    let attempt = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.limiter.schedule(
        () =>
          this.fetchImpl(url, {
            headers: { 'X-Riot-Token': key },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          }),
        method
      )
      // Riot tells us both budgets and our usage against each; adopt all four.
      this.limiter.applyLimitsFromHeader(res.headers.get('x-app-rate-limit'))
      this.limiter.reconcileFromHeader(res.headers.get('x-app-rate-limit-count'))
      this.limiter.applyMethodLimitsFromHeader(
        method,
        res.headers.get('x-method-rate-limit')
      )
      this.limiter.reconcileMethodFromHeader(
        method,
        res.headers.get('x-method-rate-limit-count')
      )

      if (res.ok) {
        return (await res.json()) as T
      }

      // 404 is a normal "no data" for many endpoints — surface it distinctly.
      if (res.status === 404) {
        throw new RiotApiError('Not found', 404, path)
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
        if (res.status === 429) {
          // A method-scoped 429 must not stall every other endpoint; only an
          // application (or unlabelled) one justifies a global backoff.
          const scope = res.headers.get('x-rate-limit-type')?.toLowerCase()
          this.limiter.applyRetryAfter(retryAfter, scope === 'method' ? method : undefined)
        }
        if (attempt++ >= this.maxRetries) {
          throw new RiotApiError(
            `Riot API ${res.status} after ${attempt} attempts`,
            res.status,
            path
          )
        }
        await this.sleep(Math.max(retryAfter * 1000, 1000 * attempt))
        continue
      }

      const body = await res.text().catch(() => '')
      throw new RiotApiError(
        `Riot API ${res.status}: ${body.slice(0, 200)}`,
        res.status,
        path
      )
    }
  }

  // --- account-v1 (account route) ---
  async getAccountByRiotId(gameName: string, tagLine: string): Promise<AccountDto> {
    const path = `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
      gameName
    )}/${encodeURIComponent(tagLine)}`
    return this.request<AccountDto>(this.accountHost(), path, RiotMethod.AccountByRiotId)
  }

  // --- league-v4 (platform route) ---
  async getLeagueEntriesByPuuid(puuid: string): Promise<LeagueEntryDto[]> {
    const path = `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`
    return this.request<LeagueEntryDto[]>(this.platformHost(), path, RiotMethod.LeagueByPuuid)
  }

  // --- champion-mastery-v4 (platform route) ---
  async getMastery(puuid: string, championId: number): Promise<ChampionMasteryDto | null> {
    const path = `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(
      puuid
    )}/by-champion/${championId}`
    try {
      return await this.request<ChampionMasteryDto>(
        this.platformHost(),
        path,
        RiotMethod.MasteryByChampion
      )
    } catch (e) {
      // No mastery on this champ is a 404 — treat as "never played".
      if (e instanceof RiotApiError && e.status === 404) return null
      throw e
    }
  }

  // --- match-v5 (regional route) ---
  /**
   * Recent match ids for a player. `type` filters at the API level; we default
   * to 'ranked' so only ranked play feeds the derived stats. Passing `type:
   * undefined` returns all queues.
   */
  async getMatchIds(
    puuid: string,
    count = DEFAULT_MATCH_COUNT,
    type: 'ranked' | 'normal' | 'tourney' | 'tutorial' | null = 'ranked'
  ): Promise<string[]> {
    const typeParam = type ? `&type=${type}` : ''
    const path = `/lol/match/v5/matches/by-puuid/${encodeURIComponent(
      puuid
    )}/ids?start=0&count=${count}${typeParam}`
    return this.request<string[]>(this.matchHost(), path, RiotMethod.MatchIdsByPuuid)
  }

  async getMatch(matchId: string): Promise<MatchDto> {
    const path = `/lol/match/v5/matches/${encodeURIComponent(matchId)}`
    const raw = await this.request<MatchDto>(this.matchHost(), path, RiotMethod.MatchById)
    return projectMatch(raw)
  }
}

/**
 * Keep only the fields the app reads. `res.json()` hands back every field Riot
 * sends regardless of the declared type, and those objects go straight into the
 * persisted cache; projecting here keeps cache.json in the low hundreds of KB
 * instead of tens of MB.
 */
export function projectMatch(raw: MatchDto): MatchDto {
  return {
    metadata: { matchId: raw.metadata?.matchId },
    info: {
      queueId: raw.info?.queueId,
      gameDuration: raw.info?.gameDuration,
      participants: (raw.info?.participants ?? []).map((p) => ({
        puuid: p.puuid,
        teamId: p.teamId,
        championId: p.championId,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        win: p.win,
        teamPosition: p.teamPosition,
        individualPosition: p.individualPosition,
        totalMinionsKilled: p.totalMinionsKilled,
        neutralMinionsKilled: p.neutralMinionsKilled
      }))
    }
  }
}

/**
 * Retry-After is "delay-seconds" for Riot, but the HTTP spec also allows an
 * HTTP-date and proxies do send them. `Number(date)` is NaN, which silently
 * disabled the backoff gate and made `setTimeout(fn, NaN)` fire immediately —
 * i.e. a burst of retries straight back at an endpoint that just 429'd.
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number {
  if (!header) return 1
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, (date - now) / 1000)
  return 1
}

/** Convert a raw league entry DTO into the shared RankEntry shape. */
export function toRankEntry(dto: LeagueEntryDto): RankEntry {
  return {
    queueType: dto.queueType,
    tier: dto.tier,
    rank: dto.rank,
    leaguePoints: dto.leaguePoints,
    wins: dto.wins,
    losses: dto.losses
  }
}
