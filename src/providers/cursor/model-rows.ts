/**
 * Model rows for the Cursor card's manager.
 *
 * Everything the page shows comes from the same resolution the request and the
 * announced window use, so the number a reader edits is the number the host
 * meters. A row states the window that applies when the page stores no override
 * — its tier, the configured baseline, the published capacity, or the default —
 * and the page owns the stored overrides it sends back. Pure data, so the host
 * half and a test can build it without a browser.
 */

import type { CursorSettings } from '../cursor-settings.js'
import { defsOf, modelNames, type CursorCatalogModel } from './catalog.js'
import {
  resolveContextWindow,
  type ContextWindowResolution,
} from './context-window.js'
import { requestedTier } from './params.js'
import { configuredWindowFor, type CursorConfigPolicy } from './policy.js'

/** One model as the manager renders it. */
export interface CursorModelRow {
  id: string
  name: string
  enabled: boolean
  /** Whether the catalog publishes any parameter or variant for it. */
  described: boolean
  /**
   * The window that applies without a stored override, and the source that
   * decided it. The page replaces the number when it stores one.
   */
  window: ContextWindowResolution
  /** Whether the row offers a manual override; false when the tier decides. */
  overridable: boolean
  /** Capacity the public catalog publishes, when it describes the model. */
  publishedWindow?: number
}

/** What building the rows reads. */
export interface CursorModelRowSources {
  models: readonly CursorCatalogModel[]
  settings: CursorSettings
  config: CursorConfigPolicy | undefined
  /** Published capacity per model id, when the projection describes it. */
  publishedWindow: (modelId: string) => number | undefined
}

/**
 * Build the rows for one catalog and policy snapshot.
 *
 * The stored per-model settings are not folded in: the page holds them and
 * sends them back, so a row states the baseline that survives when the page
 * clears an override. A stored tier is still read here, because it is what the
 * next request will carry.
 * @param sources - catalog, settings, configuration, and the projection.
 * @returns one row per listed model, in catalog order.
 */
export function buildCursorModelRows(
  sources: CursorModelRowSources,
): CursorModelRow[] {
  const { models, settings, config, publishedWindow } = sources
  const names = modelNames(models)
  return models.map((model) => {
    const stored = settings.models?.[model.id]
    const configured = config?.models?.[model.id]
    const accepted = settings.acceptedTiers?.[model.id]?.value
    const published = publishedWindow(model.id)
    const configuredWindow = configuredWindowFor(config, model.id)
    const window = resolveContextWindow({
      model,
      tier: requestedTier(model, accepted),
      ...(published === undefined ? {} : { publishedWindow: published }),
      ...(configuredWindow === undefined
        ? {}
        : { manualWindow: configuredWindow }),
    })
    return {
      id: model.id,
      name: names.get(model.id) ?? model.id,
      enabled: stored?.enabled ?? configured?.enabled ?? true,
      described: defsOf(model).length > 0 || (model.variants?.length ?? 0) > 0,
      window,
      // A tier row has nothing to override: the provider applies the tier.
      overridable: window.source !== 'tier',
      ...(published === undefined ? {} : { publishedWindow: published }),
    }
  })
}
