/**
 * Subscriptions settings page: the roster of configured providers, the
 * preference band above it, and the add-provider form that replaces it while it
 * is open.
 *
 * The page owns every fact the roster needs. One configured-set read decides
 * which providers have a row — the OAuth routes' accounts from `status`, the
 * external routes from `externalStatus`, and Ollama's stored connection from
 * `ollamaSettings` — and it is replaced only on success, so a failed read keeps
 * the rows the last successful one reported. A row's detail is not mounted until
 * the row is expanded, so a collapsed roster performs no usage read.
 *
 * Every login state lives server-side; the page polls `status` only while an
 * attempt is busy, so an idle page never polls. All state is local React state —
 * the page has no store.
 *
 * Every color resolves through a `--dsw-alias-*` design token (the ui-theme
 * design-platform.css values flip under `body[data-ds-dark-theme]`), and every
 * user-visible string goes through the locale-bound `t` of the
 * 'settings.subscriptions' namespace.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'
import type { ProviderId } from '../providers/ids.js'
import { ProviderAccountManager } from './ProviderAccountManager.js'
import { providerSettingsCss } from './provider-settings-styles.js'
import { UsageBadgeDisplaySetting } from './UsageBadgeDisplaySetting.js'
import { USAGE_BADGE_REFRESH_EVENT } from './usage-badge-preferences.js'
import { sectionStyles, rosterStyles } from './subscription-section-styles.js'
import { ProviderRoster } from './ProviderRoster.js'
import { AddProviderForm } from './AddProviderForm.js'
import { CursorCard } from './CursorCard.js'
import { OllamaCard } from './OllamaCard.js'
import { ExternalUsageDetail } from './ExternalUsageDetail.js'
import type { ExternalSource } from './ExternalUsageDetail.js'
import { OAuthProviderDetail as OAuthDetail } from './OAuthProviderDetail.js'
import type { OllamaSettingsView } from './ollama-draft.js'
import { configuredRows, ROSTER_PROVIDERS } from './provider-roster.js'
import type {
  ConfiguredRow,
  ConfirmedRow,
  RosterProviderId,
  RosterSnapshot,
  RowState,
} from './provider-roster.js'
import type { KeyCredentialView } from './KeyCredentialField.js'
import {
  callSubscriptionsAuth,
  SubscriptionsAuthError,
} from './subscriptions-rpc.js'
export { callSubscriptionsAuth } from './subscriptions-rpc.js'
export {
  clientVersionText,
  PlanWindowsAbsentNote,
} from './OAuthProviderDetail.js'
export type { ClientVersionSource } from './OAuthProviderDetail.js'

/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS = 2000

/** Subscription provider ids, from the node half's single tuple. */
export type SubscriptionProvider = ProviderId

/** One logged-in account as answered by the `status` endpoint. */
export interface AccountStatus {
  key: string
  account?: string
  expiresAt?: number
  plan?: string
  isDefault: boolean
}

/** One provider's login state as answered by the `status` endpoint. */
export interface ProviderStatus {
  /** Picker selection; absent follows discovery, [] hides all model quotas. */
  visibleModels?: string[]
  busy: boolean
  accounts: AccountStatus[]
  detail?: string
  /** The CLI version the route presents (Codex, Claude), and where it came from. */
  clientVersion?: {
    version: string
    source: 'npm' | 'local' | 'fallback' | 'config'
  }
}

/** `status` endpoint value: the node half owns this shape. */
interface StatusResponse {
  providers: Record<SubscriptionProvider, ProviderStatus>
}

/** One rate-limit window as answered by the `usage` endpoint. */
export interface UsageWindow {
  kind: 'session' | 'weekly' | 'other'
  scope?: string
  usedPercent?: number
  resetsAt?: number
  startsAt?: number
  windowDurationMs?: number
  fixedWindow?: boolean
  /** Display-only assumed start; the marker rides it, never pace. */
  displayStartsAt?: number
  /** Amount used in the currency's minor unit, when the provider reports money. */
  usedAmount?: number
  /** Ceiling for this window in the same minor unit. */
  limitAmount?: number
  /** Whether the ceiling came from the provider or the configured fallback. */
  limitSource?: 'provider' | 'configured'
  /** Amount still available, when the provider reports it. */
  remainingAmount?: number
  /** ISO 4217 currency of the amounts. */
  currency?: string
}

