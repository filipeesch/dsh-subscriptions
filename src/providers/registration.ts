/**
 * Construction of the OAuth provider routes.
 *
 * Each builder owns one provider's token manager, adapter, and usage fetcher.
 * The caller keeps everything that is not provider construction: the account
 * maps, the route registration handles, the pool, and auth notifications. A
 * builder returns its pieces instead of mutating caller state, so adding a
 * provider never grows the bootstrap function.
 */

import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Config } from '../index.js'
import { hostFetch } from '../http.js'
import { defaultEffortOf } from '../model-defaults.js'
import { refreshClaudeSynced } from '../auth/claude-code-creds.js'
import type {
  AntigravitySession,
  ClaudeSession,
  CodexSession,
  CopilotSession,
  GrokSession,
  ProviderId,
  StoredSession,
} from '../auth/store.js'
import type { SpeedTier } from '../auth/rpc.js'
import type { ProviderSettingsStore } from '../provider-settings.js'
import type { PromptCacheTtl } from '../translate/anthropic.js'
import { AccountTokenManager } from './accounts.js'
import type { AccountAwareAdapter } from './accounts.js'
import { accountCatalogStore, catalogStore } from './catalog-store.js'
import type { ModelEntry, ProviderUsage } from './common.js'
import type { ClaudeCliVersionCache } from './claude-cli-version.js'
import type { CodexClientVersionCache } from './codex-client-version.js'
import type { PoolAdapter } from './pool.js'
import type { RateLimitWait } from './rate-limit.js'
import {
  ClaudeAdapter,
  CLAUDE_PREEMPT_MS,
  fetchClaudeUsage,
  isClaudePermanentRefreshError,
  refreshClaude,
} from './claude.js'
import {
  CodexAdapter,
  CODEX_PREEMPT_MS,
  fetchCodexResetCredits,
  fetchCodexUsage,
  isCodexPermanentRefreshError,
  refreshCodex,
} from './codex.js'
import {
  GrokAdapter,
  GROK_PREEMPT_MS,
  fetchGrokUsage,
  isGrokPermanentRefreshError,
  refreshGrok,
} from './grok.js'
import {
  CopilotAdapter,
  COPILOT_PREEMPT_MS,
  isCopilotPermanentRefreshError,
  refreshCopilot,
} from './copilot.js'
import {
  AntigravityAdapter,
  ANTIGRAVITY_PREEMPT_MS,
  fetchAntigravityUsage,
  isAntigravityPermanentRefreshError,
  refreshAntigravity,
  resolveAntigravityOAuthConfig,
} from './antigravity.js'

/** Usage lookup for one account; the RPC surface and the pool share it. */
export type UsageFetcher = (
  account: string,
  signal: AbortSignal,
) => Promise<ProviderUsage>

/** What one builder hands back to the caller. */
export interface BuiltProvider {
  adapter: AccountAwareAdapter
  /** The provider's account token manager, when it has one. */
  tokens?: AccountTokenManager<StoredSession>
  /** The provider's usage lookup, when it has an endpoint. */
  usage?: UsageFetcher
  /**
   * Drop captured request state on an auth transition (Copilot's reasoning
   * replay). Absent for providers that keep no such state.
   */
  clearReplayState?: () => void
}

/** Everything a builder reads; owned and mutated by the caller otherwise. */
export interface ProviderBuildDeps {
  config: Config
  preferences: ProviderSettingsStore
  codexVersion: CodexClientVersionCache
  claudeVersion: ClaudeCliVersionCache
  streamIdleTimeoutMs: number
  rateLimit: RateLimitWait
  claudePromptCacheTtl: PromptCacheTtl
  catalog: Record<ProviderId, ModelEntry[]>
  /** Providers whose configured catalog overrides live discovery. */
  overridden: ReadonlySet<ProviderId>
  onWarn: (message: string) => void
  resolveAttachments: () => AttachmentStore | undefined
  /** Late-bound pool facade; pools are assembled after every adapter exists. */
  pool: () => PoolAdapter | undefined
  selectedSpeed: (sessionId: string, model?: string) => SpeedTier
}

