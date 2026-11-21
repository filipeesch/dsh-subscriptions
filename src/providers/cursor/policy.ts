/**
 * Per-model policy: the stored setting, then the configured baseline, then the
 * route default, resolved for one field at a time.
 *
 * The request, the announced window, and the model manager all read this same
 * resolution, so the host cannot meter one value while the page shows another.
 */

import type { CursorModelSettings, CursorSettings } from '../cursor-settings.js'
import { DEFAULT_CURSOR_CONTEXT } from './params.js'

/** One model's configured baseline. */
export interface CursorModelConfig {
  enabled?: boolean
  context?: string
}

/** What the plugin configuration may set for the route. */
export interface CursorConfigPolicy {
  context?: string
  contextWindows?: Record<string, unknown>
  models?: Record<string, CursorModelConfig>
  publishedContext?: boolean
}

function settingFor(
  settings: CursorSettings,
  modelId: string,
): CursorModelSettings | undefined {
  const models = settings.models
  return models !== undefined && Object.hasOwn(models, modelId)
    ? models[modelId]
    : undefined
}

/**
 * The tier preference for one model; the route-wide default when the field is
 * absent everywhere.
 */
export function contextPreferenceFor(
  settings: CursorSettings,
  config: CursorConfigPolicy | undefined,
  modelId?: string,
): string {
  if (modelId === undefined) return config?.context ?? DEFAULT_CURSOR_CONTEXT
  return (
    settingFor(settings, modelId)?.context ??
    config?.models?.[modelId]?.context ??
    config?.context ??
    DEFAULT_CURSOR_CONTEXT
  )
}

/** The manual window for one model, when settings or configuration name one. */
export function manualWindowFor(
  settings: CursorSettings,
  config: CursorConfigPolicy | undefined,
  modelId: string,
): number | undefined {
  const value =
    settingFor(settings, modelId)?.contextWindow ??
    config?.contextWindows?.[modelId]
  // An individual invalid entry is ignored; the resolver falls through to the
  // next source rather than rounding a typo into a different window.
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

/** Whether a model appears in the picker; absent everywhere means enabled. */
export function enabledFor(
  settings: CursorSettings,
  config: CursorConfigPolicy | undefined,
  modelId: string,
): boolean {
  return (
    settingFor(settings, modelId)?.enabled ??
    config?.models?.[modelId]?.enabled ??
    true
  )
}

/** Whether the models.dev projection may fetch; on unless turned off. */
export function publishedContextEnabled(
  settings: CursorSettings,
  config: CursorConfigPolicy | undefined,
): boolean {
  return settings.publishedContext ?? config?.publishedContext ?? true
}
