/**
 * One OAuth-session provider's controls, rendered inside its roster row.
 *
 * This is the card body the page always drew, lifted out unchanged so the roster
 * can hide it behind a disclosure: the accounts with their default selection and
 * sign-out, each account's usage windows and reset credits, adding an account,
 * the account manager, the waiting state with its device code and manual
 * fallback, and the provider's own error line. Every action is the page's — this
 * module runs none of them and holds no state, which is why it can be called
 * from the page's render instead of mounted as a child.
 */

import type {
  ProviderStatus,
  ProviderUsage,
  SubscriptionsSectionInjected,
  SubscriptionProvider,
} from './SubscriptionsSection.js'
import { sectionStyles as styles } from './subscription-section-styles.js'
import type { SubscriptionsKey } from './locales.js'
import { visibleUsageWindows } from './usage-window-filter.js'
import { resetActionBlock } from './reset-action.js'
import { UsageWindowRow } from './UsageWindowRow.js'
import {
  ResetCreditsDisclosure,
  ResetCreditsErrorLine,
  showsResetCredits,
} from './reset-credits-view.js'

type Translate = SubscriptionsSectionInjected['t']

/** Where a presented CLI version came from. */
export type ClientVersionSource = 'npm' | 'local' | 'fallback' | 'config'

const CLIENT_VERSION_SOURCES: Record<ClientVersionSource, SubscriptionsKey> = {
  npm: 'clientVersionNpm',
  local: 'clientVersionLocal',
  fallback: 'clientVersionFallback',
  config: 'clientVersionConfig',
}

/**
 * The CLI version a route presents, beside the provider name; nothing for routes
 * without one. The source word (npm / local / built-in / configured) is the fix
 * for upstream issue #108: a failed npm lookup must read as a fallback, never as
 * a plan limit.
 */
export function clientVersionText(
  t: Translate,
  clientVersion: ProviderStatus['clientVersion'],
): string {
  if (clientVersion === undefined) return ''
  return t('clientVersion', {
    version: clientVersion.version,
    source: t(CLIENT_VERSION_SOURCES[clientVersion.source]),
  })
}

/**
 * The line a card states when its reading carries a budget but no plan window:
 * the account is metered differently, not broken. Exported so a static render
 * can assert the sentence the card mounts.
 * @param props.t - section translate.
 * @returns the note the card shows under the window rows.
 */
export function PlanWindowsAbsentNote({ t }: { t: Translate }) {
  return <p style={styles.statusLine}>{t('usagePlanWindowsAbsent')}</p>
}

export interface OAuthDetailProps {
  t: Translate
  provider: SubscriptionProvider
  status: ProviderStatus | undefined
  error: string | undefined
  usages: Record<string, ProviderUsage>
  observedAt: Record<string, number>
  usageErrors: Record<string, string>
  usageLoading: Record<string, boolean>
  deviceCode: { userCode: string; verificationUrl: string } | undefined
  copiedCode: boolean
  manualDraft: string
  resetBusy: boolean
  resetAccount: string | undefined
  resetMessage: string
  onManualDraft: (value: string) => void
  onManualSubmit: () => void
  onLogin: (method?: 'oauth' | 'keychain') => void
  onCancel: () => void
  onLogout: (account: string, display: string) => void
  onSetDefault: (account: string) => void
  onCopyDeviceCode: (code: string) => void
  onRefreshUsage: (account: string) => void
  onManage: () => void
  onPrepareReset: (account: string) => void
}

/**
 * One provider's row body.
 * @param props - the provider's reported state and the page's actions.
 * @returns the accounts, usage, and actions the row expands to.
 */
