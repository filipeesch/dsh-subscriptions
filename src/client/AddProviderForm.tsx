/**
 * The add-provider form: one provider chosen from one selector, that provider's
 * own fields below it, and one primary action named for how that provider is
 * configured.
 *
 * Choosing writes nothing. The form calls a route only when the primary action
 * asks for it, and it reports back rather than closing itself: a configuration
 * the route has not confirmed must not become a row. Browser authorization is the
 * page's attempt, not a second one — the page polls the provider's status and
 * passes the answer down, so canceling here and canceling in a row reach the same
 * attempt.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ProviderStatus,
  SubscriptionsSectionInjected,
  SubscriptionProvider,
} from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { formStyles as styles } from './subscription-section-styles.js'
import {
  SELECTOR_PROVIDERS,
  providerEntry,
  type ProviderEntry,
  type RosterProviderId,
  type RowState,
} from './provider-roster.js'
import type { OllamaSettingsView } from './ollama-draft.js'
import type {
  KeyCredentialResult,
  KeyRoute,
  KeyValidationResult,
} from './KeyCredentialField.js'
import type { ExternalSource } from './ExternalUsageDetail.js'
import { externalSource } from './ExternalUsageDetail.js'

type Translate = SubscriptionsSectionInjected['t']

/** Which Ollama connection the form configures. */
type Connection = 'cloud' | 'local'