/** `usage` endpoint value: the node half owns this shape. */
export interface ProviderUsage {
  observedAt?: number
  stale?: boolean
  supported: boolean
  windows?: UsageWindow[]
  /**
   * The provider reported no plan window while still reporting a budget; the
   * card states it instead of presenting the budget as the whole reading.
   */
  planWindowsAbsent?: boolean
  plan?: string
  /**
   * Banked limit-reset grants. Codex entries carry id/expiry only. Claude
   * entries are one row per grant: `expiresAt` is when the grant expires, not
   * a window reset, and `resetsLeft` is the remaining credit count.
   */
  resetCredits?: ResetCreditView[]
  resetCreditsError?: string
}

/** One banked reset grant as the usage RPC returns it. */
export interface ResetCreditView {
  id?: string
  grantedAt?: number
  /** Epoch milliseconds when the grant expires. Never a periodic window reset. */
  expiresAt?: number
  resetsTotal?: number
  resetsLeft?: number
  usableNow?: boolean
  paused?: boolean
  /** Server metadata only. Claude has no redemption control. */
  claimable?: boolean
  /** Epoch milliseconds until which the grant is visible but not usable. */
  cooldownUntil?: number
}

/** `login` endpoint value: the URL the user completes OAuth at. */
interface LoginResponse {
  authorizeUrl: string
  /** Device-flow providers (copilot): the code the user types at authorizeUrl. */
  userCode?: string
}

