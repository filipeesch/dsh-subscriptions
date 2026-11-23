import type {
  CatalogPersistence,
  CatalogSnapshot,
} from '../src/providers/common.js'
import type { CursorCatalogModel } from '../src/providers/cursor/catalog.js'

/**
 * In-memory catalog persistence for specs.
 *
 * The adapter writes through to its durable catalog, so a spec that injects no
 * persistence would read and overwrite the real DSH home. Every adapter built in
 * a spec passes this instead, unless the test is about the durable store itself.
 */
export function memoryCatalogStore(): CatalogPersistence<CursorCatalogModel> {
  let snapshot: CatalogSnapshot<CursorCatalogModel> | undefined
  return {
    async load() {
      return snapshot
    },
    async save(next) {
      snapshot = { at: next.at, models: [...next.models] }
    },
    async clear() {
      snapshot = undefined
    },
  }
}

/** The three runtime hooks one in-memory tier store provides. */
export interface MemoryTierStore {
  /** What the runtime and resolution see for one model. */
  acceptedTier: (modelId: string) => string | undefined
  rememberAcceptedTier: (modelId: string, value: string) => void
  forgetAcceptedTier: (modelId: string, expected?: { value: string }) => void
}

/**
 * In-memory accepted-tier store for specs, matching what the durable settings
 * store exposes to the runtime and to model resolution.
 */
export function memoryTierStore(): MemoryTierStore {
  const tiers = new Map<string, string>()
  return {
    acceptedTier(modelId) {
      return tiers.get(modelId)
    },
    rememberAcceptedTier(modelId, value) {
      tiers.set(modelId, value)
    },
    forgetAcceptedTier(modelId, expected) {
      if (expected !== undefined && tiers.get(modelId) !== expected.value) {
        return
      }
      tiers.delete(modelId)
    },
  }
}
