/**
 * Cursor's catalog as DSH model info, and DSH reasoning efforts as the
 * parameters Cursor accepts.
 *
 * Cursor describes each model with parameter definitions (`thinking`,
 * `effort`, `fast`, `context`, …) whose allowed values differ per model.
 * Everything here works from those definitions, so a new model or value needs
 * no code change.
 */

/** Route id owned by the Cursor adapter. Not a member of the OAuth `PROVIDER_IDS`. */
export const CURSOR_ROUTE = 'cursor'

/** Default credential reference naming the Cursor API key. */
export const DEFAULT_CURSOR_API_KEY_REF = 'CURSOR_API_KEY'

/** Context tier used when configuration names none: the largest offered. */
export const DEFAULT_CURSOR_CONTEXT = 'max'

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

/** Rank of the effort spellings Cursor uses, least to greatest. */
const LEVEL_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  'extra-high': 5,
  max: 6,
}

function values(def: CursorParamDef | undefined): string[] {
  return (def?.values ?? []).map((value) =>
    String(typeof value === 'object' ? value.value : value),
  )
}

function find(
  defs: CursorParamDef[],
  ...ids: string[]
): CursorParamDef | undefined {
  return defs.find((def) => ids.includes(def?.id))
}

// `thinking` is Claude's on/off switch and must not be mistaken for the effort
// parameter.
function effortDef(defs: CursorParamDef[]): CursorParamDef | undefined {
  return find(defs, 'effort', 'reasoning_effort', 'reasoning')
}

function defsOf(
  model: { cursorParameters?: unknown; parameters?: unknown } | undefined,
): CursorParamDef[] {
  const defs = model?.cursorParameters ?? model?.parameters
  return Array.isArray(defs) ? (defs as CursorParamDef[]) : []
}

/** Only `auto` is an alias; every other id goes to Cursor unchanged. */
export function resolveModelId(id: string): string {
  return id === 'auto' ? 'default' : id
}

function tokens(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim())
  return match
    ? Math.round(
        Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1e6 : 1e3),
      )
    : undefined
}

function tiers(
  def: CursorParamDef | undefined,
): { value: string; tokens: number }[] {
  return values(def)
    .map((value) => ({ value, tokens: tokens(value) ?? 0 }))
    .filter((tier) => tier.tokens > 0)
    .sort((a, b) => a.tokens - b.tokens)
}

/** Every context tier the model currently offers, smallest to largest. */
export function offeredContextValues(
  model: { cursorParameters?: unknown; parameters?: unknown } | undefined,
): string[] {
  return tiers(find(defsOf(model), 'context')).map((tier) => tier.value)
}

/**
 * The offered context tier a preference names. `max` (the default) selects the
 * largest tier; an exact tier such as `300k` selects itself; an unknown value
 * falls back to the largest, because the largest is what a reader expects from
 * an unset preference.
 */
export function preferredContext(
  def: CursorParamDef | undefined,
  preference = DEFAULT_CURSOR_CONTEXT,
): { value: string; tokens: number } | undefined {
  const all = tiers(def)
  if (all.length === 0) return undefined
  const want = preference.trim().toLowerCase()
  if (want === 'max') return all[all.length - 1]
  return (
    all.find((tier) => tier.value.toLowerCase() === want) ?? all[all.length - 1]
  )
}

/**
 * Cursor lists context tiers some accounts cannot use (`1m` on several Claude
 * models) and rejects the run. Returns `params` with the next smaller offered
 * tier, or undefined.
 */
export function smallerContext(
  model: { cursorParameters?: unknown; parameters?: unknown } | undefined,
  params: CursorParam[] | undefined,
): CursorParam[] | undefined {
  const current = params?.find((param) => param.id === 'context')
  const size = current && tokens(current.value)
  if (!size || !params) return undefined
  const next = tiers(find(defsOf(model), 'context'))
    .filter((tier) => tier.tokens < size)
    .pop()
  return next
    ? params.map((param) =>
        param.id === 'context' ? { id: param.id, value: next.value } : param,
      )
    : undefined
}