/** Injected dependencies of {@link SubscriptionsSection} (slot `inject`). */
export interface SubscriptionsSectionInjected {
  /** Generic logical-RPC caller over the Connection transport. */
  rpc: ConnectionHandle['rpc']
  /** Section copy: translate a 'settings.subscriptions' key with `{name}` template params. */
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type SubscriptionsSectionProps = Partial<SubscriptionsSectionInjected>

/** The OAuth-session routes, in the page's order. */
const OAUTH_PROVIDERS = ROSTER_PROVIDERS.filter(
  (entry) => entry.family === 'oauth',
) as readonly { id: SubscriptionProvider; name: string }[]

/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Copy a keyed map without the entries whose key is not in `live`. */
function dropStale<T>(
  map: Record<string, T>,
  live: ReadonlySet<string>,
): Record<string, T> {
  const stale = Object.keys(map).filter((key) => !live.has(key))
  if (stale.length === 0) return map
  const next = { ...map }
  for (const key of stale) delete next[key]
  return next
}

/**
 * English-dictionary fallback for a missing inject `t` (standalone renders);
 * the slot inject always supplies the locale-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
function fallbackTranslate(
  key: SubscriptionsKey,
  params?: Record<string, unknown>,
): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll('{' + name + '}', String(value))
  }
  return text
}

/** The page's own styles; the roster, the form, and the detail carry theirs. */
const styles = sectionStyles as Record<string, CSSProperties>

/**
 * The Subscriptions settings page component.
 * @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
 * @returns the roster, or the add form while it is open.
 */
export function SubscriptionsSection(props: SubscriptionsSectionProps) {
  const { rpc } = props
  const t = props.t ?? fallbackTranslate
  const [statuses, setStatuses] = useState<
    Partial<Record<SubscriptionProvider, ProviderStatus>>
  >({})
  const [errors, setErrors] = useState<
    Partial<Record<SubscriptionProvider, string>>
  >({})
  const [manualDrafts, setManualDrafts] = useState<
    Record<SubscriptionProvider, string>
  >({
    codex: '',
    claude: '',
    grok: '',
    copilot: '',
    antigravity: '',
  })
  /** Pending device-flow codes (copilot), shown while the attempt polls. */
  const [deviceCodes, setDeviceCodes] = useState<
    Partial<
      Record<
        SubscriptionProvider,
        { userCode: string; verificationUrl: string }
      >
    >
  >({})
  const [copiedCode, setCopiedCode] = useState<SubscriptionProvider>()
  /** Usage snapshots keyed `provider:accountKey` — every account tracks its own windows. */
  const [usages, setUsages] = useState<Record<string, ProviderUsage>>({})
  const [observedAt, setObservedAt] = useState<Record<string, number>>({})
  const [usageErrors, setUsageErrors] = useState<Record<string, string>>({})
  const [usageLoading, setUsageLoading] = useState<Record<string, boolean>>({})
  const [resetConfirmation, setResetConfirmation] = useState<{
    account: string
    ticket: string
    expiresAt: number
    creditExpiresAt?: number
    weeklyUsedPercent: number
  }>()
  const [resetBusy, setResetBusy] = useState(false)
  const [resetAcknowledged, setResetAcknowledged] = useState(false)
  const [resetMessage, setResetMessage] = useState('')
  const [resetAccount, setResetAccount] = useState<string>()
  const resetDialogRef = useRef<HTMLDialogElement>(null)
  const [managedProvider, setManagedProvider] = useState<{
    id: SubscriptionProvider
    name: string
  }>()
  // The configured set: one snapshot committed only when every read answers, so
  // a half-answered reconciliation can never drop or invent a row. The form's
  // confirmations stand in until the next successful read lands.
  const [snapshot, setSnapshot] = useState<RosterSnapshot>()
  const [ollamaSettings, setOllamaSettings] = useState<OllamaSettingsView>()
  /** The last full roster read's failure: it owns the row set and its Retry. */
  const [rosterError, setRosterError] = useState<string>()
  /** A status-only poll failure: the OAuth half is unknown, the rows are not. */
  const [statusError, setStatusError] = useState<string>()
  const [confirmed, setConfirmed] = useState<
    ReadonlyMap<RosterProviderId, ConfirmedRow>
  >(new Map())
  const [attention, setAttention] = useState<ReadonlySet<RosterProviderId>>(
    new Set(),
  )
  const [expanded, setExpanded] = useState<ReadonlySet<RosterProviderId>>(
    new Set(),
  )
  const [addMode, setAddMode] = useState(false)
  const [outcome, setOutcome] = useState<string>()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const returnFocus = useRef(false)

  useEffect(() => {
    if (resetConfirmation) resetDialogRef.current?.showModal()
    else resetDialogRef.current?.close()
  }, [resetConfirmation])

  const resetInflight = useRef(false)
  const mountedRef = useRef(true)
  const pollersRef = useRef(
    new Map<SubscriptionProvider, ReturnType<typeof setInterval>>(),
  )
  /** In-flight usage reads per key, holding the promise so a forced read can wait one out. */
  const usageInflightRef = useRef(new Map<string, Promise<void>>())
  const usageRosterSignatureRef = useRef<string>()
  /** Publication tickets: only the newest read of each kind may commit. */
  const rosterSeq = useRef(0)
  const statusSeq = useRef(0)
  /** The published snapshot, read by callbacks that must not depend on state. */
  const snapshotRef = useRef<RosterSnapshot>()
  const setProviderError = useCallback(
    (provider: SubscriptionProvider, message: string | undefined): void => {
      if (!mountedRef.current) return
      setErrors((prev) => {
        const next = { ...prev }
        if (message === undefined) delete next[provider]
        else next[provider] = message
        return next
      })
    },
    [],
  )

  const stopPolling = useCallback((provider: SubscriptionProvider): void => {
    const poller = pollersRef.current.get(provider)
    if (poller !== undefined) {
      clearInterval(poller)
      pollersRef.current.delete(provider)
    }
  }, [])

  /**
   * Publish one provider-status answer. This is the only place the OAuth state
   * moves, so a status poll and a roster read cannot disagree about it, and it
   * is what a sign-in attempt is judged by — never the roster read's other
   * halves.
   * @param providers - every OAuth provider's status.
   * @returns whether the set of accounts changed, which invalidates the rows.
   */
  const applyStatus = useCallback(
    (providers: StatusResponse['providers']): boolean => {
      setStatuses(providers)
      // The answer recovered: drop a poll-only failure, which is this half's own
      // error and not the last full read's.
      setStatusError(undefined)
      // A settled provider has no action error left to show; a busy one keeps
      // the error of the action that failed while its attempt still runs.
      for (const { id } of OAUTH_PROVIDERS) {
        if (providers[id].busy) continue
        setProviderError(id, undefined)
      }
      // The snapshot only moves on a full read, so an account added while that
      // read fails would otherwise leave the row stating the old count.
      for (const { id } of OAUTH_PROVIDERS) {
        const count = providers[id].accounts.length
        const snapshotCount =
          snapshotRef.current?.statuses[id]?.accounts.length ?? 0
        if (count === snapshotCount) continue
        setConfirmed((prev) => {
          const next = new Map(prev)
          next.set(id, {
            state: count > 1 ? 'accounts-many' : 'accounts-one',
            accounts: count,
          })
          return next
        })
      }
      for (const { id } of OAUTH_PROVIDERS) {
        const provider = providers[id]
        // A busy provider keeps its poller until the attempt itself settles: an
        // account already connected must not stop a second one being added.
        if (provider.busy) continue
        stopPolling(id)
        // The attempt settled (success, timeout, or cancel): drop the code card.
        setDeviceCodes((prev) => {
          if (prev[id] === undefined) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
      const signature = OAUTH_PROVIDERS.map(
        ({ id }) =>
          id +
          ':' +
          providers[id].accounts
            .map((account) => account.key + ':' + account.isDefault)
            .join(','),
      ).join(';')
      if (signature === usageRosterSignatureRef.current) return false
      const known = usageRosterSignatureRef.current !== undefined
      usageRosterSignatureRef.current = signature
      window.dispatchEvent(new Event(USAGE_BADGE_REFRESH_EVENT))
      // The first answer is the roster's own read; later changes come from an
      // attempt settling, and only then does the row set need re-reading.
      return known
    },
    [stopPolling, setProviderError],
  )

  /**
   * Read the whole configured set and commit it as one snapshot. Every required
   * answer must arrive: a partial answer is a failed read, so the rows of the
   * last successful read stay exactly as they were. A success also drops this
   * session's confirmations, because the routes are authoritative again.
   *
   * Reads overlap — a poll tick, an action, and a retry can all be in flight — so
   * each answer carries a ticket and only the newest one may publish. Without
   * that, a slow answer that predates a removal could resurrect the removed row.
   *
   * The Ollama credential is described only when an address could make a stored
   * Cloud key idle — a describe call proves presence without spending the key,
   * which is the one question `externalStatus` cannot answer at that address.
   * A host without the credential service reports nothing and the row keeps its
   * address state.
   */
  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    const rosterTicket = ++rosterSeq.current
    const statusTicket = ++statusSeq.current
    try {
      const [status, external, ollama] = await Promise.all([
        callSubscriptionsAuth<StatusResponse>(rpc, 'status', {}),
        callSubscriptionsAuth<Record<string, { configured: boolean }>>(
          rpc,
          'externalStatus',
          {},
        ),
        callSubscriptionsAuth<OllamaSettingsView>(rpc, 'ollamaSettings', {}),
      ])
      if (!mountedRef.current) return
      if (statusTicket === statusSeq.current) applyStatus(status.providers)
      const baseURL = ollama.settings?.baseURL
      const keyIdleHere =
        baseURL !== undefined &&
        baseURL !== '' &&
        external['ollama-cloud']?.configured !== true
      const keyStored = keyIdleHere
        ? await callSubscriptionsAuth<KeyCredentialView>(rpc, 'keyCredential', {
            route: 'ollama-cloud',
          })
            .then((view) => view.configured === true)
            .catch(() => false)
        : false
      if (!mountedRef.current || rosterTicket !== rosterSeq.current) return
      const next: RosterSnapshot = {
        statuses: status.providers,
        routes: {
          configured: external,
          ollama: {
            ...(baseURL === undefined ? {} : { baseURL }),
            keyStored,
          },
        },
      }
      snapshotRef.current = next
      setSnapshot(next)
      setOllamaSettings(ollama)
      setRosterError(undefined)
      setStatusError(undefined)
      setConfirmed(new Map())
    } catch (error) {
      // A failed read must not kill the page; busy providers keep polling. It
      // keeps the rows it already reported and is shown as a failure, but only
      // when no newer read has already answered.
      if (mountedRef.current && rosterTicket === rosterSeq.current)
        setRosterError(messageOf(error))
    }
  }, [rpc, applyStatus])

  /**
   * Poll the OAuth providers' status only. A sign-in attempt is judged by this
   * answer, so it keeps working when the roster's other halves fail; a changed
   * account set re-reads the roster.
   */
  const pollStatus = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    const ticket = ++statusSeq.current
    try {
      const status = await callSubscriptionsAuth<StatusResponse>(
        rpc,
        'status',
        {},
      )
      if (!mountedRef.current || ticket !== statusSeq.current) return
      if (applyStatus(status.providers)) void refresh()
    } catch (error) {
      // The OAuth half is unknown now: state it, keep the rows the last full read
      // reported, and let a later successful poll clear the line on its own.
      if (mountedRef.current && ticket === statusSeq.current)
        setStatusError(messageOf(error))
    }
  }, [rpc, applyStatus, refresh])

