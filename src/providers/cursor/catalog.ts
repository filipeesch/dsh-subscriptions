/**
 * Cursor's catalog as data: the entry shape, parameter parsing, display names,
 * and the built-in list shown before a live read.
 *
 * Cursor describes each model with parameter definitions (`thinking`,
 * `effort`, `fast`, `context`, …) whose allowed values differ per model.
 * Everything here reads those definitions, so a new model or value needs no
 * code change.
 */

/** One parameter definition from Cursor's catalog. */
export interface CursorParamDef {
  id: string
  values?: ({ value: string } | string)[]
}

/** One parameter sent with a request. */
export interface CursorParam {
  id: string
  value: string
}

/** One catalog entry Cursor reports for the account. */
export interface CursorCatalogModel {
  id: string
  displayName?: string
  parameters?: CursorParamDef[]
  variants?: unknown[]
}

/** The offered values of one definition, in catalog order. */
export function values(def: CursorParamDef | undefined): string[] {
  return (def?.values ?? []).map((value) =>
    String(typeof value === 'object' ? value.value : value),
  )
}

/** The first definition matching one of the ids. */
export function find(
  defs: CursorParamDef[],
  ...ids: string[]
): CursorParamDef | undefined {
  return defs.find((def) => ids.includes(def?.id))
}

/** The parameter definitions a catalog entry (or a request's model) carries. */
export function defsOf(
  model: { cursorParameters?: unknown; parameters?: unknown } | undefined,
): CursorParamDef[] {
  const defs = model?.cursorParameters ?? model?.parameters
  return Array.isArray(defs) ? (defs as CursorParamDef[]) : []
}

/** Only `auto` is an alias; every other id goes to Cursor unchanged. */
export function resolveModelId(id: string): string {
  return id === 'auto' ? 'default' : id
}

/**
 * Display name per model id. Names Cursor shares across models (`default` and
 * `auto-smart` are both "Auto") get the id appended.
 */
export function modelNames(
  models: readonly CursorCatalogModel[],
): Map<string, string> {
  const base = (model: CursorCatalogModel) => model.displayName || model.id
  const count = new Map<string, number>()
  for (const model of models) {
    count.set(base(model), (count.get(base(model)) ?? 0) + 1)
  }
  return new Map(
    models.map((model) => [
      model.id,
      (count.get(base(model)) ?? 0) > 1
        ? `${base(model)} (${model.id})`
        : base(model),
    ]),
  )
}

/**
 * The catalog fields the host picker consumes: each model id, display name,
 * and its parameter definitions (which carry the reasoning efforts).
 */
export function catalogSignature(
  models: readonly CursorCatalogModel[],
): string {
  return JSON.stringify(
    models.map((model) => [
      model.id,
      model.displayName ?? '',
      model.parameters ?? [],
      model.variants?.length ?? 0,
    ]),
  )
}

/** Whether two live catalog reads list the same ids, ignoring order. */
export function sameModelIds(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false
  const left = new Set(a)
  return b.every((id) => left.has(id))
}

/** Shown until the live catalog loads (no key yet, or offline). */
export const FALLBACK_MODELS: CursorCatalogModel[] = [
  { id: 'default', displayName: 'Cursor Default' },
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
  { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon' },
]
