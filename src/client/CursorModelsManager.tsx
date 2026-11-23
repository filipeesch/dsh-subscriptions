import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { cursorManagerCss } from './cursor-manager-styles.js'
import { providerSettingsCss } from './provider-settings-styles.js'
import {
  deriveRows,
  filterRows,
  listStateFor,
  parseWindowInput,
  rowCounts,
  withModelEdit,
  type CursorModelDraft,
  type CursorModelsView,
} from './cursor-manager-derive.js'
import { CursorModelsBody } from './CursorModelsBody.js'
import { CursorCapacitySection } from './CursorCapacitySource.js'

type Translate = SubscriptionsSectionInjected['t']

/** How long a typed window waits before it is written. */
export const WRITE_PAUSE_MS = 500

/** What one manual refresh reported. */
interface CursorRefreshOutcome {
  enabled: boolean
  status: 'refreshed' | 'failed' | 'unavailable'
  fetchedAt?: number
  reason?: string
  windows?: number
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Remove one key from a record, returning the same object when absent. */
function without<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  if (!Object.hasOwn(record, key)) return { ...record }
  const next = { ...record }
  delete next[key]
  return next
}

/**
 * The model manager dialog.
 *
 * It owns the catalog read, the edits, and the writes; the rows it renders come
 * from {@link deriveRows}, so a change and the value the host holds are the same
 * value. Every change is applied when the reader makes it: an enablement change
 * writes at once, a typed window writes after a short pause, and a failed write
 * restores what the route holds and states the failure in the row.
 */
