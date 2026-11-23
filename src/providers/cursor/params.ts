/**
 * Cursor parameters: context tiers and DSH reasoning efforts as the values the
 * provider accepts.
 *
 * Everything works from the catalog's own parameter definitions, so a new model
 * or value needs no code change.
 */

import {
  defsOf,
  find,
  values,
  type CursorCatalogModel,
  type CursorParam,
  type CursorParamDef,
} from './catalog.js'

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

// `thinking` is Claude's on/off switch and must not be mistaken for the effort
// parameter.
function effortDef(defs: CursorParamDef[]): CursorParamDef | undefined {
  return find(defs, 'effort', 'reasoning_effort', 'reasoning')
}

/** Tokens of one tier value such as `300k` or `1m`; undefined for anything else. */
export function tierTokens(value: string): number | undefined {
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
    .map((value) => ({ value, tokens: tierTokens(value) ?? 0 }))
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
 * The tier to request for one model.
 *
 * The value Cursor already accepted for this model wins while the catalog still
 * offers it; otherwise the request carries the largest offered tier. Undefined
 * for a model that offers no tiers.
 *
 * @param model - the catalog entry.
 * @param accepted - a tier the provider accepted after a rejection.
 * @returns the offered tier value to send, or undefined.
 */
export function requestedTier(
  model: { cursorParameters?: unknown; parameters?: unknown } | undefined,
  accepted?: string,
): string | undefined {
  const offered = offeredContextValues(model)
  if (offered.length === 0) return undefined
  if (accepted !== undefined) {
    const acceptedValue = offeredTierValue(model, accepted)
    if (acceptedValue !== undefined) return acceptedValue
  }
  return offered[offered.length - 1]
}

/**
 * The exact offered spelling of one tier value, matched case-insensitively.
 * The request must carry the catalog's spelling, not the caller's, so request
 * and announcement cannot disagree about the tier.
 */
export function offeredTierValue(
  model: CursorCatalogModel | { parameters?: unknown } | undefined,
  value: string,
): string | undefined {
  const wanted = value.trim().toLowerCase()
  return offeredContextValues(model).find(
    (tier) => tier.toLowerCase() === wanted,
  )
}

/** Whether one model offers a tier value, matched case-insensitively. */
export function offersTier(
  model: CursorCatalogModel | { parameters?: unknown } | undefined,
  value: string,
): boolean {
  return offeredTierValue(model, value) !== undefined
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
  const size = current && tierTokens(current.value)
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
 *
 * @param model - the catalog entry the request names.
 * @param reasoning - DSH's selected effort, or `off`.
 * @param tier - the offered context tier the request carries, from
 *   {@link requestedTier}; absent for a model that offers none.
 */
export function modelParams(
  model: { cursorParameters?: unknown; parameters?: unknown } | undefined,
  reasoning: string | undefined,
  tier?: string | undefined,
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

  if (tier !== undefined) params.push({ id: 'context', value: tier })

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