/** Build the ChatGPT (Codex) route. */
export function buildCodexProvider(deps: ProviderBuildDeps): BuiltProvider {
  const tokens = new AccountTokenManager<CodexSession>({
    provider: 'codex',
    displayName: 'ChatGPT (Codex)',
    makeOptions: () => ({
      preemptMs: CODEX_PREEMPT_MS,
      refresh: refreshCodex,
      isPermanent: isCodexPermanentRefreshError,
    }),
  })
  const usage: UsageFetcher = async (account, signal) => {
    const session = await tokens.session(account)
    const result = await fetchCodexUsage(session, hostFetch, signal)
    try {
      const resetCredits = await fetchCodexResetCredits(
        session,
        hostFetch,
        signal,
      )
      return { ...result, resetCredits }
    } catch {
      // Reset credits are an optional private endpoint, so a failure here
      // must not cost the caller its ordinary usage. The provider's own
      // message is not carried into the result: this string is rendered
      // in Settings, and a private endpoint echoing a token would put it
      // on screen. The consume path takes the same posture.
      return {
        ...result,
        resetCreditsError: 'the usage-limit reset lookup did not answer',
      }
    }
  }
  const adapter: CodexAdapter = new CodexAdapter({
    ...(deps.config.codexClientVersion === undefined
      ? {}
      : { clientVersion: deps.config.codexClientVersion }),
    resolveClientVersion: () => deps.codexVersion.resolve(),
    models: deps.catalog.codex,
    streamIdleTimeoutMs: deps.streamIdleTimeoutMs,
    rateLimit: deps.rateLimit,
    tokens,
    discovery: !deps.overridden.has('codex'),
    onWarn: deps.onWarn,
    resolveAttachments: deps.resolveAttachments,
    // Durable catalog: capability metadata (reasoning efforts) survives
    // restarts, so a resumed session's selected effort keeps resolving.
    catalogStore: catalogStore('codex'),
    accountCatalogStore: (account) => accountCatalogStore('codex', account),
    defaultEffortOf: (model: string) => defaultEffortOf('codex', model),
    contextWindowOf: (model) => deps.preferences.contextWindow(model),
    pool: deps.pool,
    speedFor: (sessionId, model): boolean | Promise<boolean> =>
      sessionId !== undefined &&
      deps.selectedSpeed(sessionId, model) === 'fast' &&
      adapter.supportsFastTier(model),
  })
  return {
    adapter,
    tokens: tokens as AccountTokenManager<StoredSession>,
    usage,
  }
}

/** Build the Claude subscription route. */
export function buildClaudeProvider(deps: ProviderBuildDeps): BuiltProvider {
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Claude (Subscription)',
    makeOptions: () => ({
      preemptMs: CLAUDE_PREEMPT_MS,
      // Only keychain-imported accounts sync with Claude Code's own
      // credential store; OAuth accounts refresh standalone so several
      // accounts never fight over the Keychain entry.
      refresh: (session) =>
        session.keychainBound === true
          ? refreshClaudeSynced(session, refreshClaude)
          : refreshClaude(session),
      isPermanent: isClaudePermanentRefreshError,
    }),
  })
  const usage: UsageFetcher = async (account, signal) =>
    fetchClaudeUsage(await tokens.session(account), hostFetch, signal, () =>
      deps.claudeVersion.resolve(),
    )
  const adapter = new ClaudeAdapter({
    models: deps.catalog.claude,
    streamIdleTimeoutMs: deps.streamIdleTimeoutMs,
    rateLimit: deps.rateLimit,
    tokens,
    discovery: !deps.overridden.has('claude'),
    onWarn: deps.onWarn,
    resolveAttachments: deps.resolveAttachments,
    catalogStore: catalogStore('claude'),
    defaultEffortOf: (model: string) => defaultEffortOf('claude', model),
    contextWindowOf: (model) => deps.preferences.contextWindow(model, 'claude'),
    resolveCliVersion: () => deps.claudeVersion.resolve(),
    promptCacheTtl: deps.claudePromptCacheTtl,
    // The Manage dialog's per-route override, re-read from the settings
    // store on every request so a save applies from the next turn.
    promptCacheTtlOverride: () => deps.preferences.promptCacheTtl(),
    pool: deps.pool,
  })
  return {
    adapter,
    tokens: tokens as AccountTokenManager<StoredSession>,
    usage,
  }
}

