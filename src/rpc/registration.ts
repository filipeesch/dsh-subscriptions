/**
 * The `/subscriptions-auth` RPC assembly: the auth controller, the speed and
 * model-default controllers, and the settings, model, and key-route endpoints
 * they expose. `apply` keeps the provider construction, the account maps, and
 * the host seams; everything the browser calls is assembled here.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AdapterRegistrationHandle,
  LlmModelInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
// Type-only: activates the optional live agent registry used for subagent speed.
// Type-only: activates the `ctx.tools` Context merge for the inject block.
// Type-only: activates the `ctx.web` Context merge for optional registration.
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { OAuthFlowManager } from '../auth/oauth-flow.js'
import { DeviceFlowManager } from '../auth/device-flow.js'
import { ResetRedemption } from '../providers/reset-redemption.js'
import { BadRequest, registerAuthRpc } from '../auth/rpc.js'
import { hasControlCharacters } from '../providers/credential-text.js'
import type {
  CursorKnownContextView,
  CursorRpcController,
} from '../auth/rpc.js'
import {
  validateCursorSettings,
  type CursorSettingsStore,
} from '../providers/cursor-settings.js'
import { buildCursorModelRows } from '../providers/cursor/model-rows.js'
import type { CursorCatalogModel } from '../providers/cursor/catalog.js'
import type { PublishedRefreshOutcome } from '../providers/cursor/published-context.js'
import type { CursorConfigPolicy } from '../providers/cursor/policy.js'
import {
  createCredentialResolver,
  registerKeyRoute,
} from '../providers/key-route.js'
import { KeyCredentials } from '../providers/key-credentials.js'
import type { KeyCredentialSeam } from '../providers/key-credentials.js'
import { CURSOR_ROUTE } from '../providers/cursor/route.js'
import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { ExternalUsageController } from '../providers/external-usage-controller.js'
import {
  DEFAULT_OLLAMA_BASE_URL,
  OllamaAdapter,
  fetchOllamaModels,
  OLLAMA_CLOUD_ROUTE,
  OLLAMA_PULL_TIMEOUT_MS,
} from '../providers/ollama.js'
import type { OllamaDiscoveredModel } from '../providers/ollama.js'
import {
  OllamaWebFetchProvider,
  OllamaWebSearchProvider,
} from '../providers/ollama-web.js'
import {
  OllamaSettingsStore,
  sameOllamaDestination,
  validateOllamaSettings,
} from '../providers/ollama-settings.js'
import type { OllamaModelSetting } from '../providers/ollama-settings.js'
import type {
  ModelDefaultsCatalog,
  ModelDefaultsController,
  ModelDefaultView,
  SpeedController,
  SpeedTier,
} from '../auth/rpc.js'
import {
  defaultEffortOf,
  loadModelDefaults,
  setDefaultEffort,
} from '../model-defaults.js'
import { resolveAccountKey, PROVIDER_IDS } from '../auth/store.js'
import type { CodexSession, ProviderId, StoredSession } from '../auth/store.js'
import {
  DISCOVERY_TIMEOUT_MS,
  effortDisplayName,
  withTimeout,
} from '../providers/common.js'
import type { ProviderUsage } from '../providers/common.js'
import { AccountTokenManager } from '../providers/accounts.js'
import type { AccountAwareAdapter } from '../providers/accounts.js'
import type { PoolHealthRegistry } from '../providers/pool-health.js'
import type { PoolUsageTracker } from '../providers/pool-usage.js'
import type { ModelSpeeds } from '../model-speeds.js'
import type { CodexAdapter } from '../providers/codex.js'
import type { ClaudeAdapter } from '../providers/claude.js'
import { consumeCodexResetCredit } from '../providers/codex.js'
import { hostFetch } from '../http.js'
import { PROVIDER_TOOLS, validatePreferences } from '../provider-settings.js'
import type { ProviderSettingsStore } from '../provider-settings.js'
import {} from '../providers/rate-limit.js'
import { ClaudeCliVersionCache } from '../providers/claude-cli-version.js'
import type {
  CliVersion,
  NpmCliVersionCache,
} from '../providers/npm-cli-version.js'
import { CodexClientVersionCache } from '../providers/codex-client-version.js'
import { PoolAdapter } from '../providers/pool.js'
import {
  accountModelId,
  parseAccountModelId,
} from '../providers/account-preferences.js'
import type {
  Config,
  SubscriptionsAuthController as AuthControllerClass,
} from '../index.js'
/** Per-provider per-account usage lookup; providers without a usage endpoint are absent. */
export type UsageFetchers = Partial<
  Record<
    ProviderId,
    (account: string, signal: AbortSignal) => Promise<ProviderUsage>
  >
