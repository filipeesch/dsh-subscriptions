import { fetchMiniMaxUsage } from './minimax-usage.js'
import { fetchCursorUsage } from './cursor/quota.js'
import {
  fetchKimiCodeUsage,
  fetchOllamaUsage,
  fetchOpenCodeGoUsage,
} from './external-usage.js'
import {
  DEFAULT_OLLAMA_API_KEY_REF,
  DEFAULT_OLLAMA_BASE_URL,
} from './ollama.js'
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
  cursor: 'CURSOR_API_KEY',
}

/** How long one successful read serves the card and every mounted composer. */
const CACHE_TTL_MS = 60_000

/** Non-reversible short identity of a credential value, for cache keys only. */
function fingerprintOf(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

export class ExternalUsageController {
  private readonly refs: Record<ExternalUsageSource, LiveValue>
  private readonly ollamaBaseURL: LiveValue
  private readonly cache = new Map<
    string,
    { usage: ProviderUsage; observedAt: number }
  >()
  private readonly inflight = new Map<string, Promise<ProviderUsage>>()

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
  ) {
    this.refs = { ...DEFAULT_REFS, ...refs }
    this.ollamaBaseURL = ollamaBaseURL
  }

  async status(): Promise<Record<ExternalUsageSource, ExternalUsageStatus>> {
    const values = await Promise.all(
      EXTERNAL_USAGE_SOURCES.map(async (source) => {
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
    if (source === undefined) {
      this.cache.clear()
      return
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${source}|`)) this.cache.delete(key)
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
    const ref = valueOf(this.refs[source])
    const ollamaBase = valueOf(this.ollamaBaseURL)
    const ceiling = this.cursor.ceilingUSD?.()
    const endpoint = this.cursor.endpoint?.()
    const credential = await this.resolveCredential(ref)
    if (credential?.value === undefined || credential.value.length === 0) {
      throw new Error(`${source} API key is not configured`)
    }
    // The cache belongs to one credential, host, and ceiling: a change to any
    // of them must read again rather than serve the previous account's data.
    const key = [
      source,
      ref,
      fingerprintOf(credential.value),
      ollamaBase,
      ceiling ?? '',
      endpoint ?? '',
    ].join('|')
    if (!force) {
      const cached = this.cache.get(key)
      if (cached && Date.now() - cached.observedAt < CACHE_TTL_MS) {
        return cached.usage
      }
      const pending = this.inflight.get(key)
      if (pending) return pending
    }
    const task = this.read(
      source,
      credential.value,
      ollamaBase,
      ceiling,
      endpoint,
      signal,
    ).then(
      (usage) => {
        // The response keeps the provider's own shape; the observation time
        // is cached for the stale fallback and for later reads.
        this.cache.set(key, {
          usage,
          observedAt: usage.observedAt ?? Date.now(),
        })
        return usage
      },
      (error: unknown) => {
        // A failed refresh must not erase a good reading; it goes stale.
        const cached = this.cache.get(key)
        if (cached) {
          return {
            ...cached.usage,
            stale: true,
            observedAt: cached.observedAt,
          }
        }
        throw error
      },
    )
    task.finally(() => this.inflight.delete(key)).catch(() => {})
    this.inflight.set(key, task)
    return task
  }

  private async read(
    source: ExternalUsageSource,
    apiKey: string,
    ollamaBase: string,
    ceiling: number | undefined,
    endpoint: string | undefined,
    signal?: AbortSignal,
  ): Promise<ProviderUsage> {
    if (source === 'minimax' || source === 'minimax-cn')
      return fetchMiniMaxUsage(
        apiKey,
        source === 'minimax-cn' ? 'cn' : 'global',
        this.http,
        signal,
      )
    if (source === 'ollama-cloud')
      return fetchOllamaUsage(apiKey, ollamaBase, this.http, signal)
    if (source === 'cursor') {
      return fetchCursorUsage(apiKey, {
        http: this.http,
        ...(signal === undefined ? {} : { signal }),
        ...(ceiling === undefined ? {} : { ceilingUSD: ceiling }),
        ...(endpoint === undefined ? {} : { endpoint }),
      })
    }
    return source === 'opencode-go'
      ? fetchOpenCodeGoUsage(apiKey, this.http, signal)
      : fetchKimiCodeUsage(apiKey, this.http, signal)
  }
}
