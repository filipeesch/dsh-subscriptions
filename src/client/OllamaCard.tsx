import { useCallback, useEffect, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ProviderUsage,
  SubscriptionsSectionInjected,
} from './SubscriptionsSection.js'
import type { OllamaSettingsView } from './ollama-draft.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { OllamaSettingsManager } from './OllamaSettingsManager.js'
import { USAGE_BADGE_REFRESH_EVENT } from './usage-badge-preferences.js'
import { subscriptionCardStyles as styles } from './subscription-card-styles.js'
import { KeyCredentialField } from './KeyCredentialField.js'
import { UsageWindowRow } from './UsageWindowRow.js'

type Translate = SubscriptionsSectionInjected['t']

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Ollama Cloud route card: the catalog the model picker shows, the web
 * capability toggle, and the API-key usage row. The settings dialog owns
 * every write; the card only reads, so a save is reflected by re-reading.
 */
export function OllamaCard({
  rpc,
  t,
}: {
  rpc: ConnectionHandle['rpc']
  t: Translate
}) {
  const [view, setView] = useState<OllamaSettingsView>()
  // Bumped whenever this card's settings change: the credential field's
  // identity includes it, because a saved override can keep the reference text
  // and still change who owns it.
  const [revision, setRevision] = useState(0)
  const [configured, setConfigured] = useState<boolean>()
  const [usage, setUsage] = useState<ProviderUsage>()
  const [observedAt, setObservedAt] = useState<number>()
  const [usageStale, setUsageStale] = useState(false)
  const [loading, setLoading] = useState(false)
  // Two failure surfaces: the card's own load and the usage lookup. They
  // render in different places so a stale usage reading cannot masquerade as
  // a settings failure.
  const [statusError, setStatusError] = useState<string>()
  const [usageError, setUsageError] = useState<string>()
  const [manage, setManage] = useState(false)

  const refreshUsage = useCallback(async () => {
    setLoading(true)
    try {
      const value = await callSubscriptionsAuth<ProviderUsage>(
        rpc,
        'externalUsage',
        { source: 'ollama-cloud' },
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
        callSubscriptionsAuth<OllamaSettingsView>(rpc, 'ollamaSettings', {}),
        callSubscriptionsAuth<Record<string, { configured: boolean }>>(
          rpc,
          'externalStatus',
          {},
        ),
      ])
      setView(settings)
      setStatusError(undefined)
      const isConfigured = status['ollama-cloud']?.configured === true
      setConfigured(isConfigured)
      if (isConfigured) void refreshUsage()
    } catch (failure) {
      setStatusError(message(failure))
    }
  }, [rpc, refreshUsage])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

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
        <span style={styles.name}>{t('ollamaTitle')}</span>
      </div>
      <p style={styles.status}>
        {view === undefined
          ? t('checking')
          : view.models.length > 0
            ? t('ollamaStatus', { count: view.models.length })
            : t('ollamaStatusNone')}
      </p>
      {view !== undefined && (
        <p style={styles.status}>
          {view.effective.web ? t('ollamaWebOn') : t('ollamaWebOff')}
        </p>
      )}
      {view !== undefined && view.keyUsable === false && (
        <p style={styles.status}>{t('ollamaKeyAddressMismatch')}</p>
      )}
      {statusError !== undefined && (
        <p style={styles.error}>
          {t('ollamaModelsLoadFailed', { message: statusError })}
        </p>
      )}
      <KeyCredentialField
        // The identity carries the settings revision as well as the reference:
        // a saved override can keep the same text and still change who owns the
        // reference, and the field must re-read its own state.
        key={`${view?.effective.apiKeyRef ?? 'pending'}:${revision}`}
        rpc={rpc}
        t={t}
        route="ollama-cloud"
        onChanged={() => {
          // No revision bump here: this is the field's own mutation, and
          // remounting it would discard the validation outcome it is about to
          // report. The connection manager's save still bumps it.
          void refreshStatus()
        }}
      />
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
            {usage?.windows?.map((window, index) => (
              <UsageWindowRow
                key={index}
                window={window}
                t={t}
                observedAt={observedAt}
                stale={usageStale}
              />
            ))}
          </div>
        </div>
      )}
      {view?.configOverridesModels === true && (
        <p style={styles.status}>{t('ollamaCatalogOverride')}</p>
      )}
      <div style={styles.actions}>
        <button
          type="button"
          style={styles.button}
          aria-haspopup="dialog"
          onClick={() => setManage(true)}
        >
          {t('accountsManage')}
        </button>
        {configured !== true && (
          <button
            type="button"
            style={styles.button}
            onClick={() => {
              void refreshStatus()
            }}
          >
            {t('usageRefresh')}
          </button>
        )}
      </div>
      {manage && (
        <OllamaSettingsManager
          rpc={rpc}
          t={t}
          onClose={() => setManage(false)}
          onSaved={() => {
            setRevision((value) => value + 1)
            void refreshStatus()
          }}
        />
      )}
    </div>
  )
}
