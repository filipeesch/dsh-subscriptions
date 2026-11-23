/**
 * Published model capacities from the public models.dev catalog.
 *
 * Cursor lists some models without a context tier, so the catalog alone cannot
 * tell the host how large their window is. The public catalog describes it, but
 * the document is large and third-party, so it is fetched out of band on a
 * 24-hour window and projected down to the ids the route currently lists; the
 * request path only reads the snapshot, exactly like the model catalog.
 */

import { hostFetch } from '../../http.js'
import type { FetchFn } from '../common.js'

/** The public catalog this source reads. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/**
 * The projection's own version, so a snapshot written under another rule is
 * discarded instead of trusted for a day. Bump it whenever {@link projectWindows}
 * changes what it would produce.
 */
export const SNAPSHOT_VERSION = 2

const DEFAULT_FRESH_MS = 24 * 60 * 60_000
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

/** The persisted projection: published capacities keyed by provider model id. */
export interface PublishedContextSnapshot {
  version: number
  fetchedAt: number
  windows: Record<string, number>
  /**
   * The catalog ids the projection was computed for. Recording them lets a
   * newly listed id trigger a refresh instead of waiting out the day, and keeps
   * an id with no published capacity from refreshing on every note.
   */
  ids?: string[]
}

/** One model as the public catalog lists it. */
export interface PublishedModel {
  provider: string
  id: string
  name?: string
  context?: number
}

/** What one refresh did; a request path never sees this. */
export type PublishedRefreshOutcome =
  | { status: 'refreshed'; fetchedAt: number; windows: number }
  | { status: 'failed'; reason: string; fetchedAt?: number }
  | { status: 'unavailable'; reason: 'disabled' | 'no-models' }

/** Comparison key: case, spaces, and punctuation do not distinguish two spellings of one model. */
export function normalizeModelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The last path segment of a catalog id, which is the model's own name in the vendored form. */
export function lastSegment(id: string): string {
  const separator = id.lastIndexOf('/')
  return separator < 0 ? id : id.slice(separator + 1)
}

/** Model id prefix to the vendor that publishes it; used to prefer a vendor's own entry. */
const VENDORS: readonly (readonly [string, string])[] = [
  ['claude', 'anthropic'],
  ['gpt', 'openai'],
  ['gemini', 'google'],
  ['grok', 'xai'],
  ['kimi', 'moonshot'],
  ['glm', 'zai'],
  ['deepseek', 'deepseek'],
  ['muse', 'meta'],
]

/**
 * Provider identities that publish a vendor's models. Matching is exact after
 * punctuation removal: a gateway whose name merely contains a vendor's name is
 * not that vendor and must not speak for it.
 */
const VENDOR_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['anthropic'],
  openai: ['openai', 'azure', 'azure-openai'],
  google: ['google', 'google-vertex', 'google-ai-studio', 'vertex'],
  xai: ['xai', 'x-ai'],
  moonshot: ['moonshot', 'moonshotai', 'moonshot-ai'],
  zai: ['zai', 'z-ai', 'zhipu', 'zhipuai'],
  deepseek: ['deepseek'],
  meta: ['meta', 'meta-llama', 'llama'],
}

/** The vendor a Cursor model id belongs to, when its name says so. */
export function vendorOf(modelId: string): string | undefined {
  const key = normalizeModelKey(modelId)
  for (const [prefix, vendor] of VENDORS) {
    if (key.startsWith(prefix)) return vendor
  }
  return undefined
}

/**
 * Read the models the public catalog describes, keeping only entries that
 * publish a capacity. Malformed documents read as empty rather than throwing.
 */
export function publishedEntries(document: unknown): PublishedModel[] {
  if (!document || typeof document !== 'object' || Array.isArray(document))
    return []
  const out: PublishedModel[] = []
  for (const [provider, value] of Object.entries(
    document as Record<string, unknown>,
  )) {
    const models = (value as { models?: unknown } | undefined)?.models
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue
    for (const [key, model] of Object.entries(
      models as Record<string, unknown>,
    )) {
      const entry = (model ?? {}) as {
        id?: unknown
        name?: unknown
        limit?: { context?: unknown }
      }
      const id =
        typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : key
      const name =
        typeof entry.name === 'string' && entry.name.length > 0
          ? entry.name
          : undefined
      const context = entry.limit?.context
      if (
        typeof context !== 'number' ||
        !Number.isFinite(context) ||
        context <= 0
      )
        continue
      out.push({
        provider,
        id,
        ...(name === undefined ? {} : { name }),
        context: Math.round(context),
      })
    }
  }
  return out
}