>

/** How long the Settings status waits on a CLI version refresh before showing the last one. */
const STATUS_VERSION_WAIT_MS = 1000

/**
 * Read the CLI version a route presents for the Settings page. The first
 * lookup is awaited (bounded by its own 5s deadline) so a slow registry is
 * not misreported as a fallback; a later refresh is waited on only briefly,
 * because the whole page waits on `status`, and the last result shows.
 */
export function presentedVersion(
  cache: Pick<NpmCliVersionCache, 'resolve' | 'current'>,
  waitMs = STATUS_VERSION_WAIT_MS,
): () => Promise<CliVersion | undefined> {
  return async () => {
    if (cache.current() === undefined) {
      await cache.resolve()
      return cache.current()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      cache.resolve(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs)
      }),
    ]).finally(() => {
      clearTimeout(timer)
    })
    return cache.current()
  }
}

export interface RpcDeps {
  ctx: Context
  config: Config
  providers: readonly ProviderId[]
  preferences: ProviderSettingsStore
  adapters: Map<ProviderId, AccountAwareAdapter>
  handles: Map<string, AdapterRegistrationHandle>
  accountTokens: Map<ProviderId, AccountTokenManager<StoredSession>>
  fullCatalogs: Map<
    ProviderId,
    (provider: string) => Promise<readonly LlmModelInfo[]>
  >
  codexAdapter: CodexAdapter | undefined
  claudeAdapter: ClaudeAdapter | undefined
  codexTokens: AccountTokenManager<CodexSession> | undefined
  codexVersion: CodexClientVersionCache
  claudeVersion: ClaudeCliVersionCache
  poolAdapter: PoolAdapter | undefined
  poolHealth: PoolHealthRegistry | undefined
  poolUsage: PoolUsageTracker | undefined
  flows: OAuthFlowManager
  deviceFlows: DeviceFlowManager
  authChanged: (provider: ProviderId, account?: string) => void
  accountOf: (
    provider: ProviderId,
    session: StoredSession,
  ) => string | undefined
  SubscriptionsAuthController: typeof AuthControllerClass
  cursorSettings: CursorSettingsStore
  cursorApiKeyRef: () => string
  /** Models the route advertises; a refresh may load the catalog. */
  cursorModelCount: (refresh?: boolean) => Promise<number | undefined>
  /** Raw catalog for the manager rows; a refresh forces a live read. */
  cursorCatalog: (refresh?: boolean) => Promise<readonly CursorCatalogModel[]>
  /** Per-model configuration baseline. */
  cursorConfig: () => CursorConfigPolicy
  /** Capacity the public catalog publishes for one model. */
  cursorPublishedWindow: (modelId: string) => number | undefined
  /** The published-capacity source's state. */
  cursorKnownContext: () => CursorKnownContextView
  /** Refresh the projection now and report what happened. */
  cursorRefreshContext: () => Promise<PublishedRefreshOutcome>
  /** Re-announce the Cursor route so the host re-lists its models. */
  cursorNotifyPicker: () => void
  /** Drop the cached Cursor catalog because the credential that produced it changed. */
  cursorForgetCatalog: () => void
  /** Prove one Cursor key with a live read made with exactly that value. */
  cursorValidateKey: (apiKey: string) => Promise<void>
  resolveAttachments: () => AttachmentStore | undefined
  usageFetchers: UsageFetchers
  selectedSpeed: (sessionId: string, model?: string) => SpeedTier
  streamIdleTimeoutMs: number
  onWarn: (message: string) => void
  speedBySession: Map<string, SpeedTier>
  speedBySessionModel: Map<string, Map<string, SpeedTier>>
  modelSpeeds: ModelSpeeds
  ollamaSettings: OllamaSettingsStore
  ollamaBaseURL: () => string
  ollamaApiKeyRef: () => string
  ollamaWebEnabled: () => boolean
  ollamaModelsOverridden: () => boolean
  ollamaCatalog: () => readonly OllamaModelSetting[]
}

