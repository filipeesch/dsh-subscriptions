/**
 * The persisted projection of published model capacities.
 *
 * The document is a cache: a missing, unreadable, or malformed file reads as
 * absent, because the next successful refresh rewrites it. The version guards a
 * rules change, so a snapshot produced by another projection is discarded rather
 * than trusted for a day.
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  loadJsonFile,
  serializeWrites,
  writeJsonFile,
} from '../../json-file.js'
import {
  SNAPSHOT_VERSION,
  type PublishedContextSnapshot,
} from './published-context.js'

/** Absolute path of the projection document. */
export function publishedContextPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'cursor-context-windows.json')
}

/**
 * Validate one persisted projection.
 * @param value - any parsed JSON value.
 * @returns the snapshot, or undefined when it is unusable.
 */
export function parsePublishedContextSnapshot(
  value: unknown,
): PublishedContextSnapshot | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const raw = value as {
    version?: unknown
    fetchedAt?: unknown
    windows?: unknown
    ids?: unknown
  }
  if (raw.version !== SNAPSHOT_VERSION) return undefined
  if (
    typeof raw.fetchedAt !== 'number' ||
    !Number.isFinite(raw.fetchedAt) ||
    raw.fetchedAt < 0
  )
    return undefined
  if (
    typeof raw.windows !== 'object' ||
    raw.windows === null ||
    Array.isArray(raw.windows)
  )
    return undefined
  const windows: Record<string, number> = {}
  for (const [id, tokens] of Object.entries(
    raw.windows as Record<string, unknown>,
  )) {
    if (
      !id.trim() ||
      typeof tokens !== 'number' ||
      !Number.isSafeInteger(tokens) ||
      tokens <= 0
    )
      return undefined
    windows[id] = tokens
  }
  if (
    raw.ids !== undefined &&
    (!Array.isArray(raw.ids) ||
      raw.ids.some((id) => typeof id !== 'string' || !id.trim()))
  )
    return undefined
  return {
    version: SNAPSHOT_VERSION,
    fetchedAt: raw.fetchedAt,
    windows,
    // An older document has no recorded id set; its windows are what it knew.
    ids:
      raw.ids === undefined ? Object.keys(windows) : [...(raw.ids as string[])],
  }
}

/** Load the stored projection; absent or unusable reads as undefined. */
export async function loadPublishedContext(
  path = publishedContextPath(),
): Promise<PublishedContextSnapshot | undefined> {
  const loaded = await loadJsonFile(path)
  return loaded.kind === 'value'
    ? parsePublishedContextSnapshot(loaded.value)
    : undefined
}

/** Persist the projection, in call order with other writes to the same file. */
export function savePublishedContext(
  snapshot: PublishedContextSnapshot,
  path = publishedContextPath(),
): Promise<void> {
  return serializeWrites(path, () => writeJsonFile(path, snapshot))
}