/** Whether Cursor's failure message says the chosen model parameters were rejected. */
export function isRejectedParams(message: unknown): boolean {
  return (
    typeof message === 'string' &&
    /invalid parameters for registry model/i.test(message)
  )
}

/** Cursor effort value for a level: exact match, else the nearest lower, else the lowest. */
export function effortFor(
  offered: string[],
  level: string,
): string | undefined {
  const target = LEVEL_RANK[level]
  if (target === undefined) return undefined
  const ranked = offered
    .filter((value) => value in LEVEL_RANK)
    .sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b])
  const exact = ranked.find((value) => LEVEL_RANK[value] === target)
  if (exact) return exact
  const usable = ranked.filter((value) => value !== 'none')
  return (
    usable.filter((value) => LEVEL_RANK[value] < target).pop() ??
    usable[0] ??
    ranked[0]
  )
}

/** Effort id for models whose only reasoning switch is `thinking` on/off. */
export const ON = 'on'

/**
 * Explicit Cursor parameters for one request. Without them Cursor picks its own
 * defaults, including Fast (priority pricing) and a smaller context than the
 * catalog offers.
 */
export function modelParams(
  model: { cursorParameters?: unknown; parameters?: unknown } | undefined,
  reasoning: string | undefined,
  contextPreference = DEFAULT_CURSOR_CONTEXT,
): CursorParam[] | undefined {
  const defs = defsOf(model)
  const params: CursorParam[] = []
  const off = !reasoning || reasoning === 'off'
  if (reasoning === ON) reasoning = 'high'

  const thinking = find(defs, 'thinking')
  if (thinking && values(thinking).includes(off ? 'false' : 'true')) {
    params.push({ id: thinking.id, value: off ? 'false' : 'true' })
  }

  const effort = effortDef(defs)
  if (effort) {
    const offered = values(effort)
    let value: string | undefined
    if (!off) value = effortFor(offered, reasoning!)
    else if (!thinking)
      value = offered.includes('none') ? 'none' : effortFor(offered, 'minimal')
    if (value) params.push({ id: effort.id, value })
  }

  const fast = find(defs, 'fast')
  if (fast && values(fast).includes('false')) {
    params.push({ id: fast.id, value: 'false' })
  }

  const context = preferredContext(find(defs, 'context'), contextPreference)
  if (context) params.push({ id: 'context', value: context.value })

  return params.length > 0 ? params : undefined
}

const EFFORT_NAMES: Record<string, string> = {
  off: 'Off',
  on: 'On',
  xhigh: 'Extra high',
  'extra-high': 'Extra high',
}

function effortName(id: string): string {
  return EFFORT_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * DSH reasoning efforts for a model, least to greatest: Cursor's own effort
 * values, with `off` when the model can turn reasoning off. Undefined for
 * models without reasoning parameters.
 */
export function reasoningInfo(
  model: { cursorParameters?: unknown; parameters?: unknown } | undefined,
):
  | { efforts: { id: string; name: string }[]; defaultEffort?: string }
  | undefined {
  const defs = defsOf(model)
  const thinking = find(defs, 'thinking')
  const offered = values(effortDef(defs))
    .filter((value) => value in LEVEL_RANK)
    .sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b])
  const canOff = offered.includes('none') || values(thinking).includes('false')
  const ids = offered.filter((value) => value !== 'none')
  if (ids.length === 0 && thinking) ids.push(ON)
  if (ids.length === 0) return undefined
  if (canOff) ids.unshift('off')
  const defaultEffort = ids.includes('high') ? 'high' : ids[ids.length - 1]
  return {
    efforts: ids.map((id) => ({ id, name: effortName(id) })),
    defaultEffort,
  }
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

/** Context window the route advertises for one model. */
export function contextWindowFor(
  model: { cursorParameters?: unknown; parameters?: unknown } | undefined,
  contextPreference = DEFAULT_CURSOR_CONTEXT,
): number {
  return (
    preferredContext(find(defsOf(model), 'context'), contextPreference)
      ?.tokens ?? 200_000
  )
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
