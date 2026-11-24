/**
 * The wire contract of the `subscriptions-auth` channel: what each endpoint
 * answers and which controllers back it. Types only — the handlers live in
 * `src/rpc/endpoints/` and the transport in `src/rpc/transport.ts`.
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ProviderUsage } from '../providers/common.js'
import type {
  ExternalUsageSource,
  ExternalUsageStatus,
} from '../providers/external-usage-controller.js'
import type {
  KeyCredentialResult,
  KeyCredentialView,
  KeyRouteId,
  KeyValidationResult,
} from '../providers/key-credentials.js'
import type { ProviderId } from '../auth/store.js'
import type { CliVersion } from '../providers/npm-cli-version.js'

/** Decoded image bytes returned by the `image` endpoint. */
export interface ImageBytesResult {
  mediaType: string
  dataBase64: string
}

/** Decoded video bytes returned by the `video` endpoint. */
export interface VideoBytesResult {
  mediaType: string
  dataBase64: string
}

/** One session's speed choice: standard routing or the fast (priority) tier. */
export type SpeedTier = 'standard' | 'fast'

/** `speed` endpoint value: the session's choice plus the visibility list. */
export interface SpeedState {
  /** Explicit session speed, or the subagent's model default when supplied. */
  tier: SpeedTier
  /** Codex model ids whose catalog advertises a fast tier. */
  fastModels: string[]
}

/** Session overrides plus persisted subagent model defaults. */
export interface SpeedController {
  /** Pass the current Codex model to resolve a subagent's default speed. */
  speed(sessionId: string, model?: string): Promise<SpeedState>
  /** Set the session override and persist it for this model when supplied. */
  setSpeed(sessionId: string, tier: SpeedTier, model?: string): Promise<void>
}

/** One logged-in account, as rendered by the Settings page. */
export interface AccountStatus {
  /** Stable account key (store identity). */
  key: string
  /** Display identity (email / login), when known. */
  account?: string
  /** Epoch milliseconds at which the stored access token expires. */
  expiresAt?: number
  /** Plan name the session carries (codex planType / claude subscriptionType), when known. */
  plan?: string
  /** Whether direct (non-pool) routes serve this account. */
  isDefault: boolean
}

/** Login state of one provider, as rendered by the Settings page. */
export interface ProviderStatus {
  /** Saved picker visibility, attached by the status RPC from local preferences. */
  visibleModels?: string[]
  /** Whether a login attempt is currently waiting for its code. */
  busy: boolean
  /** Logged-in accounts, default first. */
  accounts: AccountStatus[]
  /** The last login error, shown until the next success. */
  detail?: string
  /** The CLI version this route presents (Codex, Claude), and where it came from. */
  clientVersion?: CliVersion
}

/** How a Claude login should acquire credentials (other providers ignore it). */
export type LoginMethod = 'oauth' | 'keychain'

/** One model's default-effort picker state, as rendered by the Settings page. */
export interface ModelDefaultView {
  /** Wire model id. */
  id: string
  /** Human-readable display name. */
  name: string
  /** Advertised effort levels, in catalog order (empty when the model has no reasoning). */
  efforts: { id: string; name: string }[]
  /** The user-configured default effort, when set. */
  configured?: string
}

/** One provider's default-effort picker state. */
export interface ModelDefaultsCatalog {
  /** The subscription provider route. */
  provider: ProviderId
  /** Models the picker can configure, in catalog order. */
  models: ModelDefaultView[]
}

/** Per-account catalog returned by providerSettings, including providers without usage APIs. */
export interface ProviderAccountCatalog {
  key: string
  /** Original identity; the editable alias lives in settings.accounts[key].alias. */
  label: string
  models: { id: string; name: string }[]
  unavailable?: boolean
}

/** Provider and account preference operations behind providerSettings/setProviderSettings. */
export interface ProviderSettingsController {
  /** Local picker selection, without triggering model discovery. */
  visibleModels?(provider: ProviderId): string[] | undefined
  get(provider: ProviderId, force: boolean): Promise<unknown>
  set(provider: ProviderId, settings: unknown): Promise<void>
}

export interface ModelDefaultsController {
  /** Per-provider picker state for the Settings page. */
  catalog(force?: boolean): Promise<ModelDefaultsCatalog[]>
  /** Set one model's configured default effort; undefined clears the override. */
  set(
    provider: ProviderId,
    model: string,
    effort: string | undefined,
  ): Promise<void>
}