/**
 * Whether a document has the shape this projection understands: a non-empty
 * object of provider objects, each carrying a models object.
 *
 * Whether one entry declares a capacity is the projection's business, not the
 * document's. The endpoint lists image, speech, and transcription models with
 * `limit.context: 0`; judging those here would make one such entry hide every
 * readable one. `publishedEntries` skips an entry it cannot read, and a
 * structurally valid catalog may still match no listed id, which is different
 * from a malformed response and must not be confused with one.
 */
export function hasPublishedCatalogShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const providers = Object.values(value as Record<string, unknown>)
  if (providers.length === 0) return false
  return providers.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return false
    const models = (entry as { models?: unknown }).models
    return (
      models !== null && typeof models === 'object' && !Array.isArray(models)
    )
  })
}

/** Whether one published entry belongs to the model's own vendor. */
function ownVendor(entry: PublishedModel, vendor: string): boolean {
  const key = normalizeModelKey(entry.provider)
  return (VENDOR_PROVIDERS[vendor] ?? [vendor]).some(
    (name) => normalizeModelKey(name) === key,
  )
}

/** The capacity most candidates declare, preferring the larger one on a tie. */
export function mostDeclared(values: readonly number[]): number | undefined {
  const counts = new Map<number, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: number | undefined
  let bestCount = 0
  for (const [value, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && (best === undefined || value > best))
    ) {
      best = value
      bestCount = count
    }
  }
  return best
}

/**
 * Project the published catalog onto the ids the provider lists.
 *
 * A candidate matches when its own id segment or display name equals the
 * provider id, ignoring case and punctuation. When candidates disagree, entries
 * published by the model's own vendor provider win; the value is then the
 * capacity most candidates declare, so a single gateway's reduced variant does
 * not become the model's window.
 * @param ids - model ids the provider currently lists.
 * @param entries - published catalog entries.
 * @returns capacity in tokens per provider model id.
 */
export function projectWindows(
  ids: readonly string[],
  entries: readonly PublishedModel[],
): Record<string, number> {
  const windows: Record<string, number> = {}
  for (const id of ids) {
    const key = normalizeModelKey(id)
    if (!key) continue
    const matches = entries.filter(
      (entry) =>
        normalizeModelKey(lastSegment(entry.id)) === key ||
        (entry.name !== undefined && normalizeModelKey(entry.name) === key),
    )
    if (matches.length === 0) continue
    const vendor = vendorOf(id)
    const preferred =
      vendor === undefined
        ? []
        : matches.filter((entry) => ownVendor(entry, vendor))
    const pool = preferred.length > 0 ? preferred : matches
    const value = mostDeclared(pool.map((entry) => entry.context as number))
    if (value !== undefined) windows[id] = value
  }
  return windows
}

/** What the source reads and how it refreshes. */
export interface PublishedContextDeps {
  /** Whether the source may fetch and serve a published capacity. */
  enabled: () => boolean
  /** Fetch implementation; defaults to the host's, which honors its proxy. */
  fetch?: FetchFn
  /** Persist a fresh projection; a failed save only costs durability. */
  persist?: (snapshot: PublishedContextSnapshot) => void
  /** Diagnostics sink for a failed fetch. */
  onWarn?: (message: string) => void
  /** Snapshot lifetime; overridden by tests. */
  freshMs?: number
  /** Fetch timeout; overridden by tests. */
  timeoutMs?: number
  /** Response cap; overridden by tests. */
  maxBytes?: number
  /** Clock; overridden by tests. */
  now?: () => number
}

/** Read at most the response cap, so a broken endpoint cannot exhaust memory. */
async function fetchPublishedCatalog(
  fetchImpl: FetchFn,
  timeoutMs: number,
  maxBytes: number,
): Promise<unknown> {
  const response = await fetchImpl(MODELS_DEV_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error('models.dev answered ' + response.status)
  const body = response.body
  if (!body) throw new Error('models.dev answered no body')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('models.dev response exceeded the size cap')
    }
    chunks.push(value)
  }
  return JSON.parse(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'),
  )
}

/** The published capacities the request path reads without blocking. */
export class PublishedContext {
  private readonly deps: PublishedContextDeps
  private snapshot: PublishedContextSnapshot | undefined
  private loading: Promise<PublishedRefreshOutcome> | undefined
  /** The ids the current catalog lists; only these are served. */
  private latestIds: readonly string[] = []
  private latestIdSet: ReadonlySet<string> = new Set()
  /** The ids the stored projection was computed for. */
  private projectedIds: ReadonlySet<string> = new Set()
  /** Whether a live refresh already replaced the startup seed. */
  private liveRefreshed = false

  constructor(deps: PublishedContextDeps) {
    this.deps = deps
  }