  const startPolling = useCallback(
    (provider: SubscriptionProvider): void => {
      // Central guard: nothing starts an interval for a component that is gone.
      if (!mountedRef.current) return
      if (pollersRef.current.has(provider)) return
      pollersRef.current.set(
        provider,
        setInterval(() => {
          void pollStatus()
        }, POLL_INTERVAL_MS),
      )
    },
    [pollStatus],
  )

  // Initial load; every busy provider (e.g. an attempt started before a page
  // reload) resumes polling. Teardown clears pollers and the mounted guard.
  useEffect(() => {
    mountedRef.current = true
    void refresh().then(() => {
      if (!mountedRef.current) return
      setStatuses((current) => {
        for (const { id } of OAUTH_PROVIDERS) {
          if (current[id]?.busy === true) startPolling(id)
        }
        return current
      })
    })
    return () => {
      mountedRef.current = false
      // The ref holds pollers started after this effect began. Copying .current
      // at setup would clear an empty set and leave those intervals running.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- read the live set at unmount
      for (const poller of pollersRef.current.values()) clearInterval(poller)
      pollersRef.current.clear()
    }
  }, [refresh, startPolling])

  const loadUsage = useCallback(
    async (
      provider: SubscriptionProvider,
      account: string,
      force = false,
    ): Promise<void> => {
      if (rpc === undefined) return
      const key = provider + ':' + account
      const pending = usageInflightRef.current.get(key)
      // A forced read must never be dropped behind a poll that started before the
      // state changed. The refresh after a credit redemption is the only thing
      // that picks up the new numbers, and the next automatic poll is minutes
      // away, so waiting the earlier read out is cheaper than showing a stale
      // percentage next to a success message.
      if (pending !== undefined) {
        if (!force) return
        await pending
      }
      if (rpc === undefined || usageInflightRef.current.has(key)) return
      const read = (async () => {
        setUsageLoading((prev) => ({ ...prev, [key]: true }))
        try {
          const usage = await callSubscriptionsAuth<ProviderUsage>(
            rpc,
            'usage',
            { provider, account, ...(force ? { force: true } : {}) },
          )
          if (!mountedRef.current) return
          setUsages((prev) => ({ ...prev, [key]: usage }))
          setObservedAt((prev) => ({
            ...prev,
            [key]: usage.observedAt ?? Date.now(),
          }))
          window.dispatchEvent(new Event(USAGE_BADGE_REFRESH_EVENT))
          setUsageErrors((prev) => {
            const next = { ...prev }
            delete next[key]
            return next
          })
        } catch (error) {
          if (mountedRef.current)
            setUsageErrors((prev) => ({ ...prev, [key]: messageOf(error) }))
        } finally {
          usageInflightRef.current.delete(key)
          if (mountedRef.current)
            setUsageLoading((prev) => ({ ...prev, [key]: false }))
        }
      })()
      usageInflightRef.current.set(key, read)
      await read
    },
    [rpc],
  )

