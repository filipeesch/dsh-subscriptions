/**
 * The durable Cursor catalog.
 *
 * The catalog is a cache: it seeds the route before a live read completes and
 * stands in when a live read fails, so it is validated strictly and a malformed
 * document reads as absent. The version guards a shape change rather than
 * repairing an old document in place.
 */

import { rm } from 'node:fs/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  loadJsonFile,
  serializeWrites,
  writeJsonFile,
} from '../../json-file.js'
import type { CatalogPersistence, CatalogSnapshot } from '../common.js'
import type { CursorCatalogModel, CursorParamDef } from './catalog.js'

/** Shape version of the stored catalog document. */
export const CURSOR_CATALOG_VERSION = 1

/** One stored catalog document. */
export interface CursorCatalogDocument {
  version: number
  at: number
  models: CursorCatalogModel[]
}

/** Absolute path of the stored Cursor catalog. */
export function cursorCatalogPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'cursor-catalog.json')
}

function sanitizeParam(value: unknown): CursorParamDef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { id?: unknown; values?: unknown }
  if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  if (raw.values === undefined) return { id: raw.id }
  if (!Array.isArray(raw.values)) return undefined
  const values: ({ value: string } | string)[] = []
  for (const entry of raw.values) {
    if (typeof entry === 'string') {
      values.push(entry)
      continue
    }
    if (typeof entry !== 'object' || entry === null) return undefined
    const candidate = (entry as { value?: unknown }).value
    if (typeof candidate !== 'string') return undefined
    values.push({ value: candidate })
  }
  return { id: raw.id, values }
}

function sanitizeModel(value: unknown): CursorCatalogModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as {
    id?: unknown
    displayName?: unknown
    parameters?: unknown
    variants?: unknown
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  if (raw.displayName !== undefined && typeof raw.displayName !== 'string')
    return undefined
  let parameters: CursorParamDef[] | undefined
  if (raw.parameters !== undefined) {
    if (!Array.isArray(raw.parameters)) return undefined
    const parsed: CursorParamDef[] = []
    for (const entry of raw.parameters) {
      const def = sanitizeParam(entry)
      if (def === undefined) return undefined
      parsed.push(def)
    }
    parameters = parsed
  }
  let variants: unknown[] | undefined
  if (raw.variants !== undefined) {
    if (!Array.isArray(raw.variants)) return undefined
    variants = raw.variants
  }
  return {
    id: raw.id,
    ...(raw.displayName === undefined
      ? {}
      : { displayName: raw.displayName as string }),
    ...(parameters === undefined ? {} : { parameters }),
    ...(variants === undefined ? {} : { variants }),
  }
}

/**
 * Validate one stored catalog document.
 * @param value - any parsed JSON value.
 * @returns the document, or undefined when it is unusable.
 */
export function parseCursorCatalogDocument(
  value: unknown,
): CursorCatalogDocument | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const raw = value as { version?: unknown; at?: unknown; models?: unknown }
  if (raw.version !== CURSOR_CATALOG_VERSION) return undefined
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at < 0)
    return undefined
  if (!Array.isArray(raw.models) || raw.models.length === 0) return undefined
  const models: CursorCatalogModel[] = []
  const seen = new Set<string>()
  for (const entry of raw.models) {
    const model = sanitizeModel(entry)
    if (model === undefined || seen.has(model.id)) return undefined
    seen.add(model.id)
    models.push(model)
  }
  return { version: CURSOR_CATALOG_VERSION, at: raw.at, models }
}

/** Load the stored catalog; absent or unusable reads as undefined. */
export async function loadCursorCatalog(
  path = cursorCatalogPath(),
): Promise<CursorCatalogDocument | undefined> {
  const loaded = await loadJsonFile(path)
  return loaded.kind === 'value'
    ? parseCursorCatalogDocument(loaded.value)
    : undefined
}

/** Persist the catalog, stamping the document shape. */
export function saveCursorCatalog(
  snapshot: CatalogSnapshot<CursorCatalogModel>,
  path = cursorCatalogPath(),
): Promise<void> {
  return serializeWrites(path, () =>
    writeJsonFile(path, {
      version: CURSOR_CATALOG_VERSION,
      at: snapshot.at,
      models: snapshot.models,
    }),
  )
}

/**
 * The durable half of the Cursor catalog cache.
 * @param path - store file path; defaults to {@link cursorCatalogPath}.
 * @returns the persistence hooks for {@link ModelCatalogCache}.
 */
export function cursorCatalogStore(
  path = cursorCatalogPath(),
): CatalogPersistence<CursorCatalogModel> {
  return {
    async load() {
      const document = await loadCursorCatalog(path)
      return document === undefined
        ? undefined
        : { at: document.at, models: document.models }
    },
    async save(snapshot) {
      await saveCursorCatalog(snapshot, path)
    },
    async clear() {
      // Queued with saves so a clear cannot land between a save's read and write.
      await serializeWrites(path, async () => {
        await rm(path, { force: true })
      })
    },
  }
}
