// Typed Riot Games API client. All requests go through the shared RateLimiter,
// reconcile against Riot's rate-limit headers, and retry on 429/5xx with
// respect for Retry-After.

import type { RankEntry, RegionConfig } from '@shared/types'
import { RateLimiter } from './rateLimiter'

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

export interface MatchDto {
  metadata: { matchId: string; participants: string[] }
  info: {
    gameMode: string
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
  championName: string
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

  private regionalHost(): string {
    return `https://${this.region.regional}.api.riotgames.com`
  }

  /** Core request: rate-limited, header-reconciled, retrying. */
  private async request<T>(host: string, path: string): Promise<T> {
    const key = this.getApiKey()
    if (!key) throw new RiotApiError('No Riot API key configured', 401, path)
    const url = `${host}${path}`

    let attempt = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.limiter.schedule(() =>
        this.fetchImpl(url, { headers: { 'X-Riot-Token': key } })
      )
      this.limiter.reconcileFromHeader(res.headers.get('x-app-rate-limit-count'))

      if (res.ok) {
        return (await res.json()) as T
      }

      // 404 is a normal "no data" for many endpoints — surface it distinctly.
      if (res.status === 404) {
        throw new RiotApiError('Not found', 404, path)
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '1')
        if (res.status === 429) this.limiter.applyRetryAfter(retryAfter)
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

  // --- account-v1 (regional route) ---
  async getAccountByRiotId(gameName: string, tagLine: string): Promise<AccountDto> {
    const path = `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
      gameName
    )}/${encodeURIComponent(tagLine)}`
    return this.request<AccountDto>(this.regionalHost(), path)
  }

  // --- league-v4 (platform route) ---
  async getLeagueEntriesByPuuid(puuid: string): Promise<LeagueEntryDto[]> {
    const path = `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`
    return this.request<LeagueEntryDto[]>(this.platformHost(), path)
  }

  // --- champion-mastery-v4 (platform route) ---
  async getMastery(puuid: string, championId: number): Promise<ChampionMasteryDto | null> {
    const path = `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(
      puuid
    )}/by-champion/${championId}`
    try {
      return await this.request<ChampionMasteryDto>(this.platformHost(), path)
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
    count = 15,
    type: 'ranked' | 'normal' | 'tourney' | 'tutorial' | null = 'ranked'
  ): Promise<string[]> {
    const typeParam = type ? `&type=${type}` : ''
    const path = `/lol/match/v5/matches/by-puuid/${encodeURIComponent(
      puuid
    )}/ids?start=0&count=${count}${typeParam}`
    return this.request<string[]>(this.regionalHost(), path)
  }

  async getMatch(matchId: string): Promise<MatchDto> {
    const path = `/lol/match/v5/matches/${encodeURIComponent(matchId)}`
    return this.request<MatchDto>(this.regionalHost(), path)
  }
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
