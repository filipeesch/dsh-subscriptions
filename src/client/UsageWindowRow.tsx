/**
 * One usage window as every card lists it: the label, the numbers the window
 * carries, and its meter.
 *
 * The cards used to carry their own copy of this row, which is why a monetary
 * window had numbers on some cards and a bare share on others, and why a
 * provider-named lane read as "Usage window · Extra usage" on the settings page
 * but as "Extra usage" on the Cursor card. One row and one label rule keep the
 * four surfaces stating the same thing.
 */

import type {
  SubscriptionsSectionInjected,
  UsageWindow,
} from './SubscriptionsSection.js'
import { subscriptionCardStyles } from './subscription-card-styles.js'
import { UsageMeter } from './UsageMeter.js'
import { useQuotaDisplayMode } from './usage-badge-preferences.js'
import { quotaText, useQuotaClock } from './quota-display.js'
import { formatMoney } from './money-format.js'
import type { UsageObservation } from './usage-pace.js'

type Translate = SubscriptionsSectionInjected['t']

/**
 * The row label of one window. A session or weekly window names its kind and,
 * when the window carries one, the model or lane it belongs to; a window of any
 * other kind is named by its lane alone, because a provider-named bucket is not
 * a "usage window" with a suffix — it is the lane.
 * @param t - section translate.
 * @param window - the reported window.
 * @returns the localized label.
 */
export function usageWindowLabel(t: Translate, window: UsageWindow): string {
  const named = window.scope !== undefined && window.scope !== ''
  if (window.kind === 'other') {
    if (window.scope === 'Monthly') return t('usageMonthly')
    return named ? window.scope! : t('usageWindow')
  }
  const base = window.kind === 'session' ? t('usageSession') : t('usageWeekly')
  return named ? `${base} · ${window.scope}` : base
}

/**
 * The numbers one row states: money when the window carries amounts, otherwise
 * the share the used-or-remaining preference selects, and "share unavailable"
 * when the window carries an amount but no ceiling to divide by.
 * @param t - section translate.
 * @param window - the reported window.
 * @param mode - used or remaining preference.
 * @returns the value text of the row.
 */
export function usageWindowValue(
  t: Translate,
  window: UsageWindow,
  mode: Parameters<typeof quotaText>[1],
): string {
  if (window.usedAmount !== undefined && window.currency !== undefined) {
    const used = formatMoney(window.usedAmount, window.currency)
    const limit =
      window.limitAmount === undefined
        ? ''
        : ` / ${formatMoney(window.limitAmount, window.currency)}`
    // Spend without a ceiling is a read amount with no proportion: the row
    // states the amount and says the share is unknown instead of leaving the
    // reader to infer it from a frameless meter. The remaining amount is shown
    // even at zero, so a full meter is not the only cue.
    const remaining =
      window.remainingAmount === undefined
        ? ''
        : ` · ${t('usageBarRemaining', {
            value: formatMoney(window.remainingAmount, window.currency),
          })}`
    const share =
      window.limitAmount === undefined
        ? ` · ${t('usageMeterShareUnavailable')}`
        : ''
    return `${used}${limit}${remaining}${share}`
  }
  if (window.usedAmount !== undefined) {
    // No currency from the provider: the numbers are still the reading, so they
    // are stated as plain amounts with the unit named as unknown.
    const plain = (minor: number): string => (minor / 100).toFixed(2)
    const limit =
      window.limitAmount === undefined ? '' : ` / ${plain(window.limitAmount)}`
    const remaining =
      window.remainingAmount === undefined
        ? ''
        : ` · ${t('usageBarRemaining', {
            value: plain(window.remainingAmount),
          })}`
    return `${plain(window.usedAmount)}${limit}${remaining} · ${t('usageCurrencyUnknown')}`
  }
  return quotaText(window.usedPercent, mode, t)
}

/**
 * One usage window row.
 * @param props.window - the reported window.
 * @param props.t - section translate.
 * @param props.observedAt - observation time of the reading, when known.
 * @param props.stale - the reading failed its last refresh.
 */
export function UsageWindowRow({
  window: quota,
  t,
  observedAt,
  stale,
}: {
  window: UsageWindow
  t: Translate
} & UsageObservation) {
  const mode = useQuotaDisplayMode()
  const now = useQuotaClock()
  const reset =
    quota.resetsAt === undefined
      ? ''
      : ` · ${t('usageResets', { date: new Date(quota.resetsAt).toLocaleString() })}`
  const expired =
    quota.resetsAt !== undefined && quota.resetsAt <= now
      ? ` · ${t('quotaExpiredWindow')}`
      : ''
  const staleNote = stale === true ? ` · ${t('usageMeterStale')}` : ''
  return (
    <div style={subscriptionCardStyles.usageRow}>
      <div style={subscriptionCardStyles.usageMeta}>
        <span>{usageWindowLabel(t, quota)}</span>
        <span>
          {usageWindowValue(t, quota, mode)}
          {reset}
          {expired}
          {staleNote}
        </span>
      </div>
      <UsageMeter window={quota} t={t} observedAt={observedAt} stale={stale} />
    </div>
  )
}
