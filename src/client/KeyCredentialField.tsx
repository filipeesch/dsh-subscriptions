/**
 * The credential field for a key-based route.
 *
 * The card states where the key currently comes from — the DSH store, the
 * environment, or nowhere — shows the host's masked preview when it reports one,
 * and offers save, replace, and remove. The value crosses to the host only:
 * nothing here can read it back.
 *
 * A save is validated by the route's own read, passed in by the card that owns
 * the route. A failed validation keeps the saved key, because a rejected key and
 * a failed request both need somewhere to land before the person can correct it;
 * the failure sentence is fixed, because the route's own error text can carry
 * provider detail this surface must not echo.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { subscriptionCardStyles } from './subscription-card-styles.js'

type Translate = SubscriptionsSectionInjected['t']

/** The key-based routes this plugin serves. */
export type KeyRoute = 'cursor' | 'ollama-cloud'

/** One route's credential as the host describes it; never the value. */
export interface KeyCredentialView {
  route: KeyRoute
  /** The reference the route reads, already resolved from its configuration. */
  keyRef: string
  configured: boolean
  /** Source layer supplying the value: `file`, `env`, `project-env`, `user-env`. */
  source?: string
  writable: boolean
  /** Host-generated masked preview; absent on hosts that do not produce one. */
  masked?: string
}

/**
 * The host's answer to a write or a removal: `committed` says the store write
 * landed, `view` is the state read back after it, and `readError` says the
 * state could not be read although the write did land.
 */
export interface KeyCredentialResult {
  committed: boolean
  view?: KeyCredentialView
  readError?: string
  /** The host's generation of the stored credential at commit time. */
  generation: number
}

/** The host's answer to validating a committed credential. */
export interface KeyValidationResult {
  outcome: 'valid' | 'invalid' | 'superseded'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The sentence stating where the key comes from. The source layer names the
 * place the person has to change: the DSH store is the card's own save and
 * remove, while the environment belongs to the shell or the `.env` file.
 * @param t - section translate.
 * @param view - the host's description of the route's credential.
 * @returns the origin line the card shows.
 */
export function credentialOriginText(
  t: Translate,
  view: KeyCredentialView,
): string {
  const params = { ref: view.keyRef }
  if (!view.configured) return t('credentialMissing', params)
  if (view.source === 'file') {
    return view.masked === undefined
      ? t('credentialStored', params)
      : t('credentialStoredMasked', { ...params, masked: view.masked })
  }
  if (view.source === 'project-env' || view.source === 'user-env')
    return t('credentialFromEnvFile', {
      ...params,
      source:
        view.source === 'project-env'
          ? t('credentialSourceProjectEnv')
          : t('credentialSourceUserEnv'),
    })
  if (view.source === 'env') return t('credentialFromEnv', params)
  return t('credentialConfigured', params)
}

/** One button style, dimmed while the control is disabled. */
function buttonStyle(disabled: boolean): CSSProperties {
  return {
    ...subscriptionCardStyles.button,
    ...(disabled ? { opacity: 0.5, cursor: 'default' } : {}),
  }
}

/**
 * One key route's credential controls.
 * @param props.rpc - connection RPC caller.
 * @param props.t - section translate.
 * @param props.route - the key route this field belongs to.
 * @param props.validate - the route's own read, run after a save; its rejection
 *   is reported while the key stays saved.
 * @param props.onChanged - called after a save or a removal commits; it must not
 *   remount this field, or the pending validation outcome would be lost.
 */
export function KeyCredentialField({
  rpc,
  t,
  route,
  onChanged,
}: {
  rpc: ConnectionHandle['rpc']
  t: Translate
  route: KeyRoute
  onChanged?: () => void
}) {
  const [view, setView] = useState<KeyCredentialView>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'saving' | 'validating' | 'done'>(
    'idle',
  )
  const [lookupError, setLookupError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [outcome, setOutcome] = useState<string>()
  const [validationError, setValidationError] = useState<string>()
  // One writer per field: a lookup that started before a write must not
  // overwrite what the write answered, and the two must not interleave.
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = ++generation.current
    try {
      const value = await callSubscriptionsAuth<KeyCredentialView>(
        rpc,
        'keyCredential',
        { route },
      )
      if (generation.current !== mine) return
      setView(value)
      setLookupError(undefined)
    } catch (error) {
      if (generation.current !== mine) return
      setLookupError(message(error))
    }
  }, [rpc, route])

  useEffect(() => {
    void load()
  }, [load])

  /** Re-read the state without taking over the field from a newer operation. */
  const readState = async (): Promise<KeyCredentialView | undefined> => {
    try {
      const value = await callSubscriptionsAuth<KeyCredentialView>(
        rpc,
        'keyCredential',
        { route },
      )
      setView(value)
      setLookupError(undefined)
      return value
    } catch (error) {
      setLookupError(message(error))
      return undefined
    }
  }

  /** Open one write window: clear the outcomes, lock the controls, own the field. */
  const begin = (): number => {
    setActionError(undefined)
    setOutcome(undefined)
    setValidationError(undefined)
    setBusy(true)
    setPhase('saving')
    return ++generation.current
  }

