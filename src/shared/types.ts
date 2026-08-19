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

/**
 * The single canonical lane ordering: Top -> Jungle -> Mid -> Bot -> Support,
 * with UNKNOWN last. Everything that orders, iterates or ranks roles derives
 * from this array, so the scoreboard, the role assigner and the stats
 * aggregator can never disagree about what "role order" means.
 */
export const ROLE_ORDER: Role[] = [
  'TOP',
  'JUNGLE',
  'MIDDLE',
  'BOTTOM',
  'UTILITY',
  'UNKNOWN'
]

/** The five real Summoner's Rift lanes, in canonical order (no UNKNOWN). */
export const LANES: Role[] = ROLE_ORDER.filter((r) => r !== 'UNKNOWN')

/** Sort index for a role; unknown/undefined sorts last. */
export function roleRank(role: Role | undefined): number {
  const i = ROLE_ORDER.indexOf(role ?? 'UNKNOWN')
  return i < 0 ? ROLE_ORDER.length : i
}

/** Where a player's `currentRole` came from - fact vs. guess. */
export type RoleSource =
  /** The Live Client's own per-player `position` field (exact, both teams). */
  | 'live'
  /** Assigned position read from the LCU champ-select session (own team). */
  | 'champselect'
  /** Our scored guess from spells, champion tags and ranked history. */
  | 'inferred'

/** A player as first observed from Live Client Data (identity + champ), before
 *  Riot API enrichment. */
export interface LivePlayer {
  /** `gameName#tagLine` (Riot ID). May be missing for bots. */
  riotId: string
  gameName: string
  tagLine: string
  /** Champion name as the Live Client reports it, e.g. "Master Yi". */
  championName: string
  /** Data Dragon numeric champion id, resolved from championName. */
  championId?: number
  /** Data Dragon internal key, e.g. "MasterYi". This - not championName - is
   *  what the CDN icon URLs are built from. */
  championKey?: string
  team: TeamId
  /** Assigned lane as reported by the Live Client. UNKNOWN in modes/queues
   *  without assigned lanes (and on payloads that omit the field). */
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
  /** Aggregate KDA over the whole sample: (sum K + sum A) / max(1, sum D).
   *  A pooled ratio, NOT the mean of each game's individual KDA. */
  kdaRatio: number | null
  avgKills: number
  avgDeaths: number
  avgAssists: number
  /** Mean creep score per minute across the sample, or null with no sample. */
  avgCsPerMin: number | null
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
  /** True when league-v4 returned no entries at all. That usually means
   *  genuinely unranked, but it is also what a wrong-platform lookup returns,
   *  so the UI must not claim "Unranked" with confidence. */
  noRankData?: boolean
  /** Highest Solo/Duo rank ever observed for this player by this app (tracked
   *  locally over time - the Riot API exposes no all-time peak). */
  peakSoloRank?: RankEntry | null
  mastery?: MasteryInfo | null
  stats?: MatchDerivedStats | null
  /** Current role for this game. */
  currentRole?: Role
  /** Provenance of `currentRole`, so the UI can mark a guess as a guess. */
  roleSource?: RoleSource
  /** True when currentRole differs from the derived mainRole. */
  offRole?: boolean
  /** Premade group id within this player's team (players sharing a value are
   *  queued together). Undefined/solo when the player has no detected premade. */
  premadeGroup?: number
  /** Human label for the premade status, e.g. "Duo", "Trio", "Solo", or
   *  "Unknown" when we have no match history to compare. */
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
  /** Set when Riot answered 401/403 - almost always an expired dev key. */
  apiKeyRejected?: boolean
  updatedAt: number
}

export interface AppSettings {
  /** Whether a Riot API key has been stored (never send the key itself to UI). */
  hasApiKey: boolean
  region: RegionConfig
  /** Poll interval (ms) for Live Client Data while in game. */
  livePollMs: number
}

/** Allowed bounds for the Live Client poll interval, shared by UI and main. */
export const LIVE_POLL_MIN_MS = 1000
export const LIVE_POLL_MAX_MS = 30_000

export interface RegionConfig {
  /** Platform routing value, e.g. 'na1'. Used by league-v4 and mastery-v4. */
  platform: string
  /** Regional routing value for match-v5: 'americas' | 'europe' | 'asia' |
   *  'sea'. OCE, VN and TW live on 'sea'. */
  regional: string
  /** Regional routing value for account-v1, which does NOT serve 'sea'. Older
   *  stored settings omit this; `accountRoute()` fills it in. */
  account?: string
}

export interface RegionOption extends RegionConfig {
  label: string
  account: string
}

/**
 * Every platform we support, with the match-v5 and account-v1 routes kept
 * separate because they genuinely differ for the SEA cluster: match-v5 serves
 * 'sea' while account-v1 does not, so OCE/VN/TW must split the two.
 */
export const REGIONS: RegionOption[] = [
  { label: 'North America (NA)', platform: 'na1', regional: 'americas', account: 'americas' },
  { label: 'Brazil (BR)', platform: 'br1', regional: 'americas', account: 'americas' },
  { label: 'Latin America North (LAN)', platform: 'la1', regional: 'americas', account: 'americas' },
  { label: 'Latin America South (LAS)', platform: 'la2', regional: 'americas', account: 'americas' },
  { label: 'EU West (EUW)', platform: 'euw1', regional: 'europe', account: 'europe' },
  { label: 'EU Nordic & East (EUNE)', platform: 'eun1', regional: 'europe', account: 'europe' },
  { label: 'Turkey (TR)', platform: 'tr1', regional: 'europe', account: 'europe' },
  { label: 'Russia (RU)', platform: 'ru', regional: 'europe', account: 'europe' },
  { label: 'Middle East (ME)', platform: 'me1', regional: 'europe', account: 'europe' },
  { label: 'Korea (KR)', platform: 'kr', regional: 'asia', account: 'asia' },
  { label: 'Japan (JP)', platform: 'jp1', regional: 'asia', account: 'asia' },
  { label: 'Oceania (OCE)', platform: 'oc1', regional: 'sea', account: 'americas' },
  { label: 'Vietnam (VN)', platform: 'vn2', regional: 'sea', account: 'asia' },
  { label: 'Taiwan (TW)', platform: 'tw2', regional: 'sea', account: 'asia' },
  { label: 'Singapore (SG)', platform: 'sg2', regional: 'sea', account: 'asia' },
  { label: 'Philippines (PH)', platform: 'ph2', regional: 'sea', account: 'asia' },
  { label: 'Thailand (TH)', platform: 'th2', regional: 'sea', account: 'asia' }
]

/** Look up a stored region in the table (by platform), if we know it. */
export function findRegion(platform: string): RegionOption | undefined {
  return REGIONS.find((r) => r.platform === platform)
}

/**
 * account-v1 routing value for a region. Prefers an explicit `account`, then
 * the region table, then a safe remap of 'sea' (which account-v1 rejects).
 */
export function accountRoute(region: RegionConfig): string {
  if (region.account) return region.account
  const known = findRegion(region.platform)
  if (known) return known.account
  return region.regional === 'sea' ? 'asia' : region.regional
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
  setLivePollMs: 'settings:setLivePollMs',
  testApiKey: 'settings:testApiKey',
  clearPeakRanks: 'settings:clearPeakRanks',
  rescout: 'scout:rescout',
  // renderer -> main (send, fire-and-forget)
  resizeWindow: 'window:resizeToContent',
  // main -> renderer (send)
  snapshot: 'scout:snapshot',
  rateStatus: 'scout:rateStatus',
  log: 'scout:log'
} as const
