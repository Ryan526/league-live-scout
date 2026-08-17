// Data Dragon helper: resolves champion identity (numeric id <-> internal name
// <-> display name) and champion tags, used to map Live Client `championName`
// to the numeric `championId` needed by champion-mastery-v4, and to make a
// best-effort role guess for enemies. Cached per patch.

export interface ChampionRecord {
  /** Numeric key used by the game APIs, e.g. 266. */
  id: number
  /** Internal id, e.g. "Aatrox". This is what Live Client returns as championName. */
  key: string
  /** Display name, e.g. "Aatrox". */
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

export class DataDragon {
  private byNumericId = new Map<number, ChampionRecord>()
  private byInternalKey = new Map<string, ChampionRecord>()
  private byDisplayName = new Map<string, ChampionRecord>()
  private patch = ''
  private loadingPromise: Promise<void> | null = null

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  get currentPatch(): string {
    return this.patch
  }

  /** Ensure champion data for the latest patch is loaded (idempotent). */
  async ensureLoaded(): Promise<void> {
    if (this.byNumericId.size > 0) return
    if (!this.loadingPromise) this.loadingPromise = this.loadLatest()
    try {
      await this.loadingPromise
    } finally {
      this.loadingPromise = null
    }
  }

  private async loadLatest(): Promise<void> {
    const versions = (await (await this.fetchImpl(VERSIONS_URL)).json()) as string[]
    const patch = versions[0]
    const url = `https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`
    const json = (await (await this.fetchImpl(url)).json()) as DDragonChampionJson
    this.ingest(json)
    this.patch = patch
  }

  /** Populate lookup maps from a champion.json payload (also used by tests). */
  ingest(json: DDragonChampionJson): void {
    this.byNumericId.clear()
    this.byInternalKey.clear()
    this.byDisplayName.clear()
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
    }
    if (json.version) this.patch = json.version
  }

  /** Live Client `championName` is the internal key (e.g. "Aatrox"), but be
   *  lenient and accept the display name too. */
  resolve(championName: string): ChampionRecord | undefined {
    if (!championName) return undefined
    const k = championName.toLowerCase()
    return (
      this.byInternalKey.get(k) ??
      this.byDisplayName.get(k) ??
      // Handle names with spaces/punctuation, e.g. "Miss Fortune".
      this.byDisplayName.get(k.replace(/[^a-z0-9]/g, '')) ??
      [...this.byInternalKey.values()].find(
        (r) => r.name.toLowerCase().replace(/[^a-z0-9]/g, '') === k.replace(/[^a-z0-9]/g, '')
      )
    )
  }

  byId(championId: number): ChampionRecord | undefined {
    return this.byNumericId.get(championId)
  }
}
