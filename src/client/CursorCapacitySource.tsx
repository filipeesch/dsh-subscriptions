/**
 * The published-capacity source's surface.
 *
 * `CursorSourceLine` is the card's one-line state; `CursorCapacitySection` is
 * the manager's section, which holds the controls next to the windows they
 * affect. Both are presentational, so a test renders them without a host.
 */

import type { Translate } from './cursor-manager-derive.js'

/** A date the current UI language can read unambiguously. */
export function formatRefreshTime(fetchedAt: number, locale?: string): string {
  const language =
    locale ??
    (typeof navigator === 'undefined' ? 'en' : navigator.language) ??
    'en'
  try {
    return new Intl.DateTimeFormat(language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(fetchedAt)
  } catch {
    return new Date(fetchedAt).toISOString()
  }
}

/** Whether the source refreshed, or when it never did. */
function freshness(
  t: Translate,
  fetchedAt: number | undefined,
  locale?: string,
): string {
  return fetchedAt === undefined
    ? t('cursorSourceNever')
    : t('cursorSourceUpdated', { date: formatRefreshTime(fetchedAt, locale) })
}

/** The card's one line: whether capacities are automatic, and their age. */
export function CursorSourceLine({
  t,
  enabled,
  fetchedAt,
  locale,
}: {
  t: Translate
  enabled: boolean
  fetchedAt?: number
  locale?: string
}) {
  const state = enabled ? t('cursorSourceOn') : t('cursorSourceOff')
  return (
    <p className="dsh-subscription-hint" role="status">
      {state} · {freshness(t, fetchedAt, locale)}
    </p>
  )
}

/** The manager's section: the state, the two controls, and the fallback count. */
export function CursorCapacitySection({
  t,
  enabled,
  fetchedAt,
  busy,
  fallback,
  total,
  error,
  notice,
  onRefresh,
  onToggle,
  locale,
}: {
  t: Translate
  enabled: boolean
  fetchedAt?: number
  busy: boolean
  /** How many listed models still advertise the default window. */
  fallback: number
  total: number
  /** A refresh or switch failure, already translated. */
  error?: string
  /** A refresh outcome worth stating, already translated. */
  notice?: string
  onRefresh: () => void
  onToggle: (enabled: boolean) => void
  locale?: string
}) {
  return (
    <section className="dsh-cursor-section">
      <h3 style={{ margin: 0 }}>{t('cursorCapacityTitle')}</h3>
      <p className="dsh-subscription-hint">
        {enabled ? t('cursorCapacityOn') : t('cursorCapacityOff')}
      </p>
      <p className="dsh-subscription-hint" role="status">
        {enabled ? t('cursorSourceOn') : t('cursorSourceOff')} ·{' '}
        {freshness(t, fetchedAt, locale)}
      </p>
      <p className="dsh-subscription-hint">
        {fallback === 0
          ? t('cursorCapacityAllDescribed')
          : t('cursorCapacityFallback', { count: fallback, total })}
      </p>
      <div className="dsh-cursor-section-actions">
        <button type="button" disabled={busy || !enabled} onClick={onRefresh}>
          {busy ? t('cursorCapacityRefreshing') : t('cursorCapacityRefresh')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle(!enabled)}
        >
          {enabled ? t('cursorCapacityDisable') : t('cursorCapacityEnable')}
        </button>
      </div>
      {notice !== undefined && (
        <p className="dsh-subscription-hint" role="status">
          {notice}
        </p>
      )}
      {error !== undefined && <p role="alert">{error}</p>}
    </section>
  )
}
