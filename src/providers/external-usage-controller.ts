import { fetchMiniMaxUsage } from './minimax-usage.js'
import { fetchCursorUsage } from './cursor/quota.js'
import { DEFAULT_CURSOR_API_KEY_REF } from './cursor/route.js'
import {
  fetchKimiCodeUsage,
  fetchOllamaUsage,
  fetchOpenCodeGoUsage,
} from './external-usage.js'
import {
  DEFAULT_OLLAMA_API_KEY_REF,
  DEFAULT_OLLAMA_BASE_URL,
} from './ollama.js'
import { credentialDigest, hasControlCharacters } from './credential-text.js'
import type { ProviderUsage } from './common.js'

/** Usage-only sources whose model routes are supplied by the DSH base install. */
export type ExternalUsageSource =
  | 'opencode-go'
  | 'kimi-code'
  | 'minimax'
  | 'minimax-cn'
  | 'ollama-cloud'
  | 'cursor'

export const EXTERNAL_USAGE_SOURCES: readonly ExternalUsageSource[] = [
  'opencode-go',
  'kimi-code',
  'minimax',
  'minimax-cn',
  'ollama-cloud',
  'cursor',
]

export interface ExternalUsageStatus {
  configured: boolean
}

type ResolveCredential = (
  name: string,
) => Promise<{ value: string } | undefined>

/**
 * A setting the controller reads per call. The function form keeps the Ollama
 * reference and base URL live: the Settings card can change them after the
 * controller was constructed.
 */
type LiveValue = string | (() => string)

function valueOf(value: LiveValue): string {
  return typeof value === 'function' ? value() : value
}

const DEFAULT_REFS: Record<ExternalUsageSource, string> = {
  'opencode-go': 'OPENCODE_GO_API_KEY',
  'kimi-code': 'KIMI_CODING_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  'ollama-cloud': DEFAULT_OLLAMA_API_KEY_REF,
  cursor: DEFAULT_CURSOR_API_KEY_REF,
}

/** Every fact one shared read needs; a reader is a plain function of these. */
export interface UsageReadInput {
  apiKey: string
  ollamaBaseURL: string
  /** Monthly ceiling in dollars, used only when Cursor reports spend without a limit. */
  ceilingUSD: number | undefined
  endpoint: string | undefined
  http: typeof fetch
  signal: AbortSignal | undefined
}

/** One source's usage reader, keyed into {@link READERS}. */
export type UsageReader = (input: UsageReadInput) => Promise<ProviderUsage>

/**
 * The reader of each source. Adding a source is this table plus the source id:
 * no branch inside the controller knows which provider it is calling.
 */
const READERS: Record<ExternalUsageSource, UsageReader> = {
  'opencode-go': ({ apiKey, http, signal }) =>
    fetchOpenCodeGoUsage(apiKey, http, signal),
  'kimi-code': ({ apiKey, http, signal }) =>
    fetchKimiCodeUsage(apiKey, http, signal),
  minimax: ({ apiKey, http, signal }) =>
    fetchMiniMaxUsage(apiKey, 'global', http, signal),
  'minimax-cn': ({ apiKey, http, signal }) =>
    fetchMiniMaxUsage(apiKey, 'cn', http, signal),
  'ollama-cloud': ({ apiKey, ollamaBaseURL, http, signal }) =>
    fetchOllamaUsage(apiKey, ollamaBaseURL, http, signal),
  cursor: ({ apiKey, http, signal, ceilingUSD, endpoint }) =>
    fetchCursorUsage(apiKey, {
      http,
      ...(signal === undefined ? {} : { signal }),
      ...(ceilingUSD === undefined ? {} : { ceilingUSD }),
      ...(endpoint === undefined ? {} : { endpoint }),
    }),
}

/** How long one successful read serves the card and every mounted composer. */
const CACHE_TTL_MS = 60_000

/** Bound one shared Cursor read; a hung connection becomes a stale reading. */
const READ_TIMEOUT_MS = 20_000

