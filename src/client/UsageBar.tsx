/**
 * The always-visible quota bar and the hover text that explains it.
 *
 * The bar carries no numbers: the fill and its color describe usage, and the
 * numbers live in the native tooltip (and in the full dialog behind a click).
 * A window that reports money states the amount used, the ceiling, and what is
 * left; a percentage window states the used and remaining shares.
 */

import type {
  SubscriptionsSectionInjected,
  UsageWindow,
} from './SubscriptionsSection.js'
import { formatMoney } from './money-format.js'
import { quotaPercent } from './quota-display.js'
import type { QuotaDisplayMode } from './usage-badge-preferences.js'
import { useQuotaDisplayMode } from './usage-badge-preferences.js'
import {
  displayStartPercent,
  elapsedPercent,
  isUsageFresh,
  usageBarColor,
  usageColorState,
  validUsage,
} from './usage-pace.js'
import { useUsageColorPreset } from './usage-color-preferences.js'
import type { UsageObservation } from './usage-pace.js'

type Translate = SubscriptionsSectionInjected['t']

/** Whether the window reports money rather than only a percentage. */
export function hasMoney(window: UsageWindow): boolean {
  return window.usedAmount !== undefined && window.currency !== undefined
}

/**
 * The hover text for one window: what was used, what is left, and when the
 * window resets when the provider discloses it.
 * @param window - the reported window.
 * @param t - section translate.
 * @param mode - used or remaining preference for the percentage form.
 * @param stale - the reading failed its last refresh.
 * @returns a single line of tooltip text.
 */
export function windowTooltip(
  window: UsageWindow,
  t: Translate,
  mode: QuotaDisplayMode = 'used',
  stale = false,
): string {
  const parts: string[] = []
  if (hasMoney(window)) {
    const used = formatMoney(window.usedAmount, window.currency)
    if (used) parts.push(t('usageBarUsed', { value: used }))
    if (window.limitAmount !== undefined) {
      const limit = formatMoney(window.limitAmount, window.currency)
      if (limit) parts.push(t('usageBarLimit', { value: limit }))
    }
    if (window.remainingAmount !== undefined) {
      const remaining = formatMoney(window.remainingAmount, window.currency)
      if (remaining) parts.push(t('usageBarRemaining', { value: remaining }))
    }
  } else {
    const used = quotaPercent(window.usedPercent, mode)
    if (used === undefined) parts.push(t('usageMeterInvalid'))
    else parts.push(t('usageMeterUsed', { used, remaining: 100 - used }))
  }
  if (window.resetsAt !== undefined) {
    parts.push(
      t('usageResets', { date: new Date(window.resetsAt).toLocaleString() }),
    )
  }
  if (stale) parts.push(t('usageMeterStale'))
  return parts.join(' · ')
}

/** Width of the bar in the footer; the fill scales inside it. */
const BAR_WIDTH = 40
const BAR_HEIGHT = 5

/**
 * One compact quota bar.
 *
 * @param window - the window the bar describes.
 * @param t - section translate.
 * @param observedAt - observation time of the reading, when known.
 * @param stale - the reading failed its last refresh.
 * @param width - bar width in pixels; the footer uses the default.
 */
export function UsageBar({
  window: quota,
  t,
  observedAt,
  stale,
  width = BAR_WIDTH,
}: {
  window: UsageWindow
  t: Translate
  width?: number
} & UsageObservation) {
  const preset = useUsageColorPreset()
  const mode = useQuotaDisplayMode()
  const now = Date.now()
  const fresh = isUsageFresh(quota, { observedAt, stale }, now)
  const elapsed = elapsedPercent(quota, now)
  const percent = validUsage(quota.usedPercent)
    ? Math.min(100, Math.max(0, quota.usedPercent))
    : 0
  const marker = elapsed ?? displayStartPercent(quota, now)
  const color = usageBarColor(quota.usedPercent, elapsed, preset, fresh)
  const tooltip = windowTooltip(quota, t, mode, !fresh)
  return (
    <span
      role="img"
      aria-label={tooltip}
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        verticalAlign: 'middle',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'relative',
          display: 'inline-block',
          width,
          height: BAR_HEIGHT,
          borderRadius: BAR_HEIGHT / 2,
          background: 'var(--dsw-alias-bg-layer-2)',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            position: 'absolute',
            insetBlock: 0,
            insetInlineStart: 0,
            width: `${percent}%`,
            background: color,
            opacity:
              usageColorState(quota.usedPercent, elapsed, preset, fresh) ===
              'neutral'
                ? 0.4
                : 1,
          }}
        />
        {marker !== undefined && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: -1,
              bottom: -1,
              insetInlineStart: `${Math.min(100, Math.max(0, marker))}%`,
              width: 1,
              background: 'var(--dsw-alias-label-secondary)',
            }}
          />
        )}
      </span>
    </span>
  )
}
