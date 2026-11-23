/**
 * Durable, non-secret Cursor route configuration.
 *
 * The API key never appears here; the plugin config names its credential
 * reference. Stored values are the monthly ceiling an account without a
 * disclosed limit can set, per-model settings (enablement and manual window),
 * the context tier Cursor accepted per model after a rejection, and whether the
 * published-capacity source may fetch.
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  loadJsonFileSync,
  serializeWrites,
  writeJsonFile,
} from '../json-file.js'

/** Stored settings for one model. */
export interface CursorModelSettings {
  /** Whether the model appears in the picker; absent means enabled. */
  enabled?: boolean
  /** Manual advertised window in tokens; it outranks the published capacity. */
  contextWindow?: number
}

/** A tier Cursor accepted after rejecting the largest offered one. */
export interface CursorAcceptedTier {
  value: string
  /**
   * Written but never read. An older build requires this field, so keeping it
   * lets a rollback read the document instead of discarding every setting it
   * carries. {@link ACCEPTED_TIER_COMPAT_PREFERENCE} is the value written.
   */
  preference?: string
}

/**
 * The preference value stored beside an accepted tier.
 *
 * The route no longer has a tier preference: it always asks for the largest
 * offered tier. The field survives only for the rollback described on
 * {@link CursorAcceptedTier}.
 */
export const ACCEPTED_TIER_COMPAT_PREFERENCE = 'max'

/** Stored Cursor settings; every field is optional. */
export interface CursorSettings {
  /**
   * Monthly ceiling in US dollars. Used only when Cursor's response reports
   * spend without a limit, so a disclosed limit always wins.
   */
  monthlyCeilingUSD?: number
  /** Whether the models.dev projection may fetch; absent follows configuration. */
  publishedContext?: boolean
  /** Per-model overrides, keyed by model id. */
  models?: Record<string, CursorModelSettings>
  /** Remembered accepted tiers, keyed by model id. */
  acceptedTiers?: Record<string, CursorAcceptedTier>
}

/** The fields a settings patch may replace; every other field is preserved. */
export interface CursorSettingsPatch {
  models?: Record<string, CursorModelSettings>
  publishedContext?: boolean
}

/** Upper bound for a ceiling; a larger number is a typo, not a budget. */
export const MAX_CURSOR_CEILING_USD = 1_000_000

function fail(message: string): never {
  throw new Error(message)
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    fail(`${label} must be a positive integer`)
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    fail(`${label} must be a non-empty string`)
  return value.trim()
}

/**
 * Validate one stored document.
 * @param input - any parsed JSON value.
 * @returns the settings with unknown fields dropped.
 * @throws when the document is not an object or a known field is invalid; the
 *   store then degrades to defaults and keeps the file for recovery.
 */
export function validateCursorSettings(input: unknown): CursorSettings {
  const record = recordOf(input, 'settings')
  const settings: CursorSettings = {}
  if (record.monthlyCeilingUSD !== undefined) {
    const ceiling = record.monthlyCeilingUSD
    if (
      typeof ceiling !== 'number' ||
      !Number.isFinite(ceiling) ||
      ceiling <= 0 ||
      ceiling > MAX_CURSOR_CEILING_USD
    ) {
      fail(
        `monthlyCeilingUSD must be a positive number no larger than ${MAX_CURSOR_CEILING_USD}`,
      )
    }
    settings.monthlyCeilingUSD = ceiling
  }
  if (record.publishedContext !== undefined) {
    if (typeof record.publishedContext !== 'boolean')
      fail('publishedContext must be a boolean')
    settings.publishedContext = record.publishedContext
  }
  if (record.models !== undefined) {
    const models = recordOf(record.models, 'models')
    const out: Record<string, CursorModelSettings> = {}
    for (const [rawId, rawValue] of Object.entries(models)) {
      const id = rawId.trim()
      if (id.length === 0) fail('model ids must be non-empty')
      const model = recordOf(rawValue, `models[${id}]`)
      const parsed: CursorModelSettings = {}
      if (model.enabled !== undefined) {
        if (typeof model.enabled !== 'boolean')
          fail(`models[${id}].enabled must be a boolean`)
        parsed.enabled = model.enabled
      }
      if (model.contextWindow !== undefined) {
        parsed.contextWindow = positiveInteger(
          model.contextWindow,
          `models[${id}].contextWindow`,
        )
      }
      out[id] = parsed
    }
    settings.models = out
  }
  if (record.acceptedTiers !== undefined) {
    const tiers = recordOf(record.acceptedTiers, 'acceptedTiers')
    const out: Record<string, CursorAcceptedTier> = {}
    for (const [rawId, rawValue] of Object.entries(tiers)) {
      const id = rawId.trim()
      if (id.length === 0) fail('model ids must be non-empty')
      const tier = recordOf(rawValue, `acceptedTiers[${id}]`)
      const parsed: CursorAcceptedTier = {
        value: nonEmptyString(tier.value, `acceptedTiers[${id}].value`),
      }
      // A document written by an older build carries the preference; the route
      // no longer reads it, but reading it back keeps the field in the document.
      if (tier.preference !== undefined) {
        parsed.preference = nonEmptyString(
          tier.preference,
          `acceptedTiers[${id}].preference`,
        )
      }
      out[id] = parsed
    }
    settings.acceptedTiers = out
  }
  return settings
}

/**
 * Cursor settings under the DSH home directory. Writes are serialized and
 * atomic, so a crash never leaves a half-written document and a concurrent
 * writer cannot lose an earlier save.
 */
export class CursorSettingsStore {
  private current: CursorSettings = {}
  /** Set when the stored file existed but was unreadable or invalid. */
  private corrupt: string | undefined
  /** A learned tier the running turn must see before its write settles. */
  private readonly pendingTiers = new Map<string, CursorAcceptedTier>()