  async function prepareReset(account: string): Promise<void> {
    if (!rpc || resetInflight.current) return
    resetInflight.current = true
    setResetBusy(true)
    setResetAccount(account)
    setResetConfirmation(undefined)
    setResetMessage('')
    try {
      const result = await callSubscriptionsAuth<
        Omit<NonNullable<typeof resetConfirmation>, 'account'>
      >(rpc, 'prepareReset', { account })
      setResetAcknowledged(false)
      setResetConfirmation({ ...result, account })
    } catch (error) {
      setResetMessage(messageOf(error))
    } finally {
      resetInflight.current = false
      setResetBusy(false)
    }
  }

  async function consumeReset(): Promise<void> {
    if (
      !rpc ||
      !resetConfirmation ||
      !resetAcknowledged ||
      resetInflight.current
    )
      return
    const { account, ticket } = resetConfirmation
    resetInflight.current = true
    setResetBusy(true)
    setResetConfirmation(undefined)
    try {
      await callSubscriptionsAuth(rpc, 'consumeReset', { account, ticket })
      setResetMessage(t('resetUseSuccess'))
    } catch (error) {
      setResetMessage(messageOf(error))
    } finally {
      await loadUsage('codex', account, true)
      resetInflight.current = false
      setResetBusy(false)
    }
  }

  // Drop the snapshots of accounts that vanished so a re-login refetches.
  useEffect(() => {
    const live = new Set<string>()
    for (const { id } of OAUTH_PROVIDERS) {
      for (const account of statuses[id]?.accounts ?? []) {
        live.add(id + ':' + account.key)
      }
    }
    setUsages((prev) => dropStale(prev, live))
    setUsageErrors((prev) => dropStale(prev, live))
  }, [statuses, usages, usageErrors])

  // Read usage for an expanded row only: a collapsed roster performs no usage
  // read, and expanding a row starts the read its card performed on mount.
  useEffect(() => {
    for (const { id } of OAUTH_PROVIDERS) {
      if (!expanded.has(id)) continue
      for (const account of statuses[id]?.accounts ?? []) {
        const key = id + ':' + account.key
        if (usages[key] === undefined && usageErrors[key] === undefined)
          void loadUsage(id, account.key)
      }
    }
  }, [expanded, statuses, usages, usageErrors, loadUsage])