/** Provider-agnostic auth operations the RPC handler delegates to. */
export interface AuthController {
  prepareReset?(account: string, signal: AbortSignal): Promise<unknown>
  consumeReset?(
    account: string,
    ticket: string,
    signal: AbortSignal,
  ): Promise<void>
  /** Current status of one provider. */
  status(provider: ProviderId): Promise<ProviderStatus>
  /**
   * Start a background login attempt.
   * @param provider - the provider route.
   * @param method - Claude only: force the OAuth browser flow or the Claude
   *   Code credential import; omitted keeps the auto behavior (import when
   *   available, else OAuth).
   * @returns the authorize URL for the user's browser; device-flow providers
   *   (copilot) also return the `userCode` the user types at that URL.
   * @throws when an attempt is already running for this provider.
   */
  login(
    provider: ProviderId,
    method?: LoginMethod,
  ): Promise<{ authorizeUrl: string; userCode?: string }>
  /**
   * Feed a pasted callback URL or bare code into the pending attempt.
   * @throws when no attempt is pending or the input is unusable.
   */
  manual(provider: ProviderId, input: string): Promise<void>
  /** Abort the pending attempt; a no-op when none is pending. */
  cancel(provider: ProviderId): Promise<void>
  /** Delete one account's stored session. */
  logout(provider: ProviderId, account: string): Promise<void>
  /** Pin the account direct (non-pool) routes serve. */
  setDefault(provider: ProviderId, account: string): Promise<void>
  /**
   * Current subscription usage of one account.
   * @param signal - caller cancellation from the RPC transport.
   * @param force - bypass a fresh cached snapshot for an honest re-check
   *   (the manual Refresh button); a live failure cooldown still applies.
   * @returns `{ supported: false }` when the provider has no usage endpoint.
   * @throws when logged out or the usage lookup fails.
   */
  usage(
    provider: ProviderId,
    account: string,
    signal: AbortSignal,
    force?: boolean,
  ): Promise<ProviderUsage>
  /**
   * Read one image attachment's bytes for inline display.
   * @param ref - the full durable reference (`readImage` verifies against it).
   * @param signal - caller cancellation from the RPC transport.
   * @returns the media type and base64-encoded bytes.
   * @throws when no attachment service is mounted or the read fails.
   */
  readImage(
    ref: ImageAttachmentRef,
    signal: AbortSignal,
  ): Promise<ImageBytesResult>
  /**
   * Read one generated video's bytes for inline playback.
   * @param name - bare MP4 file name inside the plugin's videos directory
   *   (validated against the bare-name pattern; never a path).
   * @param signal - caller cancellation from the RPC transport.
   * @returns the media type and base64-encoded bytes.
   * @throws when the file does not exist or cannot be read.
   */
  readVideo(name: string, signal: AbortSignal): Promise<VideoBytesResult>
}

/** Credential-backed quota readers for model providers already in DSH. */
export interface ExternalUsageRpcController {
  status(): Promise<Record<ExternalUsageSource, ExternalUsageStatus>>
  usage(
    source: ExternalUsageSource,
    signal: AbortSignal,
    force?: boolean,
  ): Promise<ProviderUsage>
  /** Drop the cached reading of one source, or all of them. */
  invalidate(source?: ExternalUsageSource): void
}

/** One model in the Ollama Cloud picker catalog, with its capability flags. */
export interface OllamaModelView {
  id: string
  name: string
  /** The endpoint advertised the `vision` capability. */
  vision: boolean
  /** The endpoint advertised the `thinking` capability. */
  thinking: boolean
  contextWindow?: number
  /** Advertised reasoning levels, when the model reasons. */
  efforts?: { id: string; name: string }[]
  /** The level preselected for the model, when one is known. */
  defaultEffort?: string
}

/** One candidate returned by the cloud listing; adopting it stores `id`. */
export interface OllamaCloudCandidate {
  /** Normalized wire id, e.g. `glm-5.3:cloud`. */
  id: string
  /** The id exactly as the listing published it, e.g. `glm-5.3`. */
  rawId: string
  /** Display basename for the checkbox row. */
  name: string
  vision: boolean
  thinking: boolean
  contextWindow?: number
  efforts: string[]
  defaultEffort?: string
}

/**
 * What the Ollama card renders: the stored overrides, the effective values
 * after config/default fallback, and the catalog the picker serves.
 */
