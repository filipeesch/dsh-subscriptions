/**
 * One key-managed source's usage detail, rendered inside its roster row.
 *
 * These routes live in DSH itself: their model route is built elsewhere and the
 * key belongs to Settings → Models. The row therefore states usage only — never a
 * credential field — because this page can read the key's presence but not set
 * it. The component keeps the card's own states: loading, a failed lookup, an
 * endpoint without a usage surface, an empty window list, and a stale reading.
 */

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

type Translate = SubscriptionsSectionInjected['t']

/** The key-managed routes this page can show usage for. */
export type ExternalSource =
  'opencode-go' | 'kimi-code' | 'minimax' | 'minimax-cn'

/** One source's copy name and the reference Settings → Models must hold. */
export const EXTERNAL_SOURCES: readonly {
  id: ExternalSource
  name: string
  ref: string
}[] = [
  { id: 'opencode-go', name: 'OpenCode Go', ref: 'OPENCODE_GO_API_KEY' },
  { id: 'kimi-code', name: 'Kimi Code', ref: 'KIMI_CODING_API_KEY' },
  { id: 'minimax', name: 'MiniMax', ref: 'MINIMAX_API_KEY' },
  { id: 'minimax-cn', name: 'MiniMax CN', ref: 'MINIMAX_CN_API_KEY' },
]

/** One source's entry, or undefined for a key-managed id this page does not serve. */
export function externalSource(
  id: ExternalSource,
): (typeof EXTERNAL_SOURCES)[number] | undefined {
  return EXTERNAL_SOURCES.find((entry) => entry.id === id)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface ExternalUsageDetailProps {
  rpc: ConnectionHandle['rpc']
  t: Translate
  source: ExternalSource
}

/**
 * One source's quota rows.
 * @param props - the connection caller, copy, and the source to read.
 * @returns the usage block, with the page's own loading and failure states.
 */
export function ExternalUsageDetail(props: ExternalUsageDetailProps) {
  const { rpc, t, source } = props
  const entry = externalSource(source)
  const [configured, setConfigured] = useState<boolean>()
  const [statusError, setStatusError] = useState<string>()
  const [usage, setUsage] = useState<ProviderUsage>()
  const [observedAt, setObservedAt] = useState<number>()
  const [usageStale, setUsageStale] = useState(false)
  const [usageError, setUsageError] = useState<string>()
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const value = await callSubscriptionsAuth<ProviderUsage>(
        rpc,
        'externalUsage',
        { source },
      )
      setUsage(value)
      // Prefer the server's observation time; a cached reading must not look fresh.
      setObservedAt(value.observedAt ?? Date.now())
      setUsageStale(value.stale === true)
      setUsageError(undefined)
      window.dispatchEvent(new Event(USAGE_BADGE_REFRESH_EVENT))
    } catch (error) {
      setUsageError(errorText(error))
      setUsageStale(true)
    } finally {
      setLoading(false)
    }
  }, [rpc, source])

  const refreshStatus = useCallback(async () => {
    try {
      const value = await callSubscriptionsAuth<
        Record<string, { configured: boolean }>
      >(rpc, 'externalStatus', {})
      setStatusError(undefined)
      const isConfigured = value[source]?.configured === true
      setConfigured(isConfigured)
      if (isConfigured) void refresh()
    } catch (error) {
      setStatusError(errorText(error))
    }
  }, [rpc, source, refresh])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  return (
    <div style={styles.account}>
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
      {statusError !== undefined && (
        <p style={styles.error}>
          {t('externalUsageUnavailable', { message: statusError })}
        </p>
      )}
      {configured === false && (
        <p style={styles.status}>
          {t('externalUsageConfigure', { ref: entry?.ref ?? '' })}
        </p>
      )}
      {loading && usage === undefined && (
        <p style={styles.status}>{t('usageLoading')}</p>
      )}
      {usageError !== undefined && (
        <p style={styles.error}>{t('usageError', { message: usageError })}</p>
      )}
      {usage !== undefined && usage.supported === false && (
        <p style={styles.status}>{t('usageUnsupported')}</p>
      )}
      {usage?.windows?.length === 0 && (
        <p style={styles.status}>{t('usageEmpty')}</p>
      )}
      {usage?.windows?.map((window, index) => (
        <UsageWindowRow
          key={index}
          window={window}
          t={t}
          observedAt={observedAt}
          stale={usageError !== undefined || usageStale}
        />
      ))}
    </div>
  )
}