export interface AddProviderFormProps {
  rpc: ConnectionHandle['rpc']
  t: Translate
  /** Providers the roster already lists: marked, and out of reach here. */
  configured: ReadonlySet<RosterProviderId>
  /** Ollama's stored settings; a save re-sends the whole document. */
  ollamaSettings: OllamaSettingsView | undefined
  /** The page's OAuth attempt state, so the form and the rows share one. */
  statuses: Partial<Record<SubscriptionProvider, ProviderStatus>>
  deviceCodes: Partial<
    Record<SubscriptionProvider, { userCode: string; verificationUrl: string }>
  >
  errors: Partial<Record<SubscriptionProvider, string>>
  copiedCode: SubscriptionProvider | undefined
  /**
   * Start a browser authorization for one provider. The page owns the attempt
   * and its polling; the promise settles when the start request answers, not
   * when the sign-in does.
   */
  onStartLogin: (
    provider: SubscriptionProvider,
    method?: 'oauth' | 'keychain',
  ) => Promise<void>
  onCancelAttempt: (provider: SubscriptionProvider) => void
  onManualSubmit: (provider: SubscriptionProvider, value: string) => void
  onCopyDeviceCode: (provider: SubscriptionProvider, code: string) => void
  onCancel: () => void
  onConfirmed: (
    provider: RosterProviderId,
    state: RowState,
    outcome: string,
  ) => void
  onNeedsAttention: (provider: RosterProviderId) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The add-provider form.
 * @param props - the page's snapshot, attempt state, and callbacks.
 * @returns the form, or its remaining states while a route is being confirmed.
 */
export function AddProviderForm(props: AddProviderFormProps) {
  const { t, rpc } = props
  const [chosen, setChosen] = useState<RosterProviderId>()
  const [keyDraft, setKeyDraft] = useState('')
  const [addressDraft, setAddressDraft] = useState('')
  const [connection, setConnection] = useState<Connection>('cloud')
  const [manualDraft, setManualDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [missed, setMissed] = useState<string>()
  const [starting, setStarting] = useState(false)
  /**
   * Every provider whose saved key the route rejected, keyed per provider so a
   * later save or a switch cannot lose one verdict.
   */
  const [rejected, setRejected] = useState<ReadonlySet<RosterProviderId>>(
    new Set(),
  )
  /** The rejected-key panel was dismissed, but the verdicts stand. */
  const [dismissed, setDismissed] = useState(false)
  /** The provider whose authorization this form started, if any. */
  const [owned, setOwned] = useState<SubscriptionProvider>()
  const confirmed = useRef(false)
  /** A cancel asked while the start request was still in flight. */
  const cancelOwned = useRef(false)
  /** Bumped whenever the form is abandoned, so a late answer is dropped. */
  const epoch = useRef(0)
  const firstField = useRef<HTMLElement | null>(null)

  const entry: ProviderEntry | undefined =
    chosen === undefined ? undefined : providerEntry(chosen)
  const oauth =
    entry?.family === 'oauth' ? (entry.id as SubscriptionProvider) : undefined
  const attemptStatus = owned === undefined ? undefined : props.statuses[owned]
  const awaiting = owned !== undefined && attemptStatus?.busy === true
  const deviceCode = owned === undefined ? undefined : props.deviceCodes[owned]
  const attemptError = owned === undefined ? undefined : props.errors[owned]
  /** The host's terminal remark for the attempt: an exchange or device failure. */
  const attemptDetail =
    owned === undefined || awaiting ? undefined : attemptStatus?.detail
  const source =
    entry?.family === 'managed' ? (entry.id as ExternalSource) : undefined
  /** Changing the provider while something runs would abandon that attempt. */
  const locked = busy || starting || awaiting

  /** Hand every outstanding rejected-key verdict to the page. */
  const flushVerdicts = useCallback(
    (except?: RosterProviderId): void => {
      for (const provider of rejected) {
        if (provider === except) continue
        props.onNeedsAttention(provider)
      }
    },
    [rejected, props],
  )

  /**
   * Report a confirmed provider and hand the page every other outstanding
   * rejected-key verdict, so closing the form never loses one.
   */
  const confirm = useCallback(
    (provider: RosterProviderId, state: RowState, outcome: string): void => {
      flushVerdicts(provider)
      props.onConfirmed(provider, state, outcome)
    },
    [flushVerdicts, props],
  )

  // Only an attempt this form started, for the provider still chosen, may add a
  // row; the guard keeps a re-render from confirming the same attempt twice.
  useEffect(() => {
    if (entry === undefined || oauth === undefined) return
    if (owned !== oauth || cancelOwned.current || confirmed.current) return
    if ((attemptStatus?.accounts.length ?? 0) > 0) {
      confirmed.current = true
      confirm(
        entry.id,
        'accounts-one',
        t('addOutcomeProvider', { name: entry.name }),
      )
    }
  }, [entry, oauth, owned, attemptStatus, props, t, confirm])

  // The chosen provider's first control takes focus, so a keyboard reader lands
  // where the choice just pointed.
  useEffect(() => {
    if (chosen !== undefined) firstField.current?.focus()
  }, [chosen])

  function choose(next: RosterProviderId): void {
    if (locked) return
    epoch.current += 1
    setChosen(next)
    // A dismissed verdict is hidden, not forgotten: a later visit shows it.
    setDismissed(false)
    setKeyDraft('')
    setAddressDraft('')
    setManualDraft('')
    setFailure(undefined)
    setMissed(undefined)
    setConnection('cloud')
    confirmed.current = false
  }

  /** Start the browser authorization this form owns. */
  async function start(
    provider: SubscriptionProvider,
    method?: 'oauth' | 'keychain',
  ): Promise<void> {
    if (locked) return
    const mineEpoch = epoch.current
    cancelOwned.current = false
    setOwned(provider)
    setStarting(true)
    setFailure(undefined)
    setMissed(undefined)
    try {
      await props.onStartLogin(provider, method)
    } catch (error) {
      if (epoch.current === mineEpoch) setFailure(errorText(error))
    } finally {
      setStarting(false)
      // A cancel that arrived while the request was in flight reaches the
      // attempt now, instead of being forgotten with the form.
      if (cancelOwned.current) props.onCancelAttempt(provider)
    }
  }

  /** Cancel the owned attempt, now or as soon as its start request answers. */
  function cancelAttempt(): void {
    const target = owned ?? oauth
    if (target === undefined) return
    cancelOwned.current = true
    if (!starting) props.onCancelAttempt(target)
  }

  function cancel(): void {
    if (busy) return
    epoch.current += 1
    if (owned !== undefined) cancelAttempt()
    flushVerdicts()
    props.onCancel()
  }

  async function saveKey(
    route: KeyRoute,
    provider: RosterProviderId,
    state: RowState,
    outcome: string,
  ): Promise<void> {
    const value = keyDraft.trim()
    if (value === '' || busy) return
    const mine = epoch.current
    setBusy(true)
    setFailure(undefined)
    setDismissed(false)
    // The previous verdict stands until this replacement is proven: an attempt
    // that never commits must not make a rejected saved key look configured.
    try {
      const result = await callSubscriptionsAuth<KeyCredentialResult>(
        rpc,
        'keySetCredential',
        { route, value },
      )
      if (epoch.current !== mine) return
      if (!result.committed) {
        setFailure(t('credentialNotCommitted'))
        return
      }
      let validation: KeyValidationResult
      try {
        validation = await callSubscriptionsAuth<KeyValidationResult>(
          rpc,
          'keyValidateCredential',
          { route, generation: result.generation },
        )
      } catch {
        validation = { outcome: 'invalid' }
      }
      if (epoch.current !== mine) return
      if (validation.outcome === 'valid') {
        setRejected((prev) => {
          if (!prev.has(provider)) return prev
          const next = new Set(prev)
          next.delete(provider)
          return next
        })
        confirm(provider, state, outcome)
        return
      }
      if (validation.outcome === 'superseded') {
        // Another writer moved the credential while this save validated; the
        // verdict belongs to a key this form did not store.
        setFailure(t('credentialSuperseded'))
        return
      }
      // A key the route rejects stays saved, so the reader can correct it. The
      // verdict is kept against the provider it was obtained for.
      setRejected((prev) => new Set(prev).add(provider))
      setDismissed(false)
    } catch (error) {
      if (epoch.current === mine)
        setFailure(t('credentialSaveFailed', { message: errorText(error) }))
    } finally {
      setBusy(false)
    }
  }

  async function saveAddress(): Promise<void> {
    const address = addressDraft.trim()
    if (address === '' || busy) return
    const mine = epoch.current
    setBusy(true)
    setFailure(undefined)
    try {
      // The route stores one document, and the store replaces rather than
      // merges: read it now, so a model, web, or reference change saved
      // elsewhere while this page was open is not overwritten, then send the
      // whole document back with the new address.
      const fresh = await callSubscriptionsAuth<OllamaSettingsView>(
        rpc,
        'ollamaSettings',
        {},
      )
      if (epoch.current !== mine) return
      await callSubscriptionsAuth(rpc, 'ollamaSetSettings', {
        settings: { ...fresh.settings, baseURL: address },
      })
      if (epoch.current !== mine) return
      confirm('ollama', 'address', t('addOutcomeAddress'))
    } catch (error) {
      if (epoch.current === mine)
        setFailure(t('ollamaModelsSaveFailed', { message: errorText(error) }))
    } finally {
      setBusy(false)
    }
  }

  async function checkManaged(): Promise<void> {
    if (source === undefined || busy) return
    const mine = epoch.current
    setBusy(true)
    setFailure(undefined)
    setMissed(undefined)
    try {
      const status = await callSubscriptionsAuth<
        Record<string, { configured: boolean }>
      >(rpc, 'externalStatus', {})
      if (epoch.current !== mine) return
      if (status[source]?.configured === true) {
        confirm(
          source,
          'key',
          t('addOutcomeManaged', { name: entry?.name ?? source }),
        )
        return
      }
      setMissed(
        t('addManagedKeyMissing', {
          ref: externalSource(source)?.ref ?? '',
        }),
      )
    } catch (error) {
      if (epoch.current === mine) setFailure(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const cloud = connection === 'cloud'
  const saveLabel = t('addSave')
  let primaryLabel = saveLabel
  if (entry?.family === 'oauth')
    primaryLabel =
      entry.id === 'copilot' ? t('addGetDeviceCode') : t('addContinueBrowser')
  if (entry?.family === 'managed') primaryLabel = t('addCheckAgain')
  if (entry?.family === 'ollama' && !cloud) primaryLabel = t('addSaveAddress')
  /** The action cannot apply yet: the field it needs is empty. */
  const primaryUnavailable =
    (entry?.family === 'cursor' && keyDraft.trim() === '') ||
    (entry?.family === 'ollama' &&
      (cloud ? keyDraft.trim() === '' : addressDraft.trim() === ''))
  /**
   * A submitted action or a sign-in wait. This state uses `aria-disabled` and a
   * guarded click rather than `disabled`: disabling a focused button hands focus
   * to the page body, and re-enabling does not give it back, so a reader who
   * submitted with the keyboard would lose their place in the middle of the save.
   */
  const primaryBusy = busy || starting || awaiting
  function primary(): void {
    if (entry === undefined) return
    if (entry.family === 'oauth') {
      // The add flow always means browser authorization. Only Claude names the
      // method, because only Claude has a second one that would import an
      // existing CLI credential; the host refuses a method for the others.
      if (oauth !== undefined)
        void start(oauth, oauth === 'claude' ? 'oauth' : undefined)
      return
    }
    if (entry.family === 'cursor') {
      void saveKey(
        'cursor',
        'cursor',
        'key',
        t('addOutcomeKey', { name: entry.name }),
      )
      return
    }
    if (entry.family === 'ollama') {
      if (cloud) {
        void saveKey(
          'ollama-cloud',
          'ollama',
          'cloud-key',
          t('addOutcomeCloudKey'),
        )
      } else {
        void saveAddress()
      }
      return
    }
    void checkManaged()
  }

  // One mounted region states what the form is doing, in the order it happens:
  // the rejected key, the waiting sign-in, the running action, or the host's
  // terminal remark for the attempt (an exchange or device failure) and the
  // managed key a check did not find.
  /** The rejected-key verdict for the provider on screen, if it has one. */
  const verdict =
    chosen !== undefined && rejected.has(chosen) ? chosen : undefined
  const showUnusable = verdict !== undefined && !dismissed
  const status = showUnusable
    ? t('addKeyUnusableHint', {
        provider: providerEntry(verdict)?.name ?? String(verdict),
      })
    : awaiting
      ? t('addWaiting', { provider: entry?.name ?? '' })
      : busy
        ? t('addSaving')
        : (missed ?? attemptDetail ?? '')

  return (
    <div className="dsh-add-provider-form" style={styles.block}>
      <h2 style={styles.title}>{t('addTitle')}</h2>
      <div style={styles.panel}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="dsh-add-provider">
            {t('addProviderLabel')}
          </label>
          <select
            id="dsh-add-provider"
            style={{ width: '100%', boxSizing: 'border-box', minHeight: 44 }}
            disabled={locked}
            value={chosen ?? ''}
            onChange={(event) => {
              const next = event.currentTarget.value
              if (next === '') return
              choose(next as RosterProviderId)
            }}
          >
            <option value="">{t('addSelectProvider')}</option>
            {SELECTOR_PROVIDERS.map((option) => {
              const taken = props.configured.has(option.id)
              return (
                <option key={option.id} value={option.id} disabled={taken}>
                  {taken
                    ? t('addConfiguredOption', { name: option.name })
                    : option.name}
                </option>
              )
            })}
          </select>
        </div>
        {entry !== undefined && (
          <>
            <hr style={styles.divider} />
            <div style={styles.fieldBody}>
              {entry.family === 'cursor' && (
                <label style={styles.field}>
                  <span style={styles.label}>
                    {t('addApiKeyLabel', { provider: entry.name })}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={keyDraft}
                    disabled={busy}
                    ref={(node) => {
                      firstField.current = node
                    }}
                    onChange={(event) => setKeyDraft(event.target.value)}
                  />
                </label>
              )}
              {entry.family === 'ollama' && (
                <>
                  <div
                    style={styles.connectionChoice}
                    role="group"
                    aria-label={t('addConnectionType')}
                  >
                    <button
                      type="button"
                      aria-pressed={cloud}
                      style={
                        cloud
                          ? styles.connectionOptionActive
                          : styles.connectionOption
                      }
                      onClick={() => setConnection('cloud')}
                    >
                      {t('addConnectionCloud')}
                    </button>
                    <button
                      type="button"
                      aria-pressed={!cloud}
                      style={
                        !cloud
                          ? styles.connectionOptionActive
                          : styles.connectionOption
                      }
                      onClick={() => setConnection('local')}
                    >
                      {t('addConnectionLocal')}
                    </button>
                  </div>
                  {cloud ? (
                    <label style={styles.field}>
                      <span style={styles.label}>{t('addCloudKeyLabel')}</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={keyDraft}
                        disabled={busy}
                        ref={(node) => {
                          firstField.current = node
                        }}
                        onChange={(event) => setKeyDraft(event.target.value)}
                      />
                    </label>
                  ) : (
                    <>
                      <label style={styles.field} htmlFor="dsh-add-address">
                        <span style={styles.label}>
                          {t('addAddressLabel', { provider: entry.name })}
                        </span>
                        <input
                          id="dsh-add-address"
                          type="url"
                          value={addressDraft}
                          placeholder="http://localhost:11434"
                          disabled={busy}
                          aria-describedby="dsh-add-address-caveat"
                          ref={(node) => {
                            firstField.current = node
                          }}
                          onChange={(event) =>
                            setAddressDraft(event.target.value)
                          }
                        />
                      </label>
                      {/* The caveat describes the field; keeping it out of the
                          label keeps the field's name to the address. */}
                      <span id="dsh-add-address-caveat" style={styles.hint}>
                        {t('addAddressCaveat')}
                      </span>
                    </>
                  )}
                </>
              )}
              {entry.family === 'managed' && (
                <p style={styles.hint}>
                  {t('addManagedKeyHint', {
                    ref: externalSource(entry.id as ExternalSource)?.ref ?? '',
                  })}
                </p>
              )}
              {entry.family === 'oauth' && (
                <p style={styles.hint}>
                  {entry.id === 'copilot'
                    ? t('addDeviceCodeHint', { provider: entry.name })
                    : t('addBrowserHint', { provider: entry.name })}
                </p>
              )}
              {awaiting && oauth !== undefined && (
                <div style={styles.outcome}>
                  {/* The waiting sentence itself lives in the mounted status
                      region below, so it is announced once and not repeated. */}
                  {deviceCode !== undefined ? (
                    <div style={styles.deviceCode}>
                      <span style={styles.hint}>{t('deviceCodePrompt')}</span>
                      <span style={styles.deviceCodeText}>
                        {deviceCode.userCode}
                      </span>
                      <div style={styles.actions}>
                        <button
                          type="button"
                          onClick={() =>
                            props.onCopyDeviceCode(oauth, deviceCode.userCode)
                          }
                        >
                          {props.copiedCode === oauth
                            ? t('deviceCodeCopied')
                            : t('deviceCodeCopy')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            window.open(
                              deviceCode.verificationUrl,
                              '_blank',
                              'noopener',
                            )
                          }}
                        >
                          {t('deviceCodeOpenPage')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <details>
                      <summary>{t('manualSummary')}</summary>
                      <div style={styles.actions}>
                        <input
                          type="text"
                          value={manualDraft}
                          placeholder={t('manualPlaceholder')}
                          aria-label={t('addManualLabel', {
                            provider: entry.name,
                          })}
                          onChange={(event) =>
                            setManualDraft(event.target.value)
                          }
                        />
                        <button
                          type="button"
                          disabled={manualDraft.trim() === ''}
                          onClick={() => {
                            props.onManualSubmit(oauth, manualDraft.trim())
                            setManualDraft('')
                          }}
                        >
                          {t('submit')}
                        </button>
                      </div>
                    </details>
                  )}
                  <div style={styles.actions}>
                    <button type="button" onClick={() => cancelAttempt()}>
                      {t('addCancelSignIn')}
                    </button>
                  </div>
                </div>
              )}
              {verdict !== undefined && !dismissed && (
                <div style={styles.outcome}>
                  {/* The reason is stated once, in the mounted status region
                      below, so the panel adds only its title and the way back. */}
                  <p style={styles.label}>{t('addKeyUnusableTitle')}</p>
                  <div style={styles.actions}>
                    <button
                      type="button"
                      onClick={() => {
                        // Dismiss the panel but keep the verdict: the key is
                        // still saved and still unusable.
                        setDismissed(true)
                        firstField.current?.focus()
                      }}
                    >
                      {t('addBackToKey')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
        {/* One always-mounted region states what the form is doing, in order. */}
        <span role="status" aria-live="polite" style={styles.hint}>
          {status}
        </span>
        {(failure ?? attemptError) !== undefined && (
          <span role="alert" style={styles.hint}>
            {failure ?? attemptError}
          </span>
        )}
        {/* One right-aligned row, wrapping only when the labels need it. */}
        <div style={styles.footer}>
          <button type="button" style={styles.footerButton} onClick={cancel}>
            {t('cancel')}
          </button>
          <button
            type="button"
            className="dsh-subscription-primary"
            style={styles.footerButton}
            disabled={entry === undefined || primaryUnavailable}
            aria-disabled={primaryBusy || undefined}
            ref={(node) => {
              if (entry?.family === 'oauth') firstField.current = node
            }}
            onClick={() => {
              if (primaryUnavailable || primaryBusy) return
              primary()
            }}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
