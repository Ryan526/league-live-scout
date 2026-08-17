// Shared types used across main, preload, and renderer processes.
// Keep this file free of any Node/Electron/DOM imports so it can be consumed
// by every process.

/** High-level phase of the League client / game, driving the scout UI. */
export type GamePhase =
  | 'Idle'
  | 'Lobby'
  | 'Matchmaking'
  | 'ChampSelect'
  | 'InGame'
  | 'PostGame'
  | 'Reconnect'

export type TeamId = 'ORDER' | 'CHAOS' | 'UNKNOWN'

/** Canonical role names used throughout the app. */
export type Role = 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY' | 'UNKNOWN'

/** A player as first observed from Live Client Data (identity + champ), before
 *  Riot API enrichment. */
export interface LivePlayer {
  /** `gameName#tagLine` (Riot ID). May be missing for bots. */
  riotId: string
  gameName: string
  tagLine: string
  championName: string
  /** Data Dragon numeric champion id, resolved from championName. */
  championId?: number
  team: TeamId
  position?: Role
  summonerSpells: string[]
  isBot: boolean
  /** Live scoreboard, when available. */
  scores?: LiveScores
}

export interface LiveScores {
  kills: number
  deaths: number
  assists: number
  creepScore: number
  wardScore: number
}

export interface RankEntry {
  queueType: string
  tier: string
  rank: string
  leaguePoints: number
  wins: number
  losses: number
}

/** Aggregated stats derived from a player's recent match history. */
export interface MatchDerivedStats {
  /** Number of recent matches sampled. */
  sampleSize: number
  /** Win rate on the currently-picked champion, 0..1, or null if no games. */
  championWinRate: number | null
  championGames: number
  championWins: number
  /** Average KDA ratio over the sample: (K+A)/max(D,1). */
  avgKda: number | null
  avgKills: number
  avgDeaths: number
  avgAssists: number
  /** Most common teamPosition across the sample = inferred main role. */
  mainRole: Role
  /** Distribution of positions played, for tooltips. */
  roleCounts: Partial<Record<Role, number>>
  /** Last-N win/loss ordered most-recent-first, e.g. ['W','L','W']. */
  recentForm: Array<'W' | 'L'>
}

export interface MasteryInfo {
  championLevel: number
  championPoints: number
}

/** A player's fully-enriched scouting card. Fields fill in progressively. */
export interface ScoutedPlayer {
  live: LivePlayer
  puuid?: string
  /** Solo/Duo ranked entry, when available. */
  soloRank?: RankEntry | null
  flexRank?: RankEntry | null
  /** Highest Solo/Duo rank ever observed for this player by this app (tracked
   *  locally over time — the Riot API exposes no all-time peak). */
  peakSoloRank?: RankEntry | null
  mastery?: MasteryInfo | null
  stats?: MatchDerivedStats | null
  /** Current role for this game: exact for own team (from LCU), inferred for
   *  enemies (smite/spells/champion tags). */
  currentRole?: Role
  /** True when currentRole differs from the derived mainRole. */
  offRole?: boolean
  /** Premade group id within this player's team (players sharing a value are
   *  queued together). Undefined/solo when the player has no detected premade. */
  premadeGroup?: number
  /** Human label for the premade status, e.g. "Duo", "Trio", "Solo". */
  premadeLabel?: string
  /** Per-field load status so the UI can show spinners/errors granularly. */
  loading: LoadState
  error?: string
}

export interface LoadState {
  identity: FieldStatus
  rank: FieldStatus
  mastery: FieldStatus
  matches: FieldStatus
}

export type FieldStatus = 'idle' | 'loading' | 'done' | 'error'

/** Snapshot of the whole scout state, pushed to the renderer. */
export interface ScoutSnapshot {
  phase: GamePhase
  /** Whether the LCU (League client) is currently connected. */
  lcuConnected: boolean
  /** Whether an in-game Live Client session is active. */
  liveConnected: boolean
  gameMode?: string
  players: ScoutedPlayer[]
  /** Data Dragon patch version in use. */
  patch?: string
  updatedAt: number
}

export interface AppSettings {
  /** Whether a Riot API key has been stored (never send the key itself to UI). */
  hasApiKey: boolean
  region: RegionConfig
  /** Poll interval (ms) for Live Client Data while in game. */
  livePollMs: number
}

export interface RegionConfig {
  /** Platform routing value, e.g. 'na1'. */
  platform: string
  /** Regional routing value, e.g. 'americas'. */
  regional: string
}

export interface RateLimiterStatus {
  /** Requests made in the current app+method windows, for a debug readout. */
  inFlight: number
  queued: number
  /** Timestamp until which we are backing off due to a 429, if any. */
  retryAfterUntil?: number
}

/** Ranked tiers from lowest to highest. */
export const TIER_ORDER = [
  'IRON',
  'BRONZE',
  'SILVER',
  'GOLD',
  'PLATINUM',
  'EMERALD',
  'DIAMOND',
  'MASTER',
  'GRANDMASTER',
  'CHALLENGER'
] as const

const DIVISION_ORDER: Record<string, number> = { IV: 0, III: 1, II: 2, I: 3 }

/**
 * Monotonic numeric score for a rank so two ranks can be compared. Higher is
 * better. Unranked/undefined scores -1. Works across apex tiers (Master+),
 * where LP is the differentiator.
 */
export function rankScore(r: RankEntry | null | undefined): number {
  if (!r || !r.tier) return -1
  const tierIdx = TIER_ORDER.indexOf(r.tier.toUpperCase() as (typeof TIER_ORDER)[number])
  if (tierIdx < 0) return -1
  const divIdx = DIVISION_ORDER[r.rank?.toUpperCase()] ?? 3 // apex tiers have no division
  return tierIdx * 10000 + divIdx * 1000 + (r.leaguePoints ?? 0)
}

/** Return whichever of two ranks is higher (by rankScore). */
export function higherRank(
  a: RankEntry | null | undefined,
  b: RankEntry | null | undefined
): RankEntry | null {
  const sa = rankScore(a)
  const sb = rankScore(b)
  if (sa < 0 && sb < 0) return null
  return sb > sa ? b! : a ?? b ?? null
}

/** Ranked queue ids used to filter match history to ranked play only. */
export const RANKED_QUEUE_IDS = [420, 440] // 420 = Solo/Duo, 440 = Flex

/** Human-facing label for a role. Riot's data uses UTILITY for the bot-lane
 *  support slot; we surface it as "Support" everywhere in the UI. */
export function roleLabel(role: Role): string {
  switch (role) {
    case 'TOP':
      return 'Top'
    case 'JUNGLE':
      return 'Jungle'
    case 'MIDDLE':
      return 'Mid'
    case 'BOTTOM':
      return 'Bot'
    case 'UTILITY':
      return 'Support'
    default:
      return '—'
  }
}

/** IPC channel names, kept in one place to avoid typos across processes. */
export const IPC = {
  // renderer -> main (invoke)
  getSnapshot: 'scout:getSnapshot',
  getSettings: 'settings:get',
  setApiKey: 'settings:setApiKey',
  clearApiKey: 'settings:clearApiKey',
  setRegion: 'settings:setRegion',
  testApiKey: 'settings:testApiKey',
  rescout: 'scout:rescout',
  // renderer -> main (send, fire-and-forget)
  resizeWindow: 'window:resizeToContent',
  // main -> renderer (send)
  snapshot: 'scout:snapshot',
  rateStatus: 'scout:rateStatus',
  log: 'scout:log'
} as const