  /**
   * Adopt a persisted snapshot; a version mismatch or malformed input is
   * ignored, and a live refresh that already landed wins over a late disk read.
   */
  load(snapshot: PublishedContextSnapshot | undefined): void {
    if (this.liveRefreshed) return
    if (snapshot === undefined || snapshot.version !== SNAPSHOT_VERSION) return
    const windows: Record<string, number> = {}
    for (const [id, tokens] of Object.entries(snapshot.windows ?? {})) {
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
        windows[id] = Math.round(tokens)
      }
    }
    const ids = (snapshot.ids ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    this.snapshot = {
      version: SNAPSHOT_VERSION,
      fetchedAt: Number.isFinite(snapshot.fetchedAt) ? snapshot.fetchedAt : 0,
      windows,
      ids,
    }
    // An older snapshot without ids cannot tell which ids were considered, so
    // treat only its windows as projected.
    this.projectedIds = new Set(ids.length > 0 ? ids : Object.keys(windows))
  }

  /**
   * Published capacity for one model, when the source is enabled and the
   * current catalog still lists it. A disabled source serves nothing, so every
   * consumer falls back to the manual value or the documented default.
   */
  windowFor(modelId: string): number | undefined {
    if (!this.deps.enabled()) return undefined
    if (!this.latestIdSet.has(modelId)) return undefined
    return this.snapshot?.windows[modelId]
  }

  /** When the projection was last refreshed, for display. */
  fetchedAt(): number | undefined {
    return this.snapshot?.fetchedAt
  }

  /** Whether the snapshot is older than the freshness window. */
  stale(): boolean {
    const snapshot = this.snapshot
    if (snapshot === undefined) return true
    return (
      this.now() - snapshot.fetchedAt >= (this.deps.freshMs ?? DEFAULT_FRESH_MS)
    )
  }

  /**
   * Record the ids the current catalog lists and refresh out of band when the
   * snapshot is stale or does not cover a newly listed id. Recording happens
   * even when the source is disabled or the snapshot is fresh, so a withdrawn
   * id stops being served immediately.
   */
  note(ids: readonly string[]): void {
    this.rememberIds(ids)
    if (!this.deps.enabled() || this.latestIds.length === 0) return
    const uncovered = this.latestIds.some((id) => !this.projectedIds.has(id))
    if (uncovered || this.stale()) void this.refresh(this.latestIds)
  }

  /**
   * Refresh now and report what happened. A disabled source, an empty id list,
   * and a refresh in flight resolve with that outcome instead of fetching again.
   * The refresh reads the newest id set after the fetch, so a catalog change
   * during the request is projected.
   * @param ids - model ids the current catalog lists.
   * @returns success with the snapshot time, a failure that kept the previous
   *   projection, or an unavailable source.
   */
  refresh(ids: readonly string[]): Promise<PublishedRefreshOutcome> {
    this.rememberIds(ids)
    if (!this.deps.enabled()) {
      return Promise.resolve({ status: 'unavailable', reason: 'disabled' })
    }
    if (this.latestIds.length === 0) {
      return Promise.resolve({ status: 'unavailable', reason: 'no-models' })
    }
    if (this.loading !== undefined) return this.loading
    this.loading = this.run().finally(() => {
      this.loading = undefined
    })
    return this.loading
  }

  private rememberIds(ids: readonly string[]): void {
    this.latestIds = [...new Set(ids)]
    this.latestIdSet = new Set(this.latestIds)
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private async run(): Promise<PublishedRefreshOutcome> {
    try {
      const document = await fetchPublishedCatalog(
        this.deps.fetch ?? hostFetch,
        this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        this.deps.maxBytes ?? DEFAULT_MAX_BYTES,
      )
      if (!hasPublishedCatalogShape(document)) {
        throw new Error(
          'models.dev returned a document this projection cannot read',
        )
      }
      const ids = [...this.latestIds]
      const windows = projectWindows(ids, publishedEntries(document))
      const snapshot: PublishedContextSnapshot = {
        version: SNAPSHOT_VERSION,
        fetchedAt: this.now(),
        windows,
        ids,
      }
      this.snapshot = snapshot
      this.projectedIds = new Set(ids)
      this.liveRefreshed = true
      this.deps.persist?.(snapshot)
      return {
        status: 'refreshed',
        fetchedAt: snapshot.fetchedAt,
        windows: Object.keys(windows).length,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.onWarn?.('published capacities fetch failed: ' + reason)
      const fetchedAt = this.fetchedAt()
      return {
        status: 'failed',
        reason,
        ...(fetchedAt === undefined ? {} : { fetchedAt }),
      }
    }
  }
}