export function assembleRpc(deps: RpcDeps): void {
  const {
    ctx,
    config,
    providers,
    preferences,
    adapters,
    handles,
    accountTokens,
    fullCatalogs,
    codexAdapter,
    claudeAdapter,
    codexTokens,
    codexVersion,
    claudeVersion,
    poolAdapter,
    poolHealth,
    poolUsage,
    flows,
    deviceFlows,
    authChanged,
    accountOf,
    SubscriptionsAuthController,
    cursorSettings,
    cursorApiKeyRef,
    cursorModelCount,
    cursorCatalog,
    cursorConfig,
    cursorPublishedWindow,
    cursorKnownContext,
    cursorRefreshContext,
    cursorNotifyPicker,
    cursorForgetCatalog,
    cursorValidateKey,
    resolveAttachments,
    usageFetchers,
    selectedSpeed,
    streamIdleTimeoutMs,
    onWarn,
    speedBySession,
    speedBySessionModel,
    modelSpeeds,
    ollamaSettings,
    ollamaBaseURL,
    ollamaApiKeyRef,
    ollamaWebEnabled,
    ollamaModelsOverridden,
    ollamaCatalog,
  } = deps
  const speed: SpeedController = {
    async speed(sessionId, model) {
      const fastModels = (await codexAdapter?.fastCapableModels()) ?? []
      const accountPreferences = preferences.get('codex').accounts
      for (const { key } of (await codexTokens?.list()) ?? []) {
        if (
          !accountPreferences ||
          !Object.hasOwn(accountPreferences, key) ||
          accountPreferences[key].independentEntry !== true
        )
          continue
        for (const model of [...fastModels]) {
          if (parseAccountModelId(model)) continue
          if (await codexAdapter?.supportsFastTier(model, key))
            fastModels.push(accountModelId(key, model))
        }
      }
      return {
        tier:
          model !== undefined && !fastModels.includes(model)
            ? 'standard'
            : selectedSpeed(sessionId, model),
        fastModels,
      }
    },
    async setSpeed(sessionId, tier, model) {
      if (model === undefined) {
        // Legacy callers keep an explicit session-only Standard/Fast override.
        speedBySession.set(sessionId, tier)
        return
      }
      model = parseAccountModelId(model)?.model ?? model
      await modelSpeeds.set(model, tier)
      const choices =
        speedBySessionModel.get(sessionId) ?? new Map<string, SpeedTier>()
      choices.set(model, tier)
      speedBySessionModel.set(sessionId, choices)
    },
  }
  // Per-model default effort overrides (the Settings page's model pickers).
  // The catalog re-reads the live model info per model — same source as the
  // session model picker, so the offered effort levels match the picker
  // exactly, and the configured default merges in through the adapters.
  const modelDefaults: ModelDefaultsController = {
    async catalog(force = false): Promise<ModelDefaultsCatalog[]> {
      if (force) {
        codexVersion.invalidate()
        claudeVersion.invalidate()
        // This is not an auth transition: retain health, usage and Copilot
        // reasoning replay, but bypass every account's discovery cache.
        for (const adapter of adapters.values()) adapter.clearAccountCatalog()
        poolAdapter?.invalidate()
        for (const [route, handle] of handles) handle.replace([route])
      }
      const visible = new Set(
        (await ctx.llm.listProviders()).map((provider) => provider.id),
      )
      const catalog: ModelDefaultsCatalog[] = []
      for (const provider of PROVIDER_IDS) {
        if (!visible.has(provider)) continue
        let models: readonly { id: string; name: string }[]
        try {
          models = await ctx.llm.listModels(provider)
        } catch {
          continue // provider unregistered or catalog unavailable; leave it out
        }
        // Configured tier rows resolve through the pool, which intersects its
        // members' own capabilities and never consults defaultEffortOf for the
        // tier id — an override on one would save cleanly and do nothing. Leave
        // them out rather than offer a control that cannot take effect.
        let tierIds: ReadonlySet<string> = new Set()
        try {
          const tiers = await poolAdapter?.modelsForProvider(provider)
          if (tiers !== undefined)
            tierIds = new Set(tiers.map((tier) => tier.id))
        } catch {
          // A pool that cannot enumerate leaves every row listed; the worst
          // case is the pre-existing behaviour, not a missing card.
        }
        const views: ModelDefaultView[] = []
        for (const model of models) {
          if (tierIds.has(model.id) || parseAccountModelId(model.id)) continue
          let info: LlmResolvedModelInfo | undefined
          try {
            info = await ctx.llm.resolveModelInfo(provider, model.id)
          } catch {
            continue // one broken entry must not hide the rest
          }
          if (info === undefined) continue
          // `defaultEffortOf` rather than a bare index: model ids are catalog
          // data, and an id like `toString` would otherwise inherit a function.
          const override = defaultEffortOf(provider, model.id)
          views.push({
            id: model.id,
            name: model.name,
            efforts:
              info.reasoning?.efforts.map((effort) => ({
                id: effort.id,
                name: effort.name,
              })) ?? [],
            ...(override === undefined ? {} : { configured: override }),
          })
        }
        catalog.push({ provider, models: views })
      }
      return catalog
    },
    async set(provider, model, effort) {
      // Garbage in, garbage out: accept only levels the model's own catalog
      // actually advertises (clearing with `undefined` always passes). A value
      // from elsewhere — a hand-edited store file — would otherwise ride on
      // every request and 400. An unknown effort fails the save instead of
      // silently saving something unusable.
      if (effort !== undefined) {
        let info: LlmResolvedModelInfo | undefined
        try {
          info = await ctx.llm.resolveModelInfo(provider, model)
        } catch {
          // Fall through when the catalog is unavailable: rejecting the save
          // here would make every write fail during an outage.
        }
        const offered = info?.reasoning?.efforts ?? []
        if (
          offered.length > 0 &&
          !offered.some((entry) => entry.id === effort)
        ) {
          throw new BadRequest(
            `model ${model} does not advertise a "${effort}" reasoning effort`,
          )
        }
      }
      await setDefaultEffort(provider, model, effort)
      // Re-announce the route so the model picker re-queries `listModels` and
      // reflects the new default immediately (same path as auth changes).
      handles.get(provider)?.replace([provider])
    },
  }
  let resolveExternalCredential:
    ((name: string) => Promise<{ value: string } | undefined>) | undefined
  // The operator-configured address is the only destination the host spends a
  // stored credential on. The base URL is also card-editable, so every path that
  // would send the key — chat, discovery, the listing, usage, and web — asks
  // this one question.
  const operatorOllamaBaseURL =
    config.ollama?.baseURL ?? DEFAULT_OLLAMA_BASE_URL
  const ollamaDestinationIsConfigured = (): boolean =>
    sameOllamaDestination(ollamaBaseURL(), operatorOllamaBaseURL)
  /**
   * The Ollama credential and the address it may be spent at, captured together.
   *
   * The address and the reference are both card-editable, so a Settings save can
   * land between reading one and using the other. Every consumer builds its
   * request from this snapshot instead of re-reading the address later: the key
   * and the destination are approved as one value.
   * @returns the pair, or undefined when there is no usable credential.
   */
  const ollamaConnection = async (): Promise<
    { apiKey: string; baseURL: string } | undefined
  > => {
    const baseURL = ollamaBaseURL()
    if (!sameOllamaDestination(baseURL, operatorOllamaBaseURL)) return undefined
    const apiKey = (await resolveExternalCredential?.(ollamaApiKeyRef()))?.value
    if (apiKey === undefined || hasControlCharacters(apiKey)) return undefined
    return { apiKey, baseURL }
  }
  let ollamaAdapter: OllamaAdapter | undefined
  let ollamaHandle: AdapterRegistrationHandle | undefined
  ctx.inject(['credentials'], (credentialsCtx) => {
    resolveExternalCredential = createCredentialResolver(credentialsCtx)
    // Ollama Cloud is a key-based route with no OAuth session. Every setting
    // is read through the live getters above, so a Settings save reaches the
    // next request without a restart; the stored catalog is the only source
    // of models.
    ollamaAdapter = new OllamaAdapter({
      connection: ollamaConnection,
      catalog: ollamaCatalog,
      resolveAttachments,
      streamIdleTimeoutMs,
      onWarn,
    })
    ollamaHandle = registerKeyRoute(
      credentialsCtx,
      OLLAMA_CLOUD_ROUTE,
      ollamaAdapter,
    )
  })
  // The web providers gate on the live effective switch, so a Settings save
  // enables or disables them without re-registering: registration alone does
  // not make a provider available, and an unavailable one stays out of the
  // host's selection. The default stays off.
  let ollamaWebRegistered = false
  const syncOllamaWeb = (): void => {
    if (ollamaWebRegistered || !ollamaWebEnabled()) return
    ollamaWebRegistered = true
    ctx.inject(['web'], (webCtx) => {
      webCtx.web.registerSearchProvider(
        new OllamaWebSearchProvider({
          connection: ollamaConnection,
          enabled: ollamaWebEnabled,
        }),
      )
      webCtx.web.registerFetchProvider(
        new OllamaWebFetchProvider({
          connection: ollamaConnection,
          enabled: ollamaWebEnabled,
        }),
      )
    })
  }
  syncOllamaWeb()
  const externalUsage = new ExternalUsageController(
    async (name) => resolveExternalCredential?.(name),
    hostFetch,
    // A custom ollama ref must reach usage status too, or chat and the
    // quota card would read different credentials. Both values are live so a
    // Settings save moves chat and usage to the same target.
    { 'ollama-cloud': ollamaApiKeyRef, cursor: cursorApiKeyRef },
    ollamaBaseURL,
    { ceilingUSD: () => cursorSettings.ceilingUSD() },
    {},
    // The usage read spends the stored key too, so Ollama follows the same
    // destination policy. The gate names the source, not the reference: another
    // provider may use the same reference name at its own destination.
    { 'ollama-cloud': ollamaDestinationIsConfigured },
  )
  const resetRedemption = new ResetRedemption(
    async (account, signal) => {
      if (!usageFetchers.codex) throw new BadRequest('Codex unavailable')
      return usageFetchers.codex(account, signal)
    },
    async (account, creditId, requestId, signal) => {
      if (!codexTokens) throw new BadRequest('Codex unavailable')
      await consumeCodexResetCredit(
        await codexTokens.session(account),
        creditId,
        requestId,
        hostFetch,
        signal,
      )
    },
    (account) => poolUsage?.invalidate('codex', account),
    // The browser may name the account by canonical id, legacy key, email, or
    // workspace id. The guards must key on the stored account's key — the same
    // one the usage cache uses — so an alias cannot slip past a parked
    // outcome, and an invalidation actually clears that account's cache.
    async (account) => resolveAccountKey('codex', account),
  )
  const cursor: CursorRpcController = {
    async settings(refresh) {
      const stored = cursorSettings.get()
      const models = await cursorModelCount(refresh).catch(() => undefined)
      return {
        provider: 'cursor',
        // A configured name that is not a reference is omitted, not echoed: it
        // may be a value someone pasted into the profile.
        keyRef: isCredentialRefName(cursorApiKeyRef()) ? cursorApiKeyRef() : '',
        publishedContext: cursorKnownContext().enabled,
        knownContext: cursorKnownContext(),
        ...(stored.monthlyCeilingUSD === undefined
          ? {}
          : { ceilingUSD: stored.monthlyCeilingUSD }),
        ...(models === undefined ? {} : { models }),
      }
    },
    async setCeiling(ceilingUSD) {
      // Keep the rest of the document: models, tiers, and the source switch.
      await cursorSettings.setCeiling(ceilingUSD)
      // The next read must use the new ceiling, not a reading cached under the
      // old one.
      externalUsage.invalidate('cursor')
    },
    async models(refresh) {
      const catalog = await cursorCatalog(refresh)
      const settings = cursorSettings.get()
      const config = cursorConfig()
      return {
        provider: 'cursor',
        models: buildCursorModelRows({
          models: catalog,
          settings,
          config,
          publishedWindow: cursorPublishedWindow,
        }),
        knownContext: cursorKnownContext(),
        // The page patches this map and sends it back, so it carries every
        // stored entry, including the models the catalog no longer lists.
        storedModels: settings.models ?? {},
      }
    },
    async setSettings(patch) {
      // A partial patch: the manager writes the whole models map (so removals
      // stick) and the card flips one flag, while the ceiling and remembered
      // tiers stay untouched. Validation happens before the store mutation so a
      // bad field is a bad request, not an internal error.
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new BadRequest('Cursor settings must be an object')
      }
      const record = patch as Record<string, unknown>
      for (const key of Object.keys(record)) {
        if (key !== 'models' && key !== 'publishedContext') {
          throw new BadRequest(`unsupported Cursor setting: ${key}`)
        }
      }
      const candidate = {
        ...cursorSettings.get(),
        ...('models' in record ? { models: record.models } : {}),
        ...('publishedContext' in record
          ? { publishedContext: record.publishedContext }
          : {}),
      }
      try {
        validateCursorSettings(candidate)
      } catch (error) {
        throw new BadRequest(
          error instanceof Error ? error.message : String(error),
        )
      }
      // The store performs the merge inside its serialized write chain, so a
      // concurrent ceiling save or learned tier cannot be lost.
      await cursorSettings.merge({
        ...('models' in record
          ? {
              models: record.models as NonNullable<
                ReturnType<CursorSettingsStore['get']>['models']
              >,
            }
          : {}),
        ...('publishedContext' in record
          ? { publishedContext: record.publishedContext as boolean }
          : {}),
      })
      // The host caches the picker list; a saved enable/tier/window or source
      // switch changes what the route advertises, so re-announce it.
      cursorNotifyPicker()
    },
    async refreshContext() {
      const outcome = await cursorRefreshContext()
      const state = cursorKnownContext()
      if (outcome.status === 'refreshed') {
        return {
          enabled: state.enabled,
          status: 'refreshed' as const,
          fetchedAt: outcome.fetchedAt,
          windows: outcome.windows,
        }
      }
      if (outcome.status === 'failed') {
        return {
          enabled: state.enabled,
          status: 'failed' as const,
          reason: outcome.reason,
          ...(outcome.fetchedAt === undefined
            ? {}
            : { fetchedAt: outcome.fetchedAt }),
        }
      }
      return {
        enabled: state.enabled,
        status: 'unavailable' as const,
        reason: outcome.reason,
      }
    },
  }
  // The two key routes read a credential reference per request. This surface is
  // the write side the cards drive; the seam is resolved per call because the
  // RPC is assembled before the credentials service is guaranteed to exist.
  const keyCredentials = new KeyCredentials({
    // Only an operator-controlled reference is editable from the browser. The
    // Cursor reference lives in the profile; Ollama also accepts one from its
    // card-editable store, and that one must not become a writer for any
    // reference the host knows.
    editableRefOf: (route) => {
      if (route === CURSOR_ROUTE) return cursorApiKeyRef()
      if (ollamaSettings.get().apiKeyRef !== undefined) return undefined
      return ollamaApiKeyRef()
    },
    seam: () => ctx.get('credentials') as KeyCredentialSeam | undefined,
    onChanged: (route) => {
      // The reading is cached per credential: a save or removal must not serve
      // the previous key's numbers. Discovery is cached too, and a forced read
      // joins an in-flight fetch, so both routes drop theirs before the card's
      // validation asks for a fresh one.
      externalUsage.invalidate(
        route === CURSOR_ROUTE ? 'cursor' : 'ollama-cloud',
      )
      if (route === CURSOR_ROUTE) {
        cursorForgetCatalog()
        cursorNotifyPicker()
      } else {
        ollamaAdapter?.invalidateModels()
        ollamaHandle?.replace([OLLAMA_CLOUD_ROUTE])
      }
    },
    // Host-only: the validation proves the committed credential by fingerprint,
    // and the value itself never crosses the RPC.
    resolveValue: async (ref) =>
      (await resolveExternalCredential?.(ref))?.value,
    validators: {
      // Each route's own read, run by the host against the committed credential
      // and bound to its generation, so a concurrent change cannot be validated
      // as this writer's.
      [CURSOR_ROUTE]: async (value) => {
        // The service hands the value it verified, and the read spends exactly
        // that value: a catalog read made with the stored key could be the
        // previous one, and a missing key reads as a successful empty catalog.
        if (value === undefined)
          throw new BadRequest('no Cursor API key is configured for this route')
        await cursorValidateKey(value)
      },
      [OLLAMA_CLOUD_ROUTE]: async (value) => {
        // The service hands the value it verified, and the read targets the
        // operator's address: a pass means the committed key works where the
        // route actually spends it. A route with no stored value cannot pass.
        if (value === undefined)
          throw new BadRequest('no Ollama API key is configured for this route')
        await listOllamaModels(
          { apiKey: value, baseURL: operatorOllamaBaseURL },
          AbortSignal.timeout(OLLAMA_PULL_TIMEOUT_MS),
        )
      },
    },
  })
  /**
   * List the Ollama catalog at one address.
   *
   * A typed key rides this listing only: it is never stored and never echoed.
   * The host-resolved key is bound to the operator-configured destination,
   * because the base URL is also card-editable; a different address keeps its
   * own refusal. Provider and transport failures are reported as fixed
   * sentences: their text can repeat the request, and this message reaches the
   * Settings browser.
   * @param input - the listing request.
   * @param signal - caller cancellation.
   * @returns the discovered models, shaped as the card lists them.
   */
  const listOllamaModels = async (
    input: { apiKey?: string; baseURL?: string },
    signal: AbortSignal,
  ) => {
    const baseURL = input.baseURL ?? ollamaBaseURL()
    let apiKey = input.apiKey
    if (apiKey === undefined) {
      if (!sameOllamaDestination(baseURL, operatorOllamaBaseURL))
        throw new BadRequest(
          'enter the API key to list models from an address other than the configured one',
        )
      apiKey = (await ollamaConnection())?.apiKey
      if (apiKey === undefined)
        throw new BadRequest('no Ollama API key is configured for this route')
    }
    if (hasControlCharacters(apiKey))
      throw new BadRequest(
        'the Ollama API key cannot be sent: it carries control characters',
      )
    const timeout = AbortSignal.timeout(OLLAMA_PULL_TIMEOUT_MS)
    const combined = AbortSignal.any([signal, timeout])
    let discovered: OllamaDiscoveredModel[]
    try {
      discovered = await fetchOllamaModels({
        baseURL,
        apiKey,
        signal: combined,
      })
    } catch (error) {
      if (timeout.aborted) {
        // The host renders error.cause. This timeout replaces the abort.
        // eslint-disable-next-line preserve-caught-error -- the replacement is the message the host shows
        throw new Error(
          `Ollama model listing timed out after ${OLLAMA_PULL_TIMEOUT_MS}ms`,
        )
      }
      // The provider's message can repeat the request; only the reviewed cause
      // stays, out of the reply.
      throw new Error('the Ollama endpoint could not be read', { cause: error })
    }
    return {
      models: discovered.map((row) => ({
        id: row.id,
        rawId: row.rawId,
        name: row.rawId,
        vision: row.inputModalities?.includes('image') === true,
        thinking: row.thinking,
        ...(row.contextWindow === undefined
          ? {}
          : { contextWindow: row.contextWindow }),
        efforts:
          row.reasoning?.efforts.map((effort) => String(effort.id)) ?? [],
        ...(row.reasoning?.defaultEffort === undefined
          ? {}
          : { defaultEffort: String(row.reasoning.defaultEffort) }),
      })),
    }
  }
  registerAuthRpc(ctx, {
    controller: new SubscriptionsAuthController(
      flows,
      deviceFlows,
      authChanged,
      resolveAttachments,
      usageFetchers,
      undefined,
      poolUsage,
      config.antigravity,
      {
        ...(providers.includes('codex')
          ? {
              codex:
                config.codexClientVersion === undefined
                  ? presentedVersion(codexVersion)
                  : async () => ({
                      version: config.codexClientVersion!,
                      source: 'config' as const,
                    }),
            }
          : {}),
        ...(providers.includes('claude')
          ? { claude: presentedVersion(claudeVersion) }
          : {}),
      },
      resetRedemption,
      (provider, account) => poolHealth?.clear(provider, account),
    ),
    speed,
    modelDefaults,
    providerSettings: {
      visibleModels: (provider) => preferences.get(provider).visibleModels,
      async get(provider, force) {
        await loadModelDefaults()
        const adapter = adapters.get(provider)
        if (!adapter)
          throw new BadRequest(`provider ${provider} is not configured`)
        if (force) {
          if (provider === 'codex') codexVersion.invalidate()
          if (provider === 'claude') claudeVersion.invalidate()
          adapter.clearAccountCatalog()
          poolAdapter?.invalidate()
          handles.get(provider)?.replace([provider])
        }
        const models = await fullCatalogs.get(provider)!(provider)
        // Enumerate each account once, with the same bounds used by pool discovery.
        const accounts = (await accountTokens.get(provider)?.list()) ?? []
        const accountCatalogs = await Promise.all(
          accounts.map(async (account) => ({
            account: account.key,
            models: await withTimeout(
              (signal) => adapter.listOwnModels(provider, account.key, signal),
              DISCOVERY_TIMEOUT_MS,
            ).catch(() => undefined),
          })),
        )
        const tierIds = new Set(
          (
            (await poolAdapter?.modelsForProvider(provider).catch(() => [])) ??
            []
          ).map((model) => model.id),
        )
        const fastModels = new Set(
          provider === 'codex'
            ? ((await codexAdapter?.fastCapableModels()) ?? [])
            : [],
        )
        const rows = await Promise.all(
          models.map(async (model) => {
            const contexts: { default: number; max: number }[] = []
            if (provider === 'codex' && codexAdapter) {
              for (const account of accountCatalogs) {
                if (account.models?.some((entry) => entry.id === model.id)) {
                  const limits = await codexAdapter
                    .contextLimits(model.id, account.account)
                    .catch(() => undefined)
                  if (limits) contexts.push(limits)
                }
              }
            }
            if (provider === 'claude' && claudeAdapter) {
              for (const account of accountCatalogs) {
                if (account.models?.some((entry) => entry.id === model.id)) {
                  const limits = await claudeAdapter
                    .contextLimits(model.id, account.account)
                    .catch(() => undefined)
                  if (limits) contexts.push(limits)
                }
              }
            }
            // A model with unavailable capabilities can still be hidden or restored.
            const info = await withTimeout(
              () => adapter.resolveModel(provider, model.id),
              DISCOVERY_TIMEOUT_MS,
            ).catch(() => undefined)
            return {
              id: model.id,
              name: model.name,
              contextWindow: info?.context?.contextWindow,
              efforts: tierIds.has(model.id)
                ? []
                : (info?.reasoning?.efforts.map(({ id, name }) => ({
                    id,
                    name,
                  })) ?? []),
              configured: defaultEffortOf(provider, model.id),
              ...(provider === 'codex'
                ? {
                    fastTier:
                      !tierIds.has(model.id) && fastModels.has(model.id),
                  }
                : {}),
              ...(contexts.length
                ? {
                    defaultContextWindow: Math.min(
                      ...contexts.map((entry) => entry.default),
                    ),
                    maxContextWindow: Math.min(
                      ...contexts.map((entry) => entry.max),
                    ),
                  }
                : {}),
            }
          }),
        )
        return {
          provider,
          settings: preferences.get(provider),
          models: rows,
          tools: PROVIDER_TOOLS[provider],
          accounts: accounts.map(({ key, session }) => {
            const catalog = accountCatalogs.find(
              (entry) => entry.account === key,
            )?.models
            return {
              key,
              label: accountOf(provider, session) ?? key,
              models: (catalog ?? []).map(({ id, name }) => ({ id, name })),
              ...(catalog === undefined ? { unavailable: true } : {}),
            }
          }),
        }
      },
      async set(provider, settings) {
        if (!adapters.has(provider))
          throw new BadRequest(`provider ${provider} is not configured`)
        let validated
        try {
          validated = validatePreferences(provider, settings)
        } catch (error) {
          throw new BadRequest(
            error instanceof Error ? error.message : String(error),
          )
        }
        await preferences.set(provider, validated)
        poolAdapter?.invalidate()
        for (const [route, handle] of handles) handle.replace([route])
      },
    },
    externalUsage,
    ollama: {
      settings: async () => ({
        provider: 'ollama-cloud',
        settings: ollamaSettings.get(),
        effective: {
          baseURL: ollamaBaseURL(),
          // Same rule as the Cursor card: a name that is not a reference is
          // omitted rather than printed back.
          apiKeyRef: isCredentialRefName(ollamaApiKeyRef())
            ? ollamaApiKeyRef()
            : '',
          web: ollamaWebEnabled(),
        },
        // The picker's catalog, so the dialog can show what it is editing even
        // while a config override keeps the store out of the effective list.
        models: ollamaCatalog().map((entry) => ({
          id: entry.id,
          name: entry.name ?? entry.id,
          vision: entry.vision === true,
          // A stored row may carry efforts without the flag (a hand-written
          // row); either one means the model thinks.
          thinking: entry.thinking === true || (entry.efforts?.length ?? 0) > 0,
          ...(entry.contextWindow === undefined
            ? {}
            : { contextWindow: entry.contextWindow }),
          // The effort set the resolver serves this row (vendor levels win
          // over the stored list at resolve time, so the dialog pools the
          // stored row and its enrichment here only).
          ...(entry.efforts === undefined
            ? {}
            : {
                efforts: entry.efforts.map((effort) => ({
                  id: effort,
                  name: effortDisplayName(effort),
                })),
              }),
          ...(entry.defaultEffort === undefined
            ? {}
            : { defaultEffort: entry.defaultEffort }),
        })),
        configOverridesModels: ollamaModelsOverridden(),
        keyUsable: ollamaDestinationIsConfigured(),
      }),
      setSettings: async (input) => {
        let validated
        try {
          validated = validateOllamaSettings(input)
        } catch (error) {
          throw new BadRequest(
            error instanceof Error ? error.message : String(error),
          )
        }
        await ollamaSettings.set(validated)
        // The saved catalog and base URL replace what the adapter cached: drop
        // the discovery snapshot, re-announce the route so the picker re-queries
        // `listModels`, and let a web toggle take effect.
        ollamaAdapter?.invalidateModels()
        ollamaHandle?.replace([OLLAMA_CLOUD_ROUTE])
        syncOllamaWeb()
      },
      models: async (input, signal) => listOllamaModels(input, signal),
    },
    cursor,

    keyCredentials,
  })
}