/** Build the Grok (X Premium) route. */
export function buildGrokProvider(deps: ProviderBuildDeps): BuiltProvider {
  const tokens = new AccountTokenManager<GrokSession>({
    provider: 'grok',
    displayName: 'Grok (Subscription)',
    makeOptions: () => ({
      preemptMs: GROK_PREEMPT_MS,
      refresh: refreshGrok,
      isPermanent: isGrokPermanentRefreshError,
    }),
  })
  const usage: UsageFetcher = async (account, signal) =>
    fetchGrokUsage(await tokens.session(account), hostFetch, signal)
  const adapter = new GrokAdapter({
    models: deps.catalog.grok,
    streamIdleTimeoutMs: deps.streamIdleTimeoutMs,
    rateLimit: deps.rateLimit,
    tokens,
    discovery: !deps.overridden.has('grok'),
    onWarn: deps.onWarn,
    resolveAttachments: deps.resolveAttachments,
    // Durable catalog: capability metadata (reasoning efforts) survives
    // restarts, so a resumed session's selected effort keeps resolving.
    catalogStore: catalogStore('grok'),
    defaultEffortOf: (model: string) => defaultEffortOf('grok', model),
    pool: deps.pool,
  })
  return {
    adapter,
    tokens: tokens as AccountTokenManager<StoredSession>,
    usage,
  }
}

/** Build the GitHub Copilot route. It has no usage endpoint. */
export function buildCopilotProvider(deps: ProviderBuildDeps): BuiltProvider {
  const tokens = new AccountTokenManager<CopilotSession>({
    provider: 'copilot',
    displayName: 'GitHub Copilot',
    makeOptions: () => ({
      preemptMs: COPILOT_PREEMPT_MS,
      refresh: refreshCopilot,
      isPermanent: isCopilotPermanentRefreshError,
    }),
  })
  const adapter = new CopilotAdapter({
    models: deps.catalog.copilot,
    streamIdleTimeoutMs: deps.streamIdleTimeoutMs,
    rateLimit: deps.rateLimit,
    tokens,
    discovery: !deps.overridden.has('copilot'),
    onWarn: deps.onWarn,
    resolveAttachments: deps.resolveAttachments,
    // Durable catalog: capability metadata (per-model vision support,
    // context windows) survives restarts and network failures.
    catalogStore: catalogStore('copilot'),
    defaultEffortOf: (model: string) => defaultEffortOf('copilot', model),
    pool: deps.pool,
  })
  return {
    adapter,
    tokens: tokens as AccountTokenManager<StoredSession>,
    // Dropped on every auth transition so replay state (captured reasoning)
    // never survives an account switch in memory.
    clearReplayState: () => adapter.clearReplayState(),
  }
}

/** Build the Google Antigravity route. */
export function buildAntigravityProvider(
  deps: ProviderBuildDeps,
): BuiltProvider {
  const tokens = new AccountTokenManager<AntigravitySession>({
    provider: 'antigravity',
    displayName: 'Google Antigravity',
    makeOptions: () => ({
      preemptMs: ANTIGRAVITY_PREEMPT_MS,
      refresh: (session) =>
        refreshAntigravity(
          session,
          resolveAntigravityOAuthConfig(deps.config.antigravity),
        ),
      isPermanent: isAntigravityPermanentRefreshError,
    }),
  })
  const usage: UsageFetcher = async (account, signal) =>
    fetchAntigravityUsage(
      await tokens.session(account),
      deps.config.antigravity,
      hostFetch,
      signal,
    )
  const adapter = new AntigravityAdapter({
    models: deps.catalog.antigravity,
    streamIdleTimeoutMs: deps.streamIdleTimeoutMs,
    rateLimit: deps.rateLimit,
    tokens,
    discovery: !deps.overridden.has('antigravity'),
    ...(deps.config.antigravity === undefined
      ? {}
      : { runtime: deps.config.antigravity }),
    onWarn: deps.onWarn,
    resolveAttachments: deps.resolveAttachments,
    catalogStore: catalogStore('antigravity'),
    defaultEffortOf: (model) => defaultEffortOf('antigravity', model),
    pool: deps.pool,
  })
  return {
    adapter,
    tokens: tokens as AccountTokenManager<StoredSession>,
    usage,
  }
}

/** One builder per route; the caller iterates the configured providers. */
export const PROVIDER_BUILDERS: Record<
  ProviderId,
  (deps: ProviderBuildDeps) => BuiltProvider
> = {
  codex: buildCodexProvider,
  claude: buildClaudeProvider,
  grok: buildGrokProvider,
  copilot: buildCopilotProvider,
  antigravity: buildAntigravityProvider,
}
