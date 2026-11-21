import { useEffect, useId, useRef, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { subscriptionCardStyles as styles } from './subscription-card-styles.js'
import { providerSettingsCss } from './provider-settings-styles.js'

type Translate = SubscriptionsSectionInjected['t']

/** One model as the host resolves it for the manager. */
export interface CursorModelRowView {
  id: string
  name: string
  enabled: boolean
  described: boolean
  tierOverride?: string
  tierOptions: string[]
  window: {
    tokens: number
    source: 'tier' | 'published' | 'manual' | 'default'
    tier?: string
  }
  manualWindow: { editable: boolean; value: number }
  publishedWindow?: number
}

/** The stored edit for one model. */
export interface CursorModelEdit {
  enabled?: boolean | undefined
  context?: string | undefined
  contextWindow?: number | undefined
}

/** Stored edits keyed by model id. */
export type CursorModelDraft = Record<string, CursorModelEdit>

/** Everything the manager renders. */
export interface CursorModelsView {
  provider: 'cursor'
  context: string
  models: CursorModelRowView[]
  knownContext: { enabled: boolean; fetchedAt?: number }
  storedModels: CursorModelDraft
  publishedContext: boolean
}

/** The manager's pending edits, kept across a catalog Reload. */
export interface CursorManagerEdits {
  draft: CursorModelDraft
  texts: Record<string, string>
  invalid: string[]
}

/**
 * Edits after one catalog read. A Reload keeps what the user typed; the first
 * read seeds the draft from the stored document.
 */
export function mergedManagerState(
  force: boolean,
  previous: CursorManagerEdits | undefined,
  data: CursorModelsView,
): CursorManagerEdits {
  if (force && previous !== undefined) return previous
  return { draft: { ...data.storedModels }, texts: {}, invalid: [] }
}

/**
 * Parse a typed window into tokens. Only digits with optional grouping
 * separators are accepted, so a typo (`1m`, `1.5`, `-300000`) is refused
 * instead of coerced into a different number. An empty field clears the value.
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

/** The sentence naming where a resolved window came from. */
export function windowSourceLabel(
  t: Translate,
  source: CursorModelRowView['window']['source'],
  tier?: string,
): string {
  if (source === 'tier')
    return t('cursorWindowTier', { tier: tier ?? '' }).trim()
  if (source === 'published') return t('cursorWindowPublished')
  if (source === 'manual') return t('cursorWindowManual')
  return t('cursorWindowDefault')
}

/**
 * Build the models patch from every edited id: the union of draft entries and
 * typed window fields, so a window-only edit is never dropped.
 * @param draft - stored edits plus the user's edits.
 * @param texts - raw window input per model; absent means untouched.
 * @returns the patch and any model whose typed window is invalid.
 */
export function cursorModelsPatch(
  draft: CursorModelDraft,
  texts: Record<string, string>,
): { models: CursorModelDraft; invalid: string[] } {
  const models: CursorModelDraft = {}
  const invalid: string[] = []
  const ids = new Set([...Object.keys(draft), ...Object.keys(texts)])
  for (const id of ids) {
    const entry = draft[id] ?? {}
    const edit: CursorModelEdit = {}
    if (entry.enabled !== undefined) edit.enabled = entry.enabled
    if (entry.context !== undefined && entry.context !== '')
      edit.context = entry.context
    const text = texts[id]
    if (text === undefined) {
      if (entry.contextWindow !== undefined)
        edit.contextWindow = entry.contextWindow
    } else if (text.trim() !== '') {
      const tokens = parseWindowInput(text)
      if (tokens === null) invalid.push(id)
      else edit.contextWindow = tokens
    }
    if (Object.keys(edit).length > 0) models[id] = edit
  }
  return { models, invalid }
}

/** What the presentational half needs. */
export interface CursorModelsBodyProps {
  t: Translate
  models: readonly CursorModelRowView[]
  draft: CursorModelDraft
  texts: Record<string, string>
  invalid: readonly string[]
  disabled: boolean
  onToggle: (id: string, enabled: boolean) => void
  onTier: (id: string, value: string | undefined) => void
  onWindow: (id: string, text: string) => void
}

/** One row's tier choices, including preferences and a withdrawn tier value. */
export interface TierChoice {
  value: string
  kind: 'tier' | 'min' | 'max' | 'withdrawn'
}

export function tierChoices(row: CursorModelRowView): {
  options: TierChoice[]
} {
  const options: TierChoice[] = row.tierOptions.map((value) => ({
    value,
    kind: 'tier',
  }))
  // The context preference can be smallest/largest regardless of the wire
  // tiers the model offers; those are choices, not withdrawn values.
  for (const kind of ['min', 'max'] as const) {
    if (!options.some((option) => option.value === kind)) {
      options.push({ value: kind, kind })
    }
  }
  const override = row.tierOverride
  if (
    override !== undefined &&
    normalizeTierChoice(row, override) === undefined
  ) {
    options.push({ value: override, kind: 'withdrawn' })
  }
  return { options }
}

/**
 * The exact offered spelling (or preference) a stored value means. Matching is
 * case-insensitive, the same rule the runtime applies, so a stored `1M` selects
 * the offered `1m` instead of appearing withdrawn.
 */
export function normalizeTierChoice(
  row: CursorModelRowView,
  value: string,
): string | undefined {
  const wanted = value.trim().toLowerCase()
  if (wanted === 'min' || wanted === 'max') return wanted
  return row.tierOptions.find((tier) => tier.toLowerCase() === wanted)
}

/** The select's value: a pending edit wins, else the stored/config preference. */
export function tierSelectValue(
  row: CursorModelRowView,
  draft: CursorModelDraft,
): string {
  const edit = draft[row.id]
  // Only an explicit context field overrides the baseline; an enablement-only
  // edit leaves the tier the route would actually use on screen.
  if (edit?.context !== undefined) {
    // An empty string is an explicit clear: Save inherits the baseline again.
    if (edit.context === '') return ''
    return normalizeTierChoice(row, edit.context) ?? edit.context
  }
  const override = row.tierOverride
  if (override === undefined) return ''
  return normalizeTierChoice(row, override) ?? override
}

/** The option's label; the two preferences are named, not shown as wire values. */
export function tierOptionLabel(t: Translate, choice: TierChoice): string {
  if (choice.kind === 'min') return t('cursorModelContextMin')
  if (choice.kind === 'max') return t('cursorModelContextMax')
  if (choice.kind === 'withdrawn') {
    return choice.value + ' · ' + t('cursorModelTierWithdrawn')
  }
  return choice.value
}

function rowIds(id: string): { help: string; error: string } {
  return {
    help: 'cursor-window-help-' + id,
    error: 'cursor-window-error-' + id,
  }
}

/**
 * The manager's presentational half: one row per listed model with enablement,
 * the offered tier, and the window in effect or an editable manual value.
 */
export function CursorModelsBody(props: CursorModelsBodyProps) {
  const { t, models, draft, texts, invalid, disabled } = props
  if (models.length === 0)
    return <p className="dsh-subscription-hint">{t('cursorModelsEmpty')}</p>
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {models.map((row) => {
        const edit = draft[row.id]
        const contextProblem = invalid.includes(row.id)
        const ids = rowIds(row.id)
        const choices = tierChoices(row)
        return (
          <div
            key={row.id}
            style={{
              borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
              padding: '8px 2px',
              display: 'grid',
              gap: 8,
              minWidth: 0,
            }}
          >
            <label
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'baseline',
                gap: '2px 6px',
                overflowWrap: 'anywhere',
                minWidth: 0,
              }}
            >
              <input
                type="checkbox"
                checked={edit?.enabled ?? row.enabled}
                disabled={disabled}
                aria-label={t('cursorModelEnabled', { model: row.name })}
                onChange={(event) =>
                  props.onToggle(row.id, event.target.checked)
                }
              />{' '}
              {row.name} <span style={styles.status}>{row.id}</span>
              {!row.described && (
                <span style={styles.status}>
                  {' '}
                  · {t('cursorModelNotDescribed')}
                </span>
              )}
            </label>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                alignItems: 'center',
                minWidth: 0,
              }}
            >
              {(row.described ||
                row.tierOptions.length > 0 ||
                row.tierOverride !== undefined) &&
                choices.options.length > 0 && (
                  <label
                    style={{
                      display: 'flex',
                      gap: 4,
                      alignItems: 'center',
                      minWidth: 0,
                    }}
                  >
                    {t('cursorModelTier')}
                    <select
                      aria-label={t('cursorModelTierFor', { model: row.name })}
                      value={tierSelectValue(row, draft)}
                      disabled={disabled}
                      style={{ maxWidth: '100%', minWidth: 0 }}
                      onChange={(event) =>
                        // An empty choice is an explicit clear, kept in the draft
                        // so the control cannot fall back to the stored value.
                        props.onTier(row.id, event.target.value)
                      }
                    >
                      <option value="">{t('cursorModelAuto')}</option>
                      {choices.options.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {tierOptionLabel(t, choice)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              {row.manualWindow.editable ? (
                <label
                  style={{
                    display: 'flex',
                    gap: 4,
                    alignItems: 'center',
                    minWidth: 0,
                    flex: '1 1 220px',
                    flexWrap: 'wrap',
                  }}
                >
                  {t('cursorModelWindow')}
                  <input
                    style={{
                      flex: '0 0 130px',
                      minWidth: 110,
                      maxWidth: 200,
                    }}
                    inputMode="numeric"
                    aria-invalid={contextProblem}
                    aria-describedby={
                      contextProblem ? ids.help + ' ' + ids.error : ids.help
                    }
                    aria-label={t('cursorModelWindowFor', { model: row.name })}
                    value={
                      texts[row.id] ??
                      String(edit?.contextWindow ?? row.manualWindow.value)
                    }
                    disabled={disabled}
                    onChange={(event) =>
                      props.onWindow(row.id, event.target.value)
                    }
                  />
                  <span
                    id={ids.help}
                    style={{ ...styles.status, flexBasis: '100%' }}
                  >
                    {t('cursorModelWindowHint')}
                  </span>
                </label>
              ) : (
                <span>
                  {t('cursorModelWindow')}{' '}
                  {formatWindowLabel(row.window.tokens)} (
                  {windowSourceLabel(t, row.window.source, row.window.tier)})
                </span>
              )}
              {row.manualWindow.editable && (
                <span style={styles.status}>
                  {formatWindowLabel(row.window.tokens)} (
                  {windowSourceLabel(t, row.window.source, row.window.tier)})
                </span>
              )}
            </div>
            {contextProblem && (
              <p role="alert" id={ids.error}>
                {t('cursorWindowInvalid', { model: row.name })}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The manager dialog; one Save writes the whole models map. */
export function CursorModelsManager({
  rpc,
  t,
  onClose,
  onSaved,
}: {
  rpc: ConnectionHandle['rpc']
  t: Translate
  onClose: () => void
  onSaved: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const description = useId()
  const [view, setView] = useState<CursorModelsView>()
  const [edits, setEdits] = useState<CursorManagerEdits>({
    draft: {},
    texts: {},
    invalid: [],
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [reloadError, setReloadError] = useState('')
  const alive = useRef(true)
  const saveLock = useRef(false)

  useEffect(() => {
    alive.current = true
    const element = dialog.current!
    const previous = document.activeElement
    if (typeof element.showModal === 'function') element.showModal()
    return () => {
      alive.current = false
      if (typeof element.close === 'function') element.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus()
    }
  }, [])

  useEffect(() => {
    if (edits.invalid.length === 0) return
    dialog.current
      ?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')
      ?.focus()
  }, [edits.invalid])

  async function load(force: boolean) {
    setLoading(true)
    setError('')
    setReloadError('')
    try {
      const data = await callSubscriptionsAuth<CursorModelsView>(
        rpc,
        'cursorModels',
        force ? { force: true } : {},
      )
      if (!alive.current) return
      setView(data)
      setEdits((current) => mergedManagerState(force, current, data))
    } catch (failure) {
      if (!alive.current) return
      const text = t('cursorModelsLoadFailed', { message: message(failure) })
      // A failed Reload keeps the rows on screen and states the failure.
      if (force && view !== undefined) setReloadError(text)
      else setError(text)
    } finally {
      if (alive.current) setLoading(false)
    }
  }

  useEffect(() => {
    void load(false)
    // The dialog fetches once; Reload is the explicit refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on mount
  }, [])

  function edit(id: string, patch: CursorModelEdit): void {
    setEdits((current) => {
      const draft = { ...current.draft }
      const entry = { ...(draft[id] ?? {}), ...patch }
      for (const key of Object.keys(entry) as (keyof CursorModelEdit)[]) {
        // An empty context is an explicit clear and stays in the draft.
        if (entry[key] === undefined) delete entry[key]
      }
      if (Object.keys(entry).length > 0) draft[id] = entry
      else delete draft[id]
      return { ...current, draft }
    })
  }

  async function save(): Promise<void> {
    if (saveLock.current) return
    const built = cursorModelsPatch(edits.draft, edits.texts)
    setEdits((current) => ({ ...current, invalid: built.invalid }))
    if (built.invalid.length > 0) return
    saveLock.current = true
    setSaving(true)
    setSaveError('')
    try {
      await callSubscriptionsAuth(rpc, 'cursorSetSettings', {
        settings: { models: built.models },
      })
      if (alive.current) {
        onSaved()
        onClose()
      }
    } catch (failure) {
      if (alive.current)
        setSaveError(t('cursorModelsSaveFailed', { message: message(failure) }))
    } finally {
      saveLock.current = false
      if (alive.current) setSaving(false)
    }
  }

  return (
    <dialog
      className="dsh-subscription-manager"
      ref={dialog}
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={(event) => {
        if (saving) event.preventDefault()
      }}
      onClose={onClose}
      style={{
        width: 'min(640px, calc(100vw - 32px))',
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100dvh - 32px)',
        overflow: 'hidden',
      }}
    >
      <style>{providerSettingsCss}</style>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 20,
          maxHeight: 'calc(100dvh - 72px)',
          minWidth: 0,
        }}
      >
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <h2 id={title} style={{ margin: 0 }}>
            {t('cursorManageTitle')}
          </h2>
          <button type="button" autoFocus disabled={saving} onClick={onClose}>
            {t('imageClose')}
          </button>
        </header>
        <p id={description} className="dsh-subscription-hint">
          {t('cursorManageHint')}
        </p>
        {error !== '' && <p role="alert">{error}</p>}
        {reloadError !== '' && <p role="alert">{reloadError}</p>}
        {loading && view === undefined && (
          <p role="status" className="dsh-subscription-hint">
            {t('cursorModelsLoading')}
          </p>
        )}
        {view !== undefined && (
          <>
            <div style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
              <CursorModelsBody
                t={t}
                models={view.models}
                draft={edits.draft}
                texts={edits.texts}
                invalid={edits.invalid}
                disabled={saving}
                onToggle={(id, enabled) => edit(id, { enabled })}
                onTier={(id, context) => edit(id, { context })}
                onWindow={(id, text) =>
                  setEdits((current) => ({
                    ...current,
                    texts: { ...current.texts, [id]: text },
                  }))
                }
              />
            </div>
            {saveError !== '' && <p role="alert">{saveError}</p>}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                disabled={loading || saving}
                onClick={() => void load(true)}
              >
                {loading ? t('cursorModelsReloading') : t('cursorModelsReload')}
              </button>
              <button type="button" disabled={saving} onClick={onClose}>
                {t('cursorCancel')}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? t('cursorSaving') : t('cursorSave')}
              </button>
            </div>
          </>
        )}
        {view === undefined && !loading && (
          <button type="button" onClick={() => void load(false)}>
            {t('cursorModelsRetry')}
          </button>
        )}
      </div>
    </dialog>
  )
}
