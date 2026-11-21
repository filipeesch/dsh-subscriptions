/**
 * The context window the route advertises to the host.
 *
 * The host meters this number: DSH prices compaction from it, so announcing a
 * window smaller than the provider applies forces premature compaction, and a
 * larger one lets a request overflow. Resolution therefore follows what the
 * provider will actually use: the tier the request carries, then the capacity
 * the public catalog publishes, then a manual per-model value, then the
 * documented default.
 */

import {
  DEFAULT_CURSOR_CONTEXT,
  contextTierValue,
  offersTier,
  tierTokens,
} from './params.js'

/** Advertised when nothing describes a model; Cursor documents it as a default. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Which source decided the advertised window. */
export type ContextWindowSource = 'tier' | 'published' | 'manual' | 'default'

/** One resolved window and the fact it came from. */
export interface ContextWindowResolution {
  tokens: number
  source: ContextWindowSource
  /** The tier value the window came from, when the source is the provider's tier. */
  tier?: string
}

/** Everything one resolution reads. */
export interface ContextWindowInput {
  /** The catalog entry the request names; absent when the catalog does not list it. */
  model?: { cursorParameters?: unknown; parameters?: unknown } | undefined
  /** The offered tier the request will carry, when the model offers one. */
  tier?: string | undefined
  /** Capacity the public catalog publishes for this model, when it describes it. */
  publishedWindow?: number | undefined
  /** Manual per-model window; settings already won over configuration. */
  manualWindow?: number | undefined
}

/** Whether a value can be advertised as a token count, unchanged. */
function usableTokens(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Resolve the advertised window for one model.
 * @param input - catalog entry, request tier, published capacity, and manual value.
 * @returns the window in tokens plus the source that decided it.
 */
export function resolveContextWindow(
  input: ContextWindowInput,
): ContextWindowResolution {
  const { model, tier, publishedWindow, manualWindow } = input
  const tierValue = tier?.trim()
  if (tierValue && offersTier(model, tierValue)) {
    const tokens = tierTokens(tierValue)
    if (tokens !== undefined) return { tokens, source: 'tier', tier: tierValue }
  }
  if (usableTokens(publishedWindow)) {
    return { tokens: publishedWindow, source: 'published' }
  }
  if (usableTokens(manualWindow)) {
    return { tokens: manualWindow, source: 'manual' }
  }
  return { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' }
}

/**
 * The tier a model requests for one preference, or undefined when it offers
 * none.
 * @param model - the catalog entry.
 * @param preference - the configured tier preference.
 * @returns the offered value the request carries.
 */
export function requestedTier(
  model: { cursorParameters?: unknown; parameters?: unknown } | undefined,
  preference = DEFAULT_CURSOR_CONTEXT,
): string | undefined {
  return contextTierValue(model, undefined, preference)
}

/** Context window the route advertises for one model and one preference. */
export function contextWindowFor(
  model: { cursorParameters?: unknown; parameters?: unknown } | undefined,
  contextPreference = DEFAULT_CURSOR_CONTEXT,
): number {
  return resolveContextWindow({
    model,
    tier: requestedTier(model, contextPreference),
  }).tokens
}