export class ExternalUsageController {
  private readonly refs: Record<ExternalUsageSource, LiveValue>
  private readonly ollamaBaseURL: LiveValue
  private readonly readers: Record<ExternalUsageSource, UsageReader>
  private readonly cache = new Map<
    string,
    { usage: ProviderUsage; observedAt: number; stale: boolean }
  >()
  private readonly inflight = new Map<string, Promise<ProviderUsage>>()
  private readonly generations = new Map<string, number>()
  /** The transport the readers get: every rejection becomes a fixed sentence. */
  private readonly guardedHttp: typeof fetch

  constructor(
    private readonly resolveCredential: ResolveCredential,
    private readonly http: typeof fetch = fetch,
    refs: Partial<Record<ExternalUsageSource, LiveValue>> = {},
    ollamaBaseURL: LiveValue = DEFAULT_OLLAMA_BASE_URL,
    private readonly cursor: {
      /** Monthly ceiling in dollars, used only when Cursor reports no limit. */
      ceilingUSD?: () => number | undefined
      endpoint?: () => string | undefined
    } = {},
    readers: Partial<Record<ExternalUsageSource, UsageReader>> = {},
    /**
     * Per-source gate for a credential the host will not spend right now (a key
     * kept off a card-chosen address). It is keyed by source, not by reference:
     * two sources may share a reference name without sharing a destination.
     */
    private readonly usable: Partial<
      Record<ExternalUsageSource, () => boolean>
    > = {},
  ) {
    this.refs = { ...DEFAULT_REFS, ...refs }
    this.readers = { ...READERS, ...readers }
    this.ollamaBaseURL = ollamaBaseURL
    // Readers build authorization headers from values this controller never
    // sees (a provider-issued token, for one). A transport failure can quote that
    // header, so both branches answer a fixed sentence and keep no raw error —
    // not even as a cause, which a log could print.
    this.guardedHttp = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const signal = init?.signal
      try {
        return await this.http(input, init)
      } catch {
        // The caller's signal decides cancellation; an exception merely named
        // like an abort is a transport failure.
        if (signal?.aborted === true)
          throw new Error('the usage read was cancelled')
        throw new Error('the usage endpoint could not be reached')
      }
    }) as typeof fetch
  }

  async status(): Promise<Record<ExternalUsageSource, ExternalUsageStatus>> {
    const values = await Promise.all(
      EXTERNAL_USAGE_SOURCES.map(async (source) => {
        if (this.usable[source]?.() === false) return false
        const value = await this.resolveCredential(valueOf(this.refs[source]))
        return typeof value?.value === 'string' && value.value.length > 0
      }),
    )
    return Object.fromEntries(
      EXTERNAL_USAGE_SOURCES.map((source, i) => [
        source,
        { configured: values[i] ?? false },
      ]),
    ) as Record<ExternalUsageSource, ExternalUsageStatus>
  }

  /** Drop the cached reading of one source, or all of them. */
  invalidate(source?: ExternalUsageSource): void {
    const keys = new Set([...this.cache.keys(), ...this.inflight.keys()])
    for (const key of keys) {
      if (source !== undefined && !key.startsWith(`${source}|`)) continue
      this.cache.delete(key)
      // Detach in-flight work too: a new read must not join the old result.
      this.inflight.delete(key)
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    }
  }

  async usage(
    source: ExternalUsageSource,
    signal?: AbortSignal,
    force = false,
  ): Promise<ProviderUsage> {
    // Snapshot the endpoint facts before the first await: a save that
    // switches the ref or host mid-flight must not send the old
    // reference's key to the new host.
    if (this.usable[source]?.() === false)
      throw new Error(`${source} API key is not configured`)
    const ref = valueOf(this.refs[source])
    const ollamaBase = valueOf(this.ollamaBaseURL)
    const ceiling = this.cursor.ceilingUSD?.()
    const endpoint = this.cursor.endpoint?.()
    const credential = await this.resolveCredential(ref)
    if (credential?.value === undefined || credential.value.length === 0) {
      throw new Error(`${source} API key is not configured`)
    }
    // A value predating the card can carry a control character; building the
    // header with it would put it in the transport's error, so it is refused
    // here for every reader.
    if (hasControlCharacters(credential.value)) {
      throw new Error(
        `the ${source} API key cannot be sent: it carries control characters`,
      )
    }
    const read = (signal?: AbortSignal) =>
      this.read(source, credential.value, ollamaBase, ceiling, endpoint, signal)
    // Only Cursor keeps a shared reading: the others are read per call as
    // before, so their own cards keep their refresh behavior.
    if (source !== 'cursor') {
      return this.read(
        source,
        credential.value,
        ollamaBase,
        ceiling,
        endpoint,
        signal,
      )
    }
    if (signal?.aborted) throw new Error('cursor usage read cancelled')
    // The cache belongs to one credential, host, and ceiling: a change to any
    // of them must read again rather than serve the previous account's data.
    const key = [
      source,
      ref,
      credentialDigest(credential.value),
      ollamaBase,
      ceiling ?? '',
      endpoint ?? '',
    ].join('|')
    if (!force) {
      const cached = this.cache.get(key)
      if (cached && Date.now() - cached.observedAt < CACHE_TTL_MS) {
        return this.snapshot(cached)
      }
    }
    // A forced read still joins one already in flight instead of racing it.
    const pending = this.inflight.get(key)
    if (pending) {
      return signal === undefined ? pending : this.untilAborted(pending, signal)
    }
    const generation = this.generations.get(key) ?? 0
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), READ_TIMEOUT_MS)
    const task = read(timeout.signal).then(
      (usage) => {
        // An invalidation that landed while this read was in flight wins: the
        // result goes to this caller but is not published.
        const observedAt = usage.observedAt ?? Date.now()
        if ((this.generations.get(key) ?? 0) === generation) {
          this.cache.set(key, { usage, observedAt, stale: false })
        }
        // Live and cached callers see the same timestamped snapshot.
        return { ...usage, observedAt }
      },
      (error: unknown) => {
        // A detached read's failure belongs to its caller, not to the
        // replacement that already published a fresh snapshot.
        if ((this.generations.get(key) ?? 0) !== generation) throw error
        // A failed refresh marks the shared reading stale, so every later
        // reader sees that too; the last good numbers survive.
        const cached = this.cache.get(key)
        if (cached) {
          cached.stale = true
          return this.snapshot(cached)
        }
        throw error
      },
    )
    task
      .finally(() => {
        clearTimeout(timer)
        // Only this task may remove its own entry: an invalidated read must
        // not detach the read that replaced it.
        if (this.inflight.get(key) === task) this.inflight.delete(key)
      })
      .catch(() => {})
    this.inflight.set(key, task)
    if (signal === undefined) return task
    // A caller that goes away stops waiting; the shared read still completes
    // for the cache and the next caller.
    task.catch(() => {})
    return this.untilAborted(task, signal)
  }

  /** Wait for a shared read, but let one caller's cancellation stop its wait. */
  private async untilAborted<T>(
    task: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) throw new Error('usage read cancelled')
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error('usage read cancelled'))
      signal.addEventListener('abort', onAbort, { once: true })
      task.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  /** One cached reading, with its freshness fields made explicit. */
  private snapshot(entry: {
    usage: ProviderUsage
    observedAt: number
    stale: boolean
  }): ProviderUsage {
    return {
      ...entry.usage,
      observedAt: entry.observedAt,
      ...(entry.stale ? { stale: true } : {}),
    }
  }

  private async read(
    source: ExternalUsageSource,
    apiKey: string,
    ollamaBase: string,
    ceiling: number | undefined,
    endpoint: string | undefined,
    signal?: AbortSignal,
  ): Promise<ProviderUsage> {
    return await this.readers[source]({
      apiKey,
      ollamaBaseURL: ollamaBase,
      ceilingUSD: ceiling,
      endpoint,
      http: this.guardedHttp,
      signal,
    })
  }
}