export function CursorModelsManager({
  rpc,
  t,
  onClose,
  onSaved,
}: {
  rpc: ConnectionHandle['rpc']
  t: Translate
  onClose: () => void
  onSaved: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const description = useId()
  const [view, setView] = useState<CursorModelsView>()
  const [draft, setDraft] = useState<CursorModelDraft>({})
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<string>()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [pageError, setPageError] = useState('')
  const [sourceBusy, setSourceBusy] = useState(false)
  const [sourceError, setSourceError] = useState<string>()
  const [sourceNotice, setSourceNotice] = useState<string>()

  const alive = useRef(true)
  /** The browser's liveness answer for callbacks the dialog registered. */
  const draftRef = useRef<CursorModelDraft>({})
  const textsRef = useRef<Record<string, string>>({})
  const errorsRef = useRef<Record<string, string>>({})
  const editingRef = useRef<string>()
  const viewRef = useRef<CursorModelsView>()
  /** Writes are chained so the last one to land carries the latest changes. */
  const writeChain = useRef<Promise<void>>(Promise.resolve())
  const pause = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    alive.current = true
    const element = dialog.current!
    const previous = document.activeElement
    if (typeof element.showModal === 'function') element.showModal()
    return () => {
      alive.current = false
      if (pause.current !== undefined) clearTimeout(pause.current)
      if (typeof element.close === 'function') element.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus()
    }
  }, [])

  /** Seed the page from one host read; the host's rows are the truth. */
  const adopt = useCallback((next: CursorModelsView) => {
    viewRef.current = next
    setView(next)
    draftRef.current = {}
    setDraft({})
    textsRef.current = {}
    setTexts({})
    editingRef.current = undefined
    setEditing(undefined)
    errorsRef.current = {}
    setErrors({})
  }, [])

  const load = useCallback(
    async (force: boolean) => {
      if (force) setReloading(true)
      else setLoading(true)
      setPageError('')
      try {
        const data = await callSubscriptionsAuth<CursorModelsView>(
          rpc,
          'cursorModels',
          force ? { force: true } : {},
        )
        if (!alive.current) return
        adopt(data)
      } catch (failure) {
        if (!alive.current) return
        const text = t('cursorModelsLoadFailed', { message: message(failure) })
        // A failed reload keeps the rows on screen and states the failure.
        setPageError(text)
      } finally {
        if (alive.current) {
          setLoading(false)
          setReloading(false)
        }
      }
    },
    [adopt, rpc, t],
  )

  useEffect(() => {
    void load(false)
    // The dialog reads once on open; Reload is the explicit refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on mount
  }, [])

  const nameOf = (id: string): string =>
    viewRef.current?.models.find((model) => model.id === id)?.name ?? id

  const state = (): {
    draft: CursorModelDraft
    texts: Record<string, string>
  } => ({
    draft: draftRef.current,
    texts: textsRef.current,
  })

  const write = useCallback(
    (next: CursorModelDraft, previous: CursorModelDraft, id: string) => {
      writeChain.current = writeChain.current.then(async () => {
        try {
          await callSubscriptionsAuth(rpc, 'cursorSetSettings', {
            settings: { models: next },
          })
          if (!alive.current) return
          errorsRef.current = without(errorsRef.current, id)
          setErrors(errorsRef.current)
          onSaved()
        } catch (failure) {
          if (!alive.current) return
          // The row returns to what the route holds: a screen that keeps a
          // value the route rejected describes a window the host never meters.
          draftRef.current = previous
          setDraft(previous)
          const text = t('cursorModelWriteFailed', {
            model: nameOf(id),
            message: message(failure),
          })
          errorsRef.current = { ...errorsRef.current, [id]: text }
          setErrors(errorsRef.current)
        }
      })
    },
    [onSaved, rpc, t],
  )

  const commit = useCallback(
    (next: CursorModelDraft, id: string) => {
      const previous = draftRef.current
      if (JSON.stringify(next) === JSON.stringify(previous)) return
      draftRef.current = next
      setDraft(next)
      write(next, previous, id)
    },
    [write],
  )

  const toggle = useCallback(
    (id: string, enabled: boolean) => {
      commit(withModelEdit(state().draft, id, { enabled }), id)
    },
    [commit],
  )

  const reset = useCallback(
    (id: string) => {
      textsRef.current = without(textsRef.current, id)
      setTexts(textsRef.current)
      errorsRef.current = without(errorsRef.current, id)
      setErrors(errorsRef.current)
      commit(withModelEdit(state().draft, id, { contextWindow: undefined }), id)
    },
    [commit],
  )

  const open = useCallback((id: string) => {
    editingRef.current = id
    setEditing(id)
  }, [])

  const cancel = useCallback(() => {
    const id = editingRef.current
    if (id === undefined) return
    textsRef.current = without(textsRef.current, id)
    setTexts(textsRef.current)
    errorsRef.current = without(errorsRef.current, id)
    setErrors(errorsRef.current)
    editingRef.current = undefined
    setEditing(undefined)
  }, [])

  /** Write the open field: an empty one clears the override. */
  const commitText = useCallback(
    (id: string) => {
      if (editingRef.current !== id) return
      const text = textsRef.current[id] ?? ''
      const tokens = parseWindowInput(text)
      if (text.trim() !== '' && tokens === null) {
        errorsRef.current = {
          ...errorsRef.current,
          [id]: t('cursorModelWindowInvalid', { model: nameOf(id) }),
        }
        setErrors(errorsRef.current)
        return
      }
      editingRef.current = undefined
      setEditing(undefined)
      textsRef.current = without(textsRef.current, id)
      setTexts(textsRef.current)
      errorsRef.current = without(errorsRef.current, id)
      setErrors(errorsRef.current)
      commit(
        withModelEdit(state().draft, id, {
          contextWindow: tokens ?? undefined,
        }),
        id,
      )
    },
    [commit, t],
  )

  const changeText = useCallback(
    (id: string, text: string) => {
      textsRef.current = { ...textsRef.current, [id]: text }
      setTexts(textsRef.current)
      if (pause.current !== undefined) clearTimeout(pause.current)
      pause.current = setTimeout(() => commitText(id), WRITE_PAUSE_MS)
    },
    [commitText],
  )

  const refreshSource = useCallback(async () => {
    setSourceBusy(true)
    setSourceError(undefined)
    setSourceNotice(undefined)
    try {
      const outcome = await callSubscriptionsAuth<CursorRefreshOutcome>(
        rpc,
        'cursorRefreshContext',
        {},
      )
      if (!alive.current) return
      if (outcome.status === 'refreshed') {
        setSourceNotice(
          t('cursorCapacityRefreshed', { count: outcome.windows ?? 0 }),
        )
        // The windows the rows show come from the new projection.
        await load(false)
        onSaved()
        return
      }
      if (outcome.status === 'failed') {
        setSourceError(
          t(
            outcome.fetchedAt === undefined
              ? 'cursorSourceRefreshFailedNoCache'
              : 'cursorSourceRefreshFailedRetained',
            { message: outcome.reason ?? '' },
          ),
        )
        return
      }
      setSourceNotice(
        outcome.reason === 'disabled'
          ? t('cursorCapacityDisabledRefresh')
          : t('cursorCapacityNoModels'),
      )
    } catch (failure) {
      if (!alive.current) return
      setSourceError(
        t(
          viewRef.current?.knownContext.fetchedAt === undefined
            ? 'cursorSourceRefreshFailedNoCache'
            : 'cursorSourceRefreshFailedRetained',
          { message: message(failure) },
        ),
      )
    } finally {
      if (alive.current) setSourceBusy(false)
    }
  }, [load, onSaved, rpc, t])

  const setSource = useCallback(
    async (enabled: boolean) => {
      setSourceBusy(true)
      setSourceError(undefined)
      setSourceNotice(undefined)
      try {
        await callSubscriptionsAuth(rpc, 'cursorSetSettings', {
          settings: { publishedContext: enabled },
        })
        if (!alive.current) return
        // A switched source serves or withholds capacities at once.
        await load(false)
        onSaved()
      } catch (failure) {
        if (!alive.current) return
        setSourceError(
          t('cursorCapacityToggleFailed', { message: message(failure) }),
        )
      } finally {
        if (alive.current) setSourceBusy(false)
      }
    },
    [load, onSaved, rpc, t],
  )

  const rows =
    view === undefined
      ? []
      : deriveRows(view.models, draft, texts, editing, errors)
  const shown = filterRows(rows, query)
  const counts = rowCounts(rows)
  const summary =
    rows.length === 0
      ? undefined
      : t('cursorModelsSummary', {
          enabled: counts.enabled,
          total: counts.total,
        })

  return (
    <dialog
      className="dsh-subscription-manager dsh-cursor-manager"
      ref={dialog}
      aria-labelledby={title}
      aria-describedby={description}
      onClose={onClose}
      style={{
        width: 'min(720px, calc(100vw - 32px))',
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100dvh - 32px)',
        overflow: 'hidden',
      }}
    >
      <style>{providerSettingsCss}</style>
      <style>{cursorManagerCss}</style>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 20,
          maxHeight: 'calc(100dvh - 72px)',
          minWidth: 0,
        }}
      >
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <h2 id={title} style={{ margin: 0 }}>
            {t('cursorManageTitle')}
          </h2>
          <button type="button" autoFocus onClick={onClose}>
            {t('imageClose')}
          </button>
        </header>
        <p id={description} className="dsh-subscription-hint">
          {t('cursorManageHint')}
        </p>
        {pageError !== '' && <p role="alert">{pageError}</p>}
        {loading && view === undefined && (
          <p role="status" className="dsh-subscription-hint">
            {t('cursorModelsLoading')}
          </p>
        )}
        {view !== undefined && (
          <>
            <div className="dsh-cursor-toolbar">
              <input
                value={query}
                placeholder={t('modelDefaultsFilterPlaceholder')}
                aria-label={t('modelDefaultsFilterPlaceholder')}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button
                type="button"
                disabled={reloading}
                onClick={() => {
                  void load(true)
                }}
              >
                {reloading
                  ? t('cursorModelsReloading')
                  : t('cursorModelsReload')}
              </button>
            </div>
            {summary !== undefined && (
              <p className="dsh-cursor-summary">{summary}</p>
            )}
            <div className="dsh-cursor-list">
              <CursorModelsBody
                t={t}
                rows={shown}
                listState={listStateFor(rows, shown.length)}
                query={query}
                disabled={false}
                handlers={{
                  onToggle: toggle,
                  onEdit: open,
                  onReset: reset,
                  onText: changeText,
                  onCommit: commitText,
                  onCancel: cancel,
                }}
              />
            </div>
            <CursorCapacitySection
              t={t}
              enabled={view.knownContext.enabled}
              {...(view.knownContext.fetchedAt === undefined
                ? {}
                : { fetchedAt: view.knownContext.fetchedAt })}
              busy={sourceBusy}
              fallback={counts.fallback}
              total={counts.total}
              {...(sourceError === undefined ? {} : { error: sourceError })}
              {...(sourceNotice === undefined ? {} : { notice: sourceNotice })}
              onRefresh={() => {
                void refreshSource()
              }}
              onToggle={(enabled) => {
                void setSource(enabled)
              }}
            />
          </>
        )}
        {view === undefined && !loading && (
          <button type="button" onClick={() => void load(false)}>
            {t('cursorModelsRetry')}
          </button>
        )}
      </div>
    </dialog>
  )
}