export function OAuthProviderDetail(props: OAuthDetailProps) {
  const { t, status } = props
  const busy = status?.busy === true
  const deviceCode = props.deviceCode
  const accounts = status?.accounts ?? []
  return (
    <div style={styles.detail}>
      {status?.clientVersion !== undefined && (
        <span style={styles.clientVersion} title={t('clientVersionHint')}>
          {clientVersionText(t, status.clientVersion)}
        </span>
      )}
      {status?.detail !== undefined && status.detail !== '' && (
        <p style={styles.statusLine}>{status.detail}</p>
      )}
      {props.error !== undefined && (
        <p style={styles.errorLine}>{props.error}</p>
      )}
      {accounts.map((account) => {
        const usageKey = props.provider + ':' + account.key
        const usage = props.usages[usageKey]
        const shownWindows = visibleUsageWindows(
          props.provider,
          usage?.windows,
          status?.visibleModels,
        )
        const usageError = props.usageErrors[usageKey]
        const display = account.account ?? account.key
        const sortedCredits = [...(usage?.resetCredits ?? [])].sort(
          (a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity),
        )
        const nextReset = sortedCredits.find(
          (c) => c.expiresAt === undefined || c.expiresAt > Date.now(),
        )
        const resetBlock = usage ? resetActionBlock(usage) : 'resetUseRefresh'
        const resetDisabled = props.resetBusy || resetBlock !== undefined
        // Providers without a usage endpoint answer supported:false — no block.
        const showUsage =
          usage?.supported !== false &&
          (usage !== undefined ||
            usageError !== undefined ||
            props.usageLoading[usageKey] === true)
        return (
          <div key={account.key} style={styles.accountRow}>
            <div style={styles.accountHeader}>
              <button
                type="button"
                style={styles.starButton}
                title={account.isDefault ? t('defaultBadge') : t('setDefault')}
                onClick={() => {
                  if (!account.isDefault) props.onSetDefault(account.key)
                }}
              >
                {account.isDefault ? '★' : '☆'}
              </button>
              <span style={styles.accountName}>{display}</span>
              {account.plan !== undefined && (
                <span style={styles.usagePlan}>{account.plan}</span>
              )}
              {account.expiresAt !== undefined && (
                <span style={styles.statusLine}>
                  {t('accountExpires', {
                    date: new Date(account.expiresAt).toLocaleString(),
                  })}
                </span>
              )}
              <button
                type="button"
                style={{ marginLeft: 'auto', flexShrink: 0 }}
                onClick={() => props.onLogout(account.key, display)}
              >
                {t('logout')}
              </button>
            </div>
            {showUsage && (
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
                    disabled={props.usageLoading[usageKey] === true}
                    onClick={() => props.onRefreshUsage(account.key)}
                  >
                    {t('usageRefresh')}
                  </button>
                </div>
                {usage === undefined && usageError === undefined && (
                  <p style={styles.statusLine}>{t('usageLoading')}</p>
                )}
                {usageError !== undefined && (
                  <p style={styles.errorLine}>
                    {t('usageError', { message: usageError })}
                  </p>
                )}
                {usage?.windows !== undefined && usage.windows.length === 0 && (
                  <p style={styles.statusLine}>{t('usageEmpty')}</p>
                )}
                {usage?.windows !== undefined &&
                  usage.windows.length > 0 &&
                  shownWindows.length === 0 && (
                    <p style={styles.statusLine}>{t('usageNoVisibleModels')}</p>
                  )}
                {shownWindows.map((window, index) => (
                  <UsageWindowRow
                    key={index}
                    window={window}
                    t={t}
                    observedAt={props.observedAt[usageKey]}
                    stale={usageError !== undefined || usage.stale === true}
                  />
                ))}
                {usage?.planWindowsAbsent === true &&
                  shownWindows.some(
                    (window) => window.usedAmount !== undefined,
                  ) && <PlanWindowsAbsentNote t={t} />}
                {(props.provider === 'codex' || props.provider === 'claude') &&
                  usage?.resetCreditsError !== undefined && (
                    <ResetCreditsErrorLine
                      provider={props.provider}
                      message={usage.resetCreditsError}
                      t={t}
                    />
                  )}
                {(props.provider === 'codex' || props.provider === 'claude') &&
                  showsResetCredits(props.provider, usage?.resetCredits) && (
                    <ResetCreditsDisclosure
                      mode={props.provider === 'claude' ? 'grants' : 'credits'}
                      credits={sortedCredits}
                      t={t}
                      {...(nextReset !== undefined
                        ? { nextCredit: nextReset }
                        : {})}
                      {...(props.provider === 'codex'
                        ? {
                            useAction: {
                              accountKey: account.key,
                              busy:
                                props.resetBusy &&
                                props.resetAccount === account.key,
                              disabled: resetDisabled,
                              title: t(
                                props.resetBusy
                                  ? 'resetUseChecking'
                                  : (resetBlock ?? 'resetUseReady'),
                              ),
                              label: t('resetUseButton'),
                              onUse: () => {
                                if (!resetDisabled)
                                  props.onPrepareReset(account.key)
                              },
                            },
                          }
                        : {})}
                      {...(props.resetAccount === account.key &&
                      props.resetMessage !== ''
                        ? { statusMessage: props.resetMessage }
                        : {})}
                    />
                  )}
              </div>
            )}
          </div>
        )
      })}
      <div style={styles.actions}>
        {!busy && accounts.length === 0 && (
          <button type="button" onClick={() => props.onLogin()}>
            {t('login')}
          </button>
        )}
        {!busy && accounts.length > 0 && props.provider === 'claude' && (
          <>
            <button type="button" onClick={() => props.onLogin('oauth')}>
              {t('addAccountOAuth')}
            </button>
            <button type="button" onClick={() => props.onLogin('keychain')}>
              {t('addAccountKeychain')}
            </button>
          </>
        )}
        {!busy && accounts.length > 0 && props.provider !== 'claude' && (
          <button type="button" onClick={() => props.onLogin()}>
            {t('addAccount')}
          </button>
        )}
        {/* Login and cancellation must not race a second settings writer. */}
        {!busy && (
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => props.onManage()}
          >
            {t('accountsManage')}
          </button>
        )}
        {busy && (
          <button type="button" onClick={() => props.onCancel()}>
            {t('cancel')}
          </button>
        )}
      </div>
      {!busy && accounts.length > 0 && (
        <p style={styles.statusLine}>{t('addAccountHint')}</p>
      )}
      {busy && deviceCode !== undefined && (
        <div style={styles.deviceCode}>
          <span style={styles.statusLine}>{t('deviceCodePrompt')}</span>
          <span style={styles.deviceCodeText}>{deviceCode.userCode}</span>
          <div style={styles.actions}>
            <button
              type="button"
              onClick={() => props.onCopyDeviceCode(deviceCode.userCode)}
            >
              {props.copiedCode ? t('deviceCodeCopied') : t('deviceCodeCopy')}
            </button>
            <button
              type="button"
              onClick={() => {
                window.open(deviceCode.verificationUrl, '_blank', 'noopener')
              }}
            >
              {t('deviceCodeOpenPage')}
            </button>
          </div>
        </div>
      )}
      {busy && deviceCode === undefined && (
        <details style={styles.manual}>
          <summary>{t('manualSummary')}</summary>
          <div style={styles.manualRow}>
            <input
              style={styles.manualInput}
              value={props.manualDraft}
              placeholder={t('manualPlaceholder')}
              aria-label={t('manualPlaceholder')}
              onChange={(event) => props.onManualDraft(event.target.value)}
            />
            <button type="button" onClick={() => props.onManualSubmit()}>
              {t('submit')}
            </button>
          </div>
        </details>
      )}
    </div>
  )
}