  const login = useCallback(
    async (
      provider: SubscriptionProvider,
      method?: 'oauth' | 'keychain',
    ): Promise<void> => {
      if (rpc === undefined) return
      setProviderError(provider, undefined)
      try {
        const response = await callSubscriptionsAuth<LoginResponse>(
          rpc,
          'login',
          {
            provider,
            ...(method === undefined ? {} : { method }),
          },
        )
        if (
          typeof response.authorizeUrl === 'string' &&
          response.authorizeUrl === ''
        ) {
          // Instant login (e.g. imported from Claude Code credentials)
          await pollStatus()
          return
        }
        if (typeof response.authorizeUrl !== 'string') {
          throw new SubscriptionsAuthError(t('loginMissingUrl'))
        }
        if (!mountedRef.current) return
        // Optimistic busy so Cancel and the manual fallback appear before the first poll tick.
        setStatuses((prev) => ({
          ...prev,
          [provider]: {
            accounts: prev[provider]?.accounts ?? [],
            ...prev[provider],
            busy: true,
          },
        }))
        if (
          typeof response.userCode === 'string' &&
          response.userCode.length > 0
        ) {
          // Device flow: show the code card instead of opening the page blind —
          // the user copies the code first, then opens the verification page.
          setDeviceCodes((prev) => ({
            ...prev,
            [provider]: {
              userCode: response.userCode as string,
              verificationUrl: response.authorizeUrl,
            },
          }))
        } else {
          window.open(response.authorizeUrl, '_blank', 'noopener')
        }
        startPolling(provider)
      } catch (error) {
        setProviderError(provider, messageOf(error))
      }
    },
    [rpc, t, setProviderError, startPolling, pollStatus],
  )

  const cancel = useCallback(
    async (provider: SubscriptionProvider): Promise<void> => {
      if (rpc === undefined) return
      stopPolling(provider)
      try {
        await callSubscriptionsAuth<{ ok: true }>(rpc, 'cancel', { provider })
      } catch (error) {
        // The attempt may still be running: keep observing it so the form is not
        // left waiting with nothing polling, and keep the failure on screen.
        setProviderError(provider, messageOf(error))
      }
      // The settings page can close while this request is in flight; a poller
      // started now would outlive the component and read forever.
      if (!mountedRef.current) return
      // Whatever the cancel answered, the attempt is only over when the host says
      // so; the poller stops itself on the first settled answer.
      startPolling(provider)
      await pollStatus()
    },
    [rpc, stopPolling, startPolling, setProviderError, pollStatus],
  )

  const submitManual = useCallback(
    async (provider: SubscriptionProvider, value?: string): Promise<void> => {
      if (rpc === undefined) return
      const input = (value ?? manualDrafts[provider]).trim()
      if (input === '') return
      setProviderError(provider, undefined)
      try {
        await callSubscriptionsAuth<{ ok: true }>(rpc, 'manual', {
          provider,
          input,
        })
        if (mountedRef.current)
          setManualDrafts((prev) => ({ ...prev, [provider]: '' }))
      } catch (error) {
        setProviderError(provider, messageOf(error))
      }
      await pollStatus()
    },
    [rpc, manualDrafts, setProviderError, pollStatus],
  )

  const logout = useCallback(
    async (
      provider: SubscriptionProvider,
      account: string,
      display: string,
      name: string,
    ): Promise<void> => {
      if (rpc === undefined) return
      if (
        !window.confirm(
          t('logoutAccountConfirm', { provider: name, account: display }),
        )
      )
        return
      setProviderError(provider, undefined)
      try {
        await callSubscriptionsAuth<{ ok: true }>(rpc, 'logout', {
          provider,
          account,
        })
      } catch (error) {
        setProviderError(provider, messageOf(error))
      }
      await pollStatus()
    },
    [rpc, t, setProviderError, pollStatus],
  )

  const setDefault = useCallback(
    async (provider: SubscriptionProvider, account: string): Promise<void> => {
      if (rpc === undefined) return
      setProviderError(provider, undefined)
      try {
        await callSubscriptionsAuth<{ ok: true }>(rpc, 'setDefault', {
          provider,
          account,
        })
      } catch (error) {
        setProviderError(provider, messageOf(error))
      }
      await pollStatus()
    },
    [rpc, setProviderError, pollStatus],
  )

  const copyDeviceCode = useCallback(
    (provider: SubscriptionProvider, userCode: string): void => {
      void navigator.clipboard
        ?.writeText(userCode)
        .then(() => {
          if (!mountedRef.current) return
          setCopiedCode(provider)
          setTimeout(() => {
            if (mountedRef.current) {
              setCopiedCode((current) =>
                current === provider ? undefined : current,
              )
            }
          }, 1500)
        })
        .catch(() => undefined)
    },
    [],
  )

