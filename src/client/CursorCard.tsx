import { useCallback, useEffect, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ProviderUsage,
  SubscriptionsSectionInjected,
} from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { subscriptionCardStyles as styles } from './subscription-card-styles.js'
import { USAGE_BADGE_REFRESH_EVENT } from './usage-badge-preferences.js'
import { UsageWindowRow } from './UsageWindowRow.js'
import { KeyCredentialField } from './KeyCredentialField.js'
import { CursorModelsManager } from './CursorModelsManager.js'
import { CursorSourceLine } from './CursorCapacitySource.js'

type Translate = SubscriptionsSectionInjected['t']

/** The Cursor card's settings snapshot; the node half owns this shape. */
export interface CursorSettingsView {
  provider: 'cursor'
  keyRef: string
  ceilingUSD?: number
  models?: number
  /** Whether the published-capacity source may fetch. */
  publishedContext?: boolean
  /** The source's state, for the card's one status line. */
  knownContext?: { enabled: boolean; fetchedAt?: number }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Cursor route card: connection state, the credential reference, the reported
 * usage (money when the plan reports spend, percentages otherwise), and the
 * fallback monthly ceiling used only when Cursor reports spend without a limit.
 */
export function CursorCard({
  rpc,
  t,
}: {
  rpc: ConnectionHandle['rpc']
  t: Translate
}) {
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
  const [manage, setManage] = useState(false)

  const refreshUsage = useCallback(async () => {
    setLoading(true)
    try {
      const value = await callSubscriptionsAuth<ProviderUsage>(
        rpc,
        'externalUsage',
        { source: 'cursor', force: true },
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
    } catch (failure) {
      setSaveError(message(failure))
    }
  }

  const reportedLimit = usage?.windows?.some(
    (window) => window.limitSource === 'provider',
  )

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
      <KeyCredentialField
        // The route's effective reference identifies this field: when a save
        // renames it, React remounts rather than letting the field state one
        // reference while editing another.
        key={view?.keyRef ?? 'pending'}
        rpc={rpc}
        t={t}
        route="cursor"
        onChanged={() => {
          void refreshStatus()
        }}
      />
      {view !== undefined && (
        <CursorSourceLine
          t={t}
          enabled={view.knownContext?.enabled ?? true}
          {...(view.knownContext?.fetchedAt === undefined
            ? {}
            : { fetchedAt: view.knownContext.fetchedAt })}
        />
      )}
      {statusError !== undefined && (
        <p style={styles.error}>{t('usageError', { message: statusError })}</p>
      )}
      {configured === true && (
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
                void refreshStatus()
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
          {usage?.windows?.map((quota, index) => (
            <UsageWindowRow
              key={index}
              window={quota}
              t={t}
              observedAt={observedAt}
              stale={usageStale}
            />
          ))}
        </div>
      )}
      {view !== undefined && (
        <div style={styles.actions}>
          <button
            type="button"
            style={{ ...styles.button, fontWeight: 600 }}
            aria-haspopup="dialog"
            onClick={() => setManage(true)}
          >
            {t('cursorManage')}
          </button>
          <label
            style={{
              ...styles.status,
              display: 'block',
              flexBasis: '100%',
            }}
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
                boxSizing: 'border-box',
                width: '100%',
                maxWidth: 220,
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
      {reportedLimit === true && (
        <p style={styles.status}>{t('cursorCeilingUnused')}</p>
      )}
      {saveError !== undefined && <p style={styles.error}>{saveError}</p>}
      {saved && <p style={styles.status}>{t('cursorCeilingSaved')}</p>}
      {manage && (
        <CursorModelsManager
          rpc={rpc}
          t={t}
          onClose={() => setManage(false)}
          onSaved={() => {
            void refreshStatus()
          }}
        />
      )}
    </div>
  )
}
