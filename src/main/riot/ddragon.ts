// Data Dragon helper: resolves champion identity (numeric id <-> internal name
// <-> display name) and champion tags, used to map Live Client `championName`
// to the numeric `championId` needed by champion-mastery-v4, to build champion
// portrait URLs, and to make a best-effort role guess for enemies.

export interface ChampionRecord {
  /** Numeric key used by the game APIs, e.g. 266. */
  id: number
  /** Internal id, e.g. "MasterYi". This is what the CDN file names use. */
  key: string
  /** Display name, e.g. "Master Yi". This is what Live Client reports. */
  name: string
  /** Data Dragon tags, e.g. ["Fighter","Tank"]. */
  tags: string[]
}

interface DDragonChampionJson {
  version: string
  data: Record<
    string,
    { key: string; id: string; name: string; tags: string[] }
  >
}

const VERSIONS_URL = 'https://ddragon.leagueoflegends.com/api/versions.json'
const FETCH_TIMEOUT_MS = 10_000
/** How often a long-running instance re-checks for a new patch. */
const STALENESS_INTERVAL_MS = 60 * 60_000
/** Much shorter retry while we have no champion data at all. */
const EMPTY_RETRY_INTERVAL_MS = 60_000

/** Strip everything but letters and digits: "Kai'Sa" -> "kaisa". */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export class DataDragon {
  private byNumericId = new Map<number, ChampionRecord>()
  private byInternalKey = new Map<string, ChampionRecord>()
  private byDisplayName = new Map<string, ChampionRecord>()
  /** Punctuation/space-stripped lookups for both the key and the display name,
   *  so "Miss Fortune", "MissFortune" and "missfortune" all hit a map. */
  private byNormalizedName = new Map<string, ChampionRecord>()
  private patch = ''
  private loadingPromise: Promise<void> | null = null
  private lastCheckedAt = 0

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  get currentPatch(): string {
    return this.patch
  }

  /** Ensure champion data for the latest patch is loaded (idempotent). */
  async ensureLoaded(): Promise<void> {
    if (this.byNumericId.size > 0) return
    await this.load()
  }

  /**
   * Re-check for a newer patch, rate-limited so it can be called freely. Without
   * this a long-running instance pins the patch it started on forever: newly
   * released champions never resolve (so mastery is permanently skipped for
   * them) and every portrait URL points at a stale CDN directory. When we have
   * no data at all — a failed load at startup — it retries much sooner.
   */
  async refreshIfStale(): Promise<void> {
    const interval =
      this.byNumericId.size === 0 ? EMPTY_RETRY_INTERVAL_MS : STALENESS_INTERVAL_MS
    if (Date.now() - this.lastCheckedAt < interval) return
    await this.load()
  }

  private async load(): Promise<void> {
    if (!this.loadingPromise) {
      this.loadingPromise = this.loadLatest().finally(() => {
        this.loadingPromise = null
      })
    }
    await this.loadingPromise
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`Data Dragon ${res.status} for ${url}`)
    return (await res.json()) as T
  }

  private async loadLatest(): Promise<void> {
    this.lastCheckedAt = Date.now()
    const versions = await this.fetchJson<string[]>(VERSIONS_URL)
    const patch = Array.isArray(versions) ? versions[0] : undefined
    if (!patch || typeof patch !== 'string') {
      throw new Error('Data Dragon returned no versions')
    }
    if (patch === this.patch && this.byNumericId.size > 0) return // already current
    const url = `https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`
    const json = await this.fetchJson<DDragonChampionJson>(url)
    this.ingest(json)
    this.patch = patch
  }

  /** Populate lookup maps from a champion.json payload (also used by tests). */
  ingest(json: DDragonChampionJson): void {
    this.byNumericId.clear()
    this.byInternalKey.clear()
    this.byDisplayName.clear()
    this.byNormalizedName.clear()
    for (const entry of Object.values(json.data)) {
      const rec: ChampionRecord = {
        id: Number(entry.key),
        key: entry.id,
        name: entry.name,
        tags: entry.tags ?? []
      }
      this.byNumericId.set(rec.id, rec)
      this.byInternalKey.set(rec.key.toLowerCase(), rec)
      this.byDisplayName.set(rec.name.toLowerCase(), rec)
      // Display name wins on collision: it is what the Live Client sends.
      this.byNormalizedName.set(normalizeName(rec.key), rec)
      this.byNormalizedName.set(normalizeName(rec.name), rec)
    }
    if (json.version) this.patch = json.version
  }

  /** Live Client `championName` is the display name (e.g. "Master Yi"), but be
   *  lenient and accept the internal key too. */
  resolve(championName: string): ChampionRecord | undefined {
    if (!championName) return undefined
    const k = championName.toLowerCase()
    return (
      this.byInternalKey.get(k) ??
      this.byDisplayName.get(k) ??
      this.byNormalizedName.get(normalizeName(championName))
    )
  }

  byId(championId: number): ChampionRecord | undefined {
    return this.byNumericId.get(championId)
  }
}