  /** Which of the three list states the last read left the roster in. */
  const answered = snapshot !== undefined
  /** A full-read failure owns the row set; a poll failure only withholds status. */
  const failure = rosterError ?? statusError
  const phase = answered
    ? 'ready'
    : failure === undefined
      ? 'checking'
      : 'failed'
  const rows = configuredRows({
    statuses: snapshot?.statuses ?? {},
    routes: snapshot?.routes,
    confirmed,
    attention,
  })
  const configuredIdSet = new Set(rows.map((row) => row.id))

  const confirmAddition = useCallback(
    (provider: RosterProviderId, state: RowState, message: string): void => {
      // The confirmation is authoritative: the row must not wait for the read
      // that reconciles it, or a failed read would hide what the route confirmed.
      setConfirmed((prev) => {
        const next = new Map(prev)
        next.set(provider, {
          state,
          ...(state === 'accounts-one' ? { accounts: 1 } : {}),
          ...(state === 'accounts-many' ? { accounts: 2 } : {}),
        })
        return next
      })
      setAttention((prev) => {
        if (!prev.has(provider)) return prev
        const next = new Set(prev)
        next.delete(provider)
        return next
      })
      setOutcome(message)
      setAddMode(false)
      returnFocus.current = true
      void refresh()
    },
    [refresh],
  )

  /**
   * Leave the form without adding anything. The form unmounts while the reader's
   * focus is inside it, so the roster heading takes focus back — a cancel must not
   * drop a keyboard reader onto the page body.
   */
  const cancelAddition = useCallback((): void => {
    setAddMode(false)
    returnFocus.current = true
  }, [])

  const markAttention = useCallback(
    (provider: RosterProviderId): void => {
      setAttention((prev) => new Set(prev).add(provider))
      void refresh()
    },
    [refresh],
  )

  /** A route the reader has since proven: drop the rejected-credential mark. */
  const clearAttention = useCallback((provider: RosterProviderId): void => {
    setAttention((prev) => {
      if (!prev.has(provider)) return prev
      const next = new Set(prev)
      next.delete(provider)
      return next
    })
  }, [])

  // Focus returns to the roster heading whenever the form closes, on a
  // confirmation or a cancel, so the reader keeps their place.
  useEffect(() => {
    if (addMode || !returnFocus.current) return
    returnFocus.current = false
    headingRef.current?.focus()
  }, [addMode])