  constructor(
    readonly path = dshHomePath(
      'plugins',
      'subscriptions',
      'cursor-settings.json',
    ),
    private readonly onCorrupt?: (message: string) => void,
  ) {
    const loaded = loadJsonFileSync(path)
    if (loaded.kind === 'missing') return
    // A broken file must not take the whole plugin down: degrade to defaults,
    // keep the file untouched for manual recovery, and let the next save
    // overwrite it.
    try {
      if (loaded.kind === 'invalid') throw loaded.error
      this.current = validateCursorSettings(loaded.value)
    } catch (error) {
      this.corrupt = error instanceof Error ? error.message : String(error)
      this.onCorrupt?.(
        `Cursor settings at ${path} are unreadable and ignored; defaults serve until the next save.`,
      )
    }
  }

  /** Why the stored file is ignored, when it is. */
  corruption(): string | undefined {
    return this.corrupt
  }

  get(): CursorSettings {
    return structuredClone(this.current)
  }

  /** The configured ceiling, or undefined to use only what the API reports. */
  ceilingUSD(): number | undefined {
    return this.current.monthlyCeilingUSD
  }

  /** The published-capacity switch, when the settings carry one. */
  publishedContext(): boolean | undefined {
    return this.current.publishedContext
  }

  /** One model's stored settings, when it has an entry. */
  modelSettings(modelId: string): CursorModelSettings | undefined {
    const models = this.current.models
    return models !== undefined && Object.hasOwn(models, modelId)
      ? structuredClone(models[modelId] as CursorModelSettings)
      : undefined
  }

  /**
   * The tier Cursor accepted for one model after a rejection, when one is
   * remembered. Whether the catalog still offers it is the caller's question:
   * the store has no catalog.
   */
  acceptedTier(modelId: string): string | undefined {
    const pending = this.pendingTiers.get(modelId)
    if (pending !== undefined) return pending.value
    const tiers = this.current.acceptedTiers
    if (tiers === undefined || !Object.hasOwn(tiers, modelId)) return undefined
    return (tiers[modelId] as CursorAcceptedTier).value
  }

  /**
   * Remember a tier the provider accepted after a rejection. The record is
   * visible to the running turn at once through a memory overlay, while the
   * document itself only changes after the write succeeds.
   */
  rememberAcceptedTier(modelId: string, value: string): Promise<void> {
    const record: CursorAcceptedTier = {
      value,
      preference: ACCEPTED_TIER_COMPAT_PREFERENCE,
    }
    this.pendingTiers.set(modelId, record)
    const write = this.update((current) => ({
      ...current,
      acceptedTiers: {
        ...(current.acceptedTiers ?? {}),
        [modelId]: record,
      },
    }))
    // The overlay retires once the record is durable, or when a newer record
    // replaced it while the write was queued.
    void write.then(
      () => {
        if (this.pendingTiers.get(modelId) === record) {
          this.pendingTiers.delete(modelId)
        }
      },
      () => undefined,
    )
    return write
  }

  /** Drop a remembered tier that no longer applies. */
  forgetAcceptedTier(modelId: string): Promise<void> {
    this.pendingTiers.delete(modelId)
    return this.update((current) => {
      const tiers = current.acceptedTiers
      if (tiers === undefined || !Object.hasOwn(tiers, modelId)) return current
      const next = { ...tiers }
      delete next[modelId]
      return { ...current, acceptedTiers: next }
    })
  }

  /**
   * Drop one remembered tier only when it still is the record the caller saw.
   * A newer concurrent record survives, so pruning cannot undo a fresh result.
   */
  forgetAcceptedTierIf(
    modelId: string,
    expected: { value: string },
  ): Promise<void> {
    const pending = this.pendingTiers.get(modelId)
    if (pending !== undefined && pending.value === expected.value) {
      this.pendingTiers.delete(modelId)
    }
    return this.update((current) => {
      const entry = current.acceptedTiers?.[modelId]
      if (entry === undefined || entry.value !== expected.value) return current
      const next = { ...(current.acceptedTiers ?? {}) }
      delete next[modelId]
      return { ...current, acceptedTiers: next }
    })
  }

  /** Replace the stored document. */
  set(input: unknown): Promise<void> {
    return this.update(() => input)
  }

  /** Keep the rest of the document while the ceiling changes. */
  setCeiling(ceilingUSD: number | undefined): Promise<void> {
    return this.update((current) => {
      const next = { ...current }
      if (ceilingUSD === undefined) delete next.monthlyCeilingUSD
      else next.monthlyCeilingUSD = ceilingUSD
      return next
    })
  }

  /**
   * Merge one settings patch into the document. Running inside the store keeps
   * a concurrent ceiling save or learned tier from being overwritten by a
   * stale read-modify-write in the caller.
   */
  merge(patch: CursorSettingsPatch): Promise<void> {
    return this.update((current) => ({
      ...current,
      ...(patch.models === undefined ? {} : { models: patch.models }),
      ...(patch.publishedContext === undefined
        ? {}
        : { publishedContext: patch.publishedContext }),
    }))
  }

  /**
   * Apply one mutation and commit it: the new document serves readers only
   * after the write succeeds, so a failed user save changes nothing and cannot
   * leak into a later save.
   */
  private update(mutate: (current: CursorSettings) => unknown): Promise<void> {
    return serializeWrites(this.path, async () => {
      const validated = validateCursorSettings(
        mutate(structuredClone(this.current)),
      )
      await writeJsonFile(this.path, validated, { mode: 0o600 })
      this.current = validated
      this.corrupt = undefined
    })
  }
}