export interface OllamaSettingsView {
  provider: 'ollama-cloud'
  /** The stored document; absent fields mean "no override". */
  settings: unknown
  effective: { baseURL: string; apiKeyRef: string; web: boolean }
  /** The effective catalog, in picker order (empty hides the picker entry). */
  models: OllamaModelView[]
  /** A non-empty `config.ollama.models` wins over the store, so card edits are inert. */
  configOverridesModels: boolean
  /**
   * Whether a stored or environment key is spent at the effective address. It
   * is false when the card replaced the operator-configured base URL: the host
   * keeps the credential on that destination.
   */
  keyUsable: boolean
}

/** Ollama Cloud catalog and connection settings; the API key stays in DSH credentials. */
export interface OllamaRpcController {
  settings(): Promise<OllamaSettingsView>
  /** Validate and persist the store document, then re-announce the route. */
  setSettings(input: unknown): Promise<void>
  /**
   * List the endpoint's Cloud models for the adoption checklist.
   * @param input - an optional one-time API key and base URL override; the
   *   key is used for this listing only and never persisted.
   * @param signal - caller cancellation from the RPC transport.
   */
  models(
    input: { apiKey?: string; baseURL?: string },
    signal: AbortSignal,
  ): Promise<{ models: OllamaCloudCandidate[] }>
}

/** The published-capacity source state the card states. */
export interface CursorKnownContextView {
  enabled: boolean
  /** Epoch milliseconds of the last successful projection. */
  fetchedAt?: number
}

/** One manual refresh outcome, distinct from a successful no-op. */
export interface CursorRefreshView extends CursorKnownContextView {
  status: 'refreshed' | 'failed' | 'unavailable'
  /** Why the source could not refresh, for failed and unavailable outcomes. */
  reason?: string
  /** How many listed ids the fresh projection describes. */
  windows?: number
}

/** One Cursor card snapshot. */
export interface CursorSettingsView {
  provider: 'cursor'
  /** Credential reference that holds the API key. */
  keyRef: string
  /** Monthly ceiling in US dollars, when one is stored. */
  ceilingUSD?: number
  /** Models the route currently advertises; absent when the catalog failed. */
  models?: number
  /** Whether the published-capacity source may fetch. */
  publishedContext: boolean
  /** The source's state, for the card's status line. */
  knownContext: CursorKnownContextView
}

/** The model manager's payload. */
export interface CursorModelsView {
  provider: 'cursor'
  models: import('../providers/cursor/model-rows.js').CursorModelRow[]
  knownContext: CursorKnownContextView
  /**
   * The stored per-model settings. A change writes the whole map, so the page
   * holds it: sending only the edited entry would drop every other model's
   * setting, including the ones the catalog no longer lists.
   */
  storedModels: Record<string, { enabled?: boolean; contextWindow?: number }>
}

/** Cursor route settings the card reads and writes. */
export interface CursorRpcController {
  /** Stored settings plus the live state; refresh may read the catalog. */
  settings(refresh?: boolean): Promise<CursorSettingsView>
  /** Save the monthly ceiling; `undefined` clears it. */
  setCeiling(ceilingUSD: number | undefined): Promise<void>
  /** The model manager's rows, resolved the same way a request resolves them. */
  models(refresh?: boolean): Promise<CursorModelsView>
  /** Replace the stored settings document, keeping the rest of the route state. */
  setSettings(settings: unknown): Promise<void>
  /** Refresh the published capacities now and report what happened. */
  refreshContext(): Promise<CursorRefreshView>
}

/**
 * The credential of one key-based route, as the card renders it: presence, the
 * layer supplying it, and the host's masked preview when it reports one. The
 * value itself never crosses this seam.
 */
export interface KeyCredentialRpcController {
  /** The route's current state; no credential value crosses this seam. */
  describe(route: KeyRouteId): Promise<KeyCredentialView>
  /** Store a value under the route's effective reference. */
  set(route: KeyRouteId, value: string): Promise<KeyCredentialResult>
  /** Remove the DSH copy; an environment source may still supply the key. */
  clear(route: KeyRouteId): Promise<KeyCredentialResult>
  /**
   * Run the route's own read against the committed credential, refusing to
   * answer for one that another change replaced meanwhile.
   */
  validate(route: KeyRouteId, generation: number): Promise<KeyValidationResult>
}