  const save = async (): Promise<void> => {
    const value = draft.trim()
    const mine = begin()
    try {
      const result = await callSubscriptionsAuth<KeyCredentialResult>(
        rpc,
        'keySetCredential',
        { route, value },
      )
      if (generation.current !== mine) return
      // A successful envelope still has to say the store write landed; an
      // uncommitted write must not read as a success.
      if (!result.committed) {
        setActionError(t('credentialNotCommitted'))
        setPhase('idle')
        return
      }
      if (result.view !== undefined) {
        setView(result.view)
        setLookupError(undefined)
      } else {
        // The state read back failed: the controls must not keep describing the
        // previous state. Drop the view and read it again.
        setView(undefined)
        setOutcome(t('credentialSavedUnread'))
        await readState()
      }
      try {
        onChanged?.()
      } catch {
        // The card's refresh is best-effort; the write already landed.
      }
      setDraft('')
      // The field stays locked here: a later save must not be followed by this
      // validation's error. The host runs the route's read against the
      // generation this commit reported, so a concurrent change is its own
      // outcome instead of a success for the wrong credential.
      setPhase('validating')
      let outcome: KeyValidationResult
      try {
        outcome = await callSubscriptionsAuth<KeyValidationResult>(
          rpc,
          'keyValidateCredential',
          // The host reads the committed credential itself; naming the write is
          // enough, and a caller-supplied value could name a key it never saved.
          { route, generation: result.generation },
        )
      } catch {
        outcome = { outcome: 'invalid' }
      }
      if (generation.current !== mine) return
      if (outcome.outcome === 'superseded') {
        setOutcome(t('credentialSuperseded'))
        await readState()
        if (generation.current === mine) setPhase('idle')
        return
      }
      if (outcome.outcome === 'invalid') {
        setValidationError(t('credentialValidationFailed'))
        setPhase('idle')
        return
      }
      // The host proved the key against its route; the state is re-read so a key
      // the store no longer holds is not reported as usable.
      const state = await readState()
      if (generation.current !== mine) return
      if (state !== undefined && !state.configured) {
        setActionError(t('credentialGone'))
        setPhase('idle')
        return
      }
      setPhase('done')
    } catch (error) {
      if (generation.current !== mine) return
      setActionError(t('credentialSaveFailed', { message: message(error) }))
      setPhase('idle')
    } finally {
      if (generation.current === mine) setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    const mine = begin()
    try {
      const result = await callSubscriptionsAuth<KeyCredentialResult>(
        rpc,
        'keyClearCredential',
        { route },
      )
      if (generation.current !== mine) return
      if (!result.committed) {
        setActionError(t('credentialNotRemoved'))
        setPhase('idle')
        return
      }
      if (result.view !== undefined) {
        setView(result.view)
        setLookupError(undefined)
      } else {
        setView(undefined)
        setOutcome(t('credentialRemovedUnread'))
        await readState()
      }
      try {
        onChanged?.()
      } catch {
        // The card's refresh is best-effort; the removal already landed.
      }
      setPhase('done')
    } catch (error) {
      if (generation.current !== mine) return
      setActionError(t('credentialRemoveFailed', { message: message(error) }))
      setPhase('idle')
    } finally {
      if (generation.current === mine) setBusy(false)
    }
  }

  const origin = view === undefined ? undefined : credentialOriginText(t, view)
  const originId = `credential-origin-${route}`
  const blocked = busy || view?.writable !== true
  const fromEnvironment =
    view?.source === 'env' ||
    view?.source === 'project-env' ||
    view?.source === 'user-env'
  const actionLabel =
    fromEnvironment && view.configured
      ? t('credentialOverride')
      : view?.configured === true
        ? t('credentialReplace')
        : t('credentialSave')
  return (
    <form
      aria-label={t('credentialLabel')}
      style={subscriptionCardStyles.account}
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked && draft.trim() !== '') void save()
      }}
    >
      <span style={subscriptionCardStyles.status} id={originId}>
        {t('credentialLabel')}
        {origin === undefined ? '' : ` · ${origin}`}
      </span>
      {lookupError !== undefined && (
        <span style={subscriptionCardStyles.error} role="alert">
          {t('credentialLookupFailed', { message: lookupError })}
        </span>
      )}
      {view !== undefined && (
        <>
          <input
            type="password"
            autoComplete="off"
            aria-label={t('credentialPlaceholder')}
            aria-describedby={originId}
            placeholder={t('credentialPlaceholder')}
            value={draft}
            disabled={blocked}
            onChange={(event) => setDraft(event.target.value)}
            style={{
              boxSizing: 'border-box',
              width: '100%',
              maxWidth: 320,
              padding: '4px 6px',
              fontSize: 12,
              color: 'inherit',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: 4,
            }}
          />
          <div style={subscriptionCardStyles.actions}>
            <button
              type="submit"
              style={buttonStyle(blocked || draft.trim() === '')}
              disabled={blocked || draft.trim() === ''}
            >
              {actionLabel}
            </button>
            {view.source === 'file' && (
              <button
                type="button"
                style={buttonStyle(blocked)}
                disabled={blocked}
                onClick={() => {
                  void remove()
                }}
              >
                {t('credentialRemove')}
              </button>
            )}
            {!view.writable && (
              <span style={subscriptionCardStyles.status}>
                {t('credentialNotWritable')}
              </span>
            )}
          </div>
          {view.source === 'file' && (
            <span style={subscriptionCardStyles.status}>
              {t('credentialRemoveHint')}
            </span>
          )}
        </>
      )}
      {actionError !== undefined && (
        <span style={subscriptionCardStyles.error} role="alert">
          {actionError}
        </span>
      )}
      {/* One region, always mounted, so saving, validating, and the outcome are
          all announced in the order they happen. */}
      <span
        style={subscriptionCardStyles.status}
        role="status"
        aria-live="polite"
      >
        {phase === 'saving'
          ? t('credentialSaving')
          : phase === 'validating'
            ? t('credentialValidating')
            : (validationError ??
              outcome ??
              (phase === 'done' ? t('credentialSaved') : ''))}
      </span>
    </form>
  )
}
