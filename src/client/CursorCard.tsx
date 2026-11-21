import { useCallback, useEffect, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ProviderUsage,
  SubscriptionsSectionInjected,
} from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { externalUsageWindowLabel } from './ExternalUsageCards.js'
import { subscriptionCardStyles as styles } from './subscription-card-styles.js'
import { USAGE_BADGE_REFRESH_EVENT } from './usage-badge-preferences.js'
import { useQuotaDisplayMode } from './usage-badge-preferences.js'
import { UsageMeter } from './UsageMeter.js'
import { quotaText, useQuotaClock } from './quota-display.js'
import { formatMoney } from './money-format.js'

type Translate = SubscriptionsSectionInjected['t']

/** The Cursor card's settings snapshot; the node half owns this shape. */
export interface CursorSettingsView {
  provider: 'cursor'
  keyRef: string
  context: string
  ceilingUSD?: number
  models?: number
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Cursor route card: connection state, the credential reference, the model
 * count, the reported usage windows (money or percentage), and the optional
 * monthly ceiling used when Cursor reports spend without a limit.
 */
export function CursorCard({
  rpc,
  t,
}: {
  rpc: ConnectionHandle['rpc']
  t: Translate
}) {
  const quotaMode = useQuotaDisplayMode()
  const quotaNow = useQuotaClock()
  const [view, setView] = useState<CursorSettingsView>()
  const [configured, setConfigured] = useState<boolean>()
  const [usage, setUsage] = useState<ProviderUsage>()
  const [observedAt, setObservedAt] = useState<number>()
  const [usageStale, setUsageStale] = useState(false)
  const [loading, setLoading] = useState(false)
  const [statusError, setStatusError] = useState<string>()
  const [usageError, setUsageError] = useState<string>()
  const [ceiling, setCeiling] = useState('')
  const [saveError, setSaveError] = useState<string>()
  const [saved, setSaved] = useState(false)

  const refreshUsage = useCallback(async () => {
    setLoading(true)
    try {
      const value = await callSubscriptionsAuth<ProviderUsage>(
        rpc,
        'externalUsage',
        { source: 'cursor' },
      )
      setUsage(value)
      // Prefer the server's observation time; a cached reading must not look fresh.
      setObservedAt(value.observedAt ?? Date.now())
      setUsageStale(value.stale === true)
      setUsageError(undefined)
      window.dispatchEvent(new Event(USAGE_BADGE_REFRESH_EVENT))
    } catch (failure) {
      setUsageError(message(failure))
      setUsageStale(true)
    } finally {
      setLoading(false)
    }
  }, [rpc])

  const refreshStatus = useCallback(async () => {
    try {
      const [settings, status] = await Promise.all([
        callSubscriptionsAuth<CursorSettingsView>(rpc, 'cursorSettings', {}),
        callSubscriptionsAuth<Record<string, { configured: boolean }>>(
          rpc,
          'externalStatus',
          {},
        ),
      ])
      setView(settings)
      setCeiling(
        settings.ceilingUSD === undefined ? '' : String(settings.ceilingUSD),
      )
      setStatusError(undefined)
      const isConfigured = status.cursor?.configured === true
      setConfigured(isConfigured)
      if (isConfigured) void refreshUsage()
    } catch (failure) {
      setStatusError(message(failure))
    }
  }, [rpc, refreshUsage])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const save = async (): Promise<void> => {
    setSaveError(undefined)
    setSaved(false)
    const trimmed = ceiling.trim()
    let value: number | null = null
    if (trimmed !== '') {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setSaveError(t('cursorCeilingInvalid'))
        return
      }
      value = parsed
    }
    try {
      await callSubscriptionsAuth(rpc, 'cursorSetCeiling', {
        ceilingUSD: value,
      })
      setSaved(true)
      await refreshStatus()
      if (configured === true) void refreshUsage()
    } catch (failure) {
      setSaveError(message(failure))
    }
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span
          style={{
            ...styles.dot,
            background:
              configured === true
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-label-dimmed)',
          }}
        />
        <span style={styles.name}>{t('cursorTitle')}</span>
      </div>
      <p style={styles.status}>
        {view === undefined
          ? t('checking')
          : view.models !== undefined && view.models > 0
            ? t('cursorStatus', { count: view.models })
            : t('cursorStatusNone')}
      </p>
      {view !== undefined && (
        <p style={styles.status}>{t('cursorKeyRef', { ref: view.keyRef })}</p>
      )}
      {statusError !== undefined && (
        <p style={styles.error}>{t('usageError', { message: statusError })}</p>
      )}
      {configured === false && (
        <p style={styles.status}>{t('cursorConfigure')}</p>
      )}
      {configured === true && (
        <div style={styles.account}>
          <div style={styles.accountHeader}>
            <span style={styles.defaultStar} title={t('defaultBadge')}>
              ★
            </span>
            <span style={styles.accountName}>{t('externalUsageApiKey')}</span>
          </div>
          <div style={styles.usage}>
            <div style={styles.usageHeader}>
              <span style={styles.usageTitle}>{t('usageTitle')}</span>
              {usage?.plan !== undefined && (
                <span style={styles.usagePlan}>
                  {t('usagePlan', { plan: usage.plan })}
                </span>
              )}
              <button
                type="button"
                style={styles.usageRefresh}
                disabled={loading}
                onClick={() => {
                  void refreshUsage()
                }}
              >
                {t('usageRefresh')}
              </button>
            </div>
            {loading && usage === undefined && (
              <p style={styles.status}>{t('usageLoading')}</p>
            )}
            {usageError !== undefined && (
              <p style={styles.error}>
                {t('usageError', { message: usageError })}
              </p>
            )}
            {usage !== undefined && usage.supported === false && (
              <p style={styles.status}>{t('usageUnsupported')}</p>
            )}
            {usage?.windows?.length === 0 && (
              <p style={styles.status}>{t('usageEmpty')}</p>
            )}
            {usage?.windows?.map((quota, index) => {
              const label = externalUsageWindowLabel(t, quota)
              const money =
                quota.usedAmount !== undefined && quota.currency !== undefined
                  ? `${formatMoney(quota.usedAmount, quota.currency)}${
                      quota.limitAmount === undefined
                        ? ''
                        : ` / ${formatMoney(quota.limitAmount, quota.currency)}`
                    }`
                  : quotaText(quota.usedPercent, quotaMode, t)
              return (
                <div key={index} style={styles.usageRow}>
                  <div style={styles.usageMeta}>
                    <span>{label}</span>
                    <span>
                      {money}
                      {quota.resetsAt === undefined
                        ? ''
                        : ` · ${t('usageResets', { date: new Date(quota.resetsAt).toLocaleString() })}`}
                      {quota.resetsAt !== undefined &&
                        quota.resetsAt <= quotaNow &&
                        ` · ${t('quotaExpiredWindow')}`}
                    </span>
                  </div>
                  <UsageMeter
                    window={quota}
                    t={t}
                    observedAt={observedAt}
                    stale={usageStale}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
      {view !== undefined && (
        <div style={styles.actions}>
          <label
            style={{ ...styles.status, display: 'block', flexBasis: '100%' }}
          >
            {t('cursorCeilingLabel')}
            <input
              type="number"
              min={0}
              step="0.01"
              value={ceiling}
              placeholder="0"
              onChange={(event) => {
                setCeiling(event.target.value)
                setSaved(false)
              }}
              style={{
                display: 'block',
                width: '100%',
                marginTop: 4,
                padding: '4px 6px',
                fontSize: 12,
                color: 'inherit',
                background: 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 4,
              }}
            />
          </label>
          <button
            type="button"
            style={styles.button}
            onClick={() => void save()}
          >
            {t('cursorCeilingSave')}
          </button>
        </div>
      )}
      <p style={styles.status}>{t('cursorCeilingHint')}</p>
      {saveError !== undefined && <p style={styles.error}>{saveError}</p>}
      {saved && <p style={styles.status}>{t('cursorCeilingSaved')}</p>}
    </div>
  )
}
