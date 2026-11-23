/**
 * Model rows for the Cursor card's manager.
 *
 * Everything the page shows comes from the same resolution the request and the
 * announced window use, so the number a reader edits is the number the host
 * meters. Pure data, so the host half and a test can build it without a browser.
 */

import type { CursorSettings } from '../cursor-settings.js'
import { defsOf, modelNames, type CursorCatalogModel } from './catalog.js'
import {
  resolveContextWindow,
  type ContextWindowResolution,
} from './context-window.js'
import { requestedTier } from './params.js'
import { manualWindowFor, type CursorConfigPolicy } from './policy.js'

/** One model as the manager renders it. */
export interface CursorModelRow {
  id: string
  name: string
  enabled: boolean
  /** Whether the catalog publishes any parameter or variant for it. */
  described: boolean
  /** The window in effect and the source that decided it. */
  window: ContextWindowResolution
  /** Whether the row offers a manual override; false when the tier decides. */
  overridable: boolean
  /**
   * The manual field's starting value: the stored override, else the window in
   * effect, so a model nothing describes still shows a number to start from.
   */
  manualValue: number
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
    const manual = manualWindowFor(settings, config, model.id)
    const window = resolveContextWindow({
      model,
      tier: requestedTier(model, accepted),
      ...(published === undefined ? {} : { publishedWindow: published }),
      ...(manual === undefined ? {} : { manualWindow: manual }),
    })
    return {
      id: model.id,
      name: names.get(model.id) ?? model.id,
      enabled: stored?.enabled ?? configured?.enabled ?? true,
      described: defsOf(model).length > 0 || (model.variants?.length ?? 0) > 0,
      window,
      // A tier row has nothing to override: the provider applies the tier.
      overridable: window.source !== 'tier',
      manualValue: manual ?? window.tokens,
      ...(published === undefined ? {} : { publishedWindow: published }),
    }
  })
}