  function toggleRow(row: RosterProviderId): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(row)) next.delete(row)
      else next.add(row)
      return next
    })
  }

  function openAdd(): void {
    setOutcome(undefined)
    setAddMode(true)
  }

  function renderDetail(row: ConfiguredRow) {
    if (rpc === undefined) return null
    if (row.family === 'oauth') {
      const id = row.id as SubscriptionProvider
      return OAuthDetail({
        t,
        provider: id,
        status: statuses[id],
        error: errors[id],
        usages,
        observedAt,
        usageErrors,
        usageLoading,
        deviceCode: deviceCodes[id],
        copiedCode: copiedCode === id,
        manualDraft: manualDrafts[id],
        resetBusy,
        resetAccount,
        resetMessage,
        onManualDraft: (value) =>
          setManualDrafts((prev) => ({ ...prev, [id]: value })),
        onManualSubmit: () => {
          void submitManual(id)
        },
        onLogin: (method) => {
          void login(id, method)
        },
        onCancel: () => {
          void cancel(id)
        },
        onLogout: (account, display) => {
          void logout(id, account, display, row.name)
        },
        onSetDefault: (account) => {
          void setDefault(id, account)
        },
        onCopyDeviceCode: (code) => copyDeviceCode(id, code),
        onRefreshUsage: (account) => {
          void loadUsage(id, account, true)
        },
        onManage: () => setManagedProvider({ id, name: row.name }),
        onPrepareReset: (account) => {
          void prepareReset(account)
        },
      })
    }
    if (row.family === 'cursor')
      return (
        <CursorCard
          rpc={rpc}
          t={t}
          variant="row"
          onChanged={() => {
            // A key saved or removed here changes which rows exist.
            void refresh()
          }}
          onCredentialValid={() => {
            clearAttention('cursor')
            void refresh()
          }}
        />
      )
    if (row.family === 'ollama')
      return (
        <OllamaCard
          rpc={rpc}
          t={t}
          variant="row"
          onChanged={() => {
            void refresh()
          }}
          onCredentialValid={() => {
            clearAttention('ollama')
            void refresh()
          }}
        />
      )
    return (
      <ExternalUsageDetail rpc={rpc} t={t} source={row.id as ExternalSource} />
    )
  }

  if (rpc === undefined) {
    return <p style={styles.intro}>{t('unavailable')}</p>
  }

  return (
    <div className="dsh-subscriptions-settings" style={styles.section}>
      <style>{providerSettingsCss}</style>
      {addMode ? (
        <AddProviderForm
          rpc={rpc}
          t={t}
          configured={configuredIdSet}
          ollamaSettings={ollamaSettings}
          statuses={statuses}
          deviceCodes={deviceCodes}
          errors={errors}
          copiedCode={copiedCode}
          onStartLogin={(provider, method) => login(provider, method)}
          onCancelAttempt={(provider) => {
            void cancel(provider)
          }}
          onManualSubmit={(provider, value) => {
            void submitManual(provider, value)
          }}
          onCopyDeviceCode={copyDeviceCode}
          onCancel={cancelAddition}
          onConfirmed={confirmAddition}
          onNeedsAttention={markAttention}
        />
      ) : (
        <>
          <div style={rosterStyles.band}>
            <details>
              <summary style={rosterStyles.bandTrigger}>
                {t('rosterPreferences')}
              </summary>
              <div style={rosterStyles.bandBody}>
                <UsageBadgeDisplaySetting t={t} variant="plain" />
              </div>
            </details>
          </div>
          {ProviderRoster({
            t,
            rows,
            phase,
            ...(failure === undefined ? {} : { error: failure }),
            ...(outcome === undefined ? {} : { outcome }),
            expanded,
            onToggle: toggleRow,
            onAdd: openAdd,
            onRetry: () => {
              void refresh()
            },
            headingRef,
            renderDetail,
          })}
        </>
      )}
      {managedProvider && (
        <ProviderAccountManager
          provider={managedProvider.id}
          name={managedProvider.name}
          rpc={rpc}
          t={t}
          onClose={() => {
            setManagedProvider(undefined)
            void refresh()
          }}
        />
      )}
      <style>
        {
          '.subscriptions-reset-dialog::backdrop { background: var(--dsw-alias-bg-mask-1, #0006); backdrop-filter: var(--dsw-mask-blur, none); }'
        }
      </style>
      <dialog
        ref={resetDialogRef}
        className="subscriptions-reset-dialog"
        aria-labelledby="subscriptions-reset-title"
        onCancel={() => setResetConfirmation(undefined)}
        onClose={() => setResetConfirmation(undefined)}
        style={{
          ...styles.modal,
          display: resetConfirmation ? 'flex' : 'none',
          margin: 'auto',
          color: 'var(--dsw-alias-label-primary)',
        }}
      >
        {resetConfirmation && (
          <>
            <h3
              id="subscriptions-reset-title"
              style={{ ...styles.modalTitle, margin: 0 }}
            >
              {t('resetUseConfirmTitle')}
            </h3>
            <p style={{ ...styles.statusLine, overflowWrap: 'anywhere' }}>
              {statuses.codex?.accounts.find(
                (a) => a.key === resetConfirmation.account,
              )?.account ?? resetConfirmation.account}
            </p>
            <div style={{ ...styles.usageMeta, gap: 12 }}>
              <span>{t('usageWeekly')}</span>
              <strong>
                {Math.round(resetConfirmation.weeklyUsedPercent)}%
              </strong>
            </div>
            <div style={styles.usageMeta}>
              <span>
                {resetConfirmation.creditExpiresAt === undefined
                  ? t('resetCreditExpiryUnknown')
                  : t('resetCreditExpires', {
                      date: new Date(
                        resetConfirmation.creditExpiresAt,
                      ).toLocaleString(),
                    })}
              </span>
            </div>
            <p style={{ ...styles.statusLine, margin: '4px 0' }}>
              {t('resetUseWarning')}
            </p>
            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                fontSize: 12,
              }}
            >
              <input
                type="checkbox"
                checked={resetAcknowledged}
                onChange={(e) => setResetAcknowledged(e.target.checked)}
              />
              {t('resetUseAcknowledge')}
            </label>
            <div
              className="dsh-subscription-dialog-actions"
              style={{
                ...styles.actions,
                justifyContent: 'flex-end',
                marginTop: 8,
              }}
            >
              <button
                type="button"
                autoFocus
                onClick={() => setResetConfirmation(undefined)}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="dsh-subscription-primary"
                disabled={!resetAcknowledged || resetBusy}
                onClick={() => {
                  void consumeReset()
                }}
              >
                {t('resetUseConfirm')}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  )
}
