/**
 * Per-model policy: the stored setting, then the configured baseline, then the
 * route default, resolved for one field at a time.
 *
 * The request, the announced window, and the model manager all read this same
 * resolution, so the host cannot meter one value while the page shows another.
 */

import type { CursorModelSettings, CursorSettings } from '../cursor-settings.js'

/** One model's configured baseline. */
export interface CursorModelConfig {
  enabled?: boolean
}

/** What the plugin configuration may set for the route. */
export interface CursorConfigPolicy {
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
 * The configured window for one model, when the profile names a usable one.
 *
 * It is the baseline the stored setting overrides, and the manager's rows start
 * from it: the page owns the stored overrides, so a row states the value that
 * applies when the page stores none.
 */
export function configuredWindowFor(
  config: CursorConfigPolicy | undefined,
  modelId: string,
): number | undefined {
  const value = config?.contextWindows?.[modelId]
  // An individual invalid entry is ignored; the resolver falls through to the
  // next source rather than rounding a typo into a different window.
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

/** The manual window for one model: the stored value, else the configured one. */
export function manualWindowFor(
  settings: CursorSettings,
  config: CursorConfigPolicy | undefined,
  modelId: string,
): number | undefined {
  return (
    settingFor(settings, modelId)?.contextWindow ??
    configuredWindowFor(config, modelId)
  )
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
