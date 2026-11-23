/**
 * The Cursor model manager's pure logic: what each row shows, what the filter
 * keeps, and what one edit writes.
 *
 * Everything here is a function of the host's rows and the reader's edits, so
 * the manager and a test agree on what the screen means without a browser.
 */

import type { SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { modelListState, type ModelListState } from './model-filter.js'

export type Translate = SubscriptionsSectionInjected['t']

/** Which source decided a row's window. */
export type CursorWindowSource = 'tier' | 'manual' | 'published' | 'default'

/** One model as the host resolves it. */
export interface CursorModelRowView {
  id: string
  name: string
  enabled: boolean
  /** Whether the catalog publishes any parameter or variant for it. */
  described: boolean
  /**
   * The window that applies without a stored override, and the source that
   * decided it.
   */
  window: { tokens: number; source: CursorWindowSource; tier?: string }
  /** Whether the row offers a manual override. */
  overridable: boolean
  /** Capacity the public catalog publishes, when it describes the model. */
  publishedWindow?: number
}

/** The manager's payload. */
export interface CursorModelsView {
  provider: 'cursor'
  models: CursorModelRowView[]
  knownContext: { enabled: boolean; fetchedAt?: number }
  /** Every stored per-model setting; a change sends this map back. */
  storedModels: CursorModelDraft
}

/** The stored edit for one model; an absent field is left alone. */
export interface CursorModelEdit {
  enabled?: boolean | undefined
  contextWindow?: number | undefined
}

/** The stored edits, keyed by model id. */
export type CursorModelDraft = Record<string, CursorModelEdit>

/** One row as the body renders it: the host's row after the reader's edits. */
export interface CursorRow {
  id: string
  name: string
  enabled: boolean
  described: boolean
  /** The window to show, which is the manual override while one is stored. */
  tokens: number
  source: CursorWindowSource
  tier?: string
  /** The published capacity a manual value replaced, when one did. */
  replaced?: number
  /** Whether the row offers the override control. */
  overridable: boolean
  /** Whether the manual field is open. */
  editing: boolean
  /** The field's text while it is open. */
  text: string
  /** The failure the row states after a failed write. */
  error?: string
}

/** How many rows are enabled, listed, and still on the default window. */
export interface CursorRowCounts {
  enabled: number
  total: number
  fallback: number
}

/**
 * One row's window after the reader's edits: a stored manual value wins over
 * the automatic one, so a saved override shows its own number and still names
 * what it replaced. A row the tier decides ignores a stored value, because the
 * provider applies the tier.
 * @param row - the host's row.
 * @param draft - the stored edits the page holds.
 * @returns the window to show and the source it came from.
 */
function editedWindow(
  row: CursorModelRowView,
  draft: CursorModelDraft,
): {
  tokens: number
  source: CursorWindowSource
  tier?: string
  replaced?: number
} {
  const manual = row.overridable ? draft[row.id]?.contextWindow : undefined
  if (manual === undefined) {
    return {
      tokens: row.window.tokens,
      source: row.window.source,
      ...(row.window.tier === undefined ? {} : { tier: row.window.tier }),
    }
  }
  // The published capacity is what a manual value most often replaces, and
  // naming it lets the reader see what the override costs.
  const replaced =
    row.window.source === 'published' ? row.window.tokens : row.publishedWindow
  return {
    tokens: manual,
    source: 'manual',
    ...(replaced === undefined ? {} : { replaced }),
  }
}

/**
 * Build the rows the body renders.
 * @param models - the host's rows.
 * @param draft - the stored edits the page holds, applied optimistically.
 * @param texts - the raw text of an open manual field, keyed by model id.
 * @param editing - the model whose field is open, when one is.
 * @param errors - the failure each row states, keyed by model id.
 * @returns one row per model.
 */
export function deriveRows(
  models: readonly CursorModelRowView[],
  draft: CursorModelDraft,
  texts: Readonly<Record<string, string>>,
  editing: string | undefined,
  errors: Readonly<Record<string, string>>,
): CursorRow[] {
  return models.map((model) => {
    const window = editedWindow(model, draft)
    const edit = draft[model.id]
    const error = errors[model.id]
    return {
      id: model.id,
      name: model.name,
      enabled: edit?.enabled ?? model.enabled,
      described: model.described,
      ...window,
      overridable: model.overridable,
      // Opening the field starts from the value in effect, so a reader who
      // overrides a capacity starts from the number they can see.
      editing: editing === model.id,
      text: texts[model.id] ?? String(window.tokens),
      ...(error === undefined ? {} : { error }),
    }
  })
}

/** The rows a filter query keeps, matched on name or id. */
export function filterRows(
  rows: readonly CursorRow[],
  query: string,
): CursorRow[] {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return [...rows]
  return rows.filter((row) =>
    `${row.name} ${row.id}`.toLowerCase().includes(wanted),
  )
}

/** The counts the summary and the capacity section state. */
export function rowCounts(rows: readonly CursorRow[]): CursorRowCounts {
  return {
    enabled: rows.filter((row) => row.enabled).length,
    total: rows.length,
    fallback: rows.filter((row) => row.source === 'default').length,
  }
}

/** Whether the list is loading, filtered to nothing, or showing rows. */
export function listStateFor(
  rows: readonly CursorRow[],
  matched: number,
): ModelListState {
  return modelListState(rows.length, matched)
}

/**
 * Parse a typed window into tokens. Only digits with optional grouping
 * separators are accepted, so a typo (`1m`, `1.5`, `-300000`) is refused
 * instead of coerced into a different number. An empty field clears the value.
 * @param text - what the reader typed.
 * @returns the token count, or null when the text is not a positive count and
 *   not empty.
 */
export function parseWindowInput(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^(?:\d+|\d{1,3}(?:[ ,]\d{3})+)$/.test(trimmed)) return null
  const value = Number(trimmed.replace(/[ ,]/g, ''))
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Exact multiples read as 1M or 300K; any other count keeps its digits. */
export function formatWindowLabel(tokens: number): string {
  if (tokens > 0 && tokens % 1_000_000 === 0) return tokens / 1_000_000 + 'M'
  if (tokens > 0 && tokens % 1_000 === 0) return tokens / 1_000 + 'K'
  return String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** The sentence naming where a window came from. */
export function windowSourceLabel(
  t: Translate,
  source: CursorWindowSource,
  tier?: string,
): string {
  if (source === 'tier')
    return t('cursorWindowTier', { tier: tier ?? '' }).trim()
  if (source === 'published') return t('cursorWindowPublished')
  if (source === 'manual') return t('cursorWindowManual')
  return t('cursorWindowDefault')
}

/**
 * The note a window carries: its source, plus what a manual value replaced.
 * @param t - translator.
 * @param row - the row to describe.
 * @returns the sentence the chip shows on hover and in its accessible name.
 */
export function windowNote(t: Translate, row: CursorRow): string {
  const source = windowSourceLabel(t, row.source, row.tier)
  if (row.source !== 'manual' || row.replaced === undefined) return source
  return (
    source +
    ' · ' +
    t('cursorWindowReplaces', {
      value: formatWindowLabel(row.replaced),
    })
  )
}

/**
 * One edit applied to the draft. Clearing the last field removes the entry, so
 * a model with nothing set is indistinguishable from one never touched.
 * @param draft - the edits the page holds.
 * @param id - the model the edit belongs to.
 * @param patch - fields to set; an undefined value clears one.
 * @returns the next draft.
 */
export function withModelEdit(
  draft: CursorModelDraft,
  id: string,
  patch: CursorModelEdit,
): CursorModelDraft {
  const next: CursorModelDraft = { ...draft }
  const entry: CursorModelEdit = { ...(next[id] ?? {}) }
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete entry[field as keyof CursorModelEdit]
    else (entry as Record<string, unknown>)[field] = value
  }
  if (Object.keys(entry).length > 0) next[id] = entry
  else delete next[id]
  return next
}
