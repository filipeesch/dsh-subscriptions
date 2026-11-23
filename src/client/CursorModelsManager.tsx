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
  type CursorModelEdit,
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

/**
 * One change waiting to be written, applied to the last acknowledged map.
 *
 * A change carries the fields it touched, not the row's whole entry: a queued
 * edit must not retry a field whose earlier write the host refused.
 */
interface CursorWriteOp {
  id: string
  patch: CursorModelEdit
}

/** Apply one field patch to a map's entry for a model. */
function applyPatch(
  map: CursorModelDraft,
  id: string,
  patch: CursorModelEdit,
): void {
  const entry: CursorModelEdit = { ...(map[id] ?? {}) }
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete entry[field as keyof CursorModelEdit]
    else (entry as Record<string, unknown>)[field] = value
  }
  if (Object.keys(entry).length > 0) map[id] = entry
  else delete map[id]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Remove one key from a record, returning a copy either way. */
function without<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

/** A copy of the stored edits, so a mutation never reaches the host's payload. */
function cloneDraft(map: CursorModelDraft): CursorModelDraft {
  const out: CursorModelDraft = {}
  for (const [id, entry] of Object.entries(map)) out[id] = { ...entry }
  return out
}

/** Whether two entries describe the same stored value. */
function sameEntry(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * The model manager dialog.
 *
 * It owns the catalog read, the edits, and the writes; the rows it renders come
 * from {@link deriveRows}, so a change and the value the host holds are the same
 * value. Every change is applied when the reader makes it: an enablement change
 * writes at once, a typed window writes after a short pause, and a failed write
 * restores that model and states the failure in its row.
 *
 * Writes are queued as changes, not as snapshots: each one is applied to the map
 * the host last acknowledged, so a refused change cannot ride along on the next
 * successful one. A read waits for the queue to settle, so an open Reload cannot
 * replace the rows with a document older than the save that preceded it.
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
  /** What the reader sees: the acknowledged map plus the pending changes. */
  const draftRef = useRef<CursorModelDraft>({})
  /** What the host has acknowledged; every write is applied to this map. */
  const committedRef = useRef<CursorModelDraft>({})
  const queue = useRef<CursorWriteOp[]>([])
  /** Incremented by every acknowledgement, so a read can tell it was overtaken. */
  const generation = useRef(0)
  const draining = useRef(false)
  const drainDone = useRef<Promise<void>>(Promise.resolve())
  const textsRef = useRef<Record<string, string>>({})
  const errorsRef = useRef<Record<string, string>>({})
  const editingRef = useRef<string>()
  const viewRef = useRef<CursorModelsView>()
  const pause = useRef<ReturnType<typeof setTimeout>>()
  /** Set on every render so the unmount cleanup can flush without state. */
  const flushRef = useRef<(id: string) => void>(() => undefined)

  useEffect(() => {
    alive.current = true
    const element = dialog.current!
    const previous = document.activeElement
    if (typeof element.showModal === 'function') element.showModal()
    return () => {
      // A pause the reader outran is still a change they made: write it before
      // the page goes away, without touching state that no longer renders.
      if (pause.current !== undefined) {
        clearTimeout(pause.current)
        const open = editingRef.current
        if (open !== undefined) flushRef.current(open)
      }
      alive.current = false
      if (typeof element.close === 'function') element.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus()
    }
  }, [])

  /** Write the open field when the dialog closes, so closing never drops it. */
  const flushText = useCallback((id: string) => {
    const text = textsRef.current[id]
    if (text === undefined) return
    const tokens = parseWindowInput(text)
    // Unusable text is not a change; the row states why while it is open.
    if (text.trim() !== '' && tokens === null) return
    const patch: CursorModelEdit = { contextWindow: tokens ?? undefined }
    const next = withModelEdit(draftRef.current, id, patch)
    if (sameEntry(next[id], draftRef.current[id])) return
    draftRef.current = next
    queue.current.push({ id, patch })
    startDrain()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startDrain is stable
  }, [])

  flushRef.current = flushText

  /**
   * Apply one queued change to the acknowledged map and send it.
   *
   * The queue drains one change at a time, in order, so each request describes
   * the document the host will hold once it lands.
   */
  const startDrain = useCallback(() => {
    if (draining.current) return
    draining.current = true
    drainDone.current = (async () => {
      while (queue.current.length > 0) {
        const op = queue.current[0] as CursorWriteOp
        // The base is the acknowledged map at send time, so a read that landed
        // while this change waited is part of what this write preserves.
        const next = cloneDraft(committedRef.current)
        applyPatch(next, op.id, op.patch)
        try {
          await callSubscriptionsAuth(rpc, 'cursorSetSettings', {
            settings: { models: next },
          })
          queue.current.shift()
          committedRef.current = next
          generation.current += 1
          if (!alive.current) continue
          errorsRef.current = without(errorsRef.current, op.id)
          setErrors(errorsRef.current)
          onSaved()
        } catch (failure) {
          queue.current.shift()
          if (!alive.current) continue
          // A newer change to the same field is already queued: it describes
          // what the reader wants now, so leave that field alone and let it
          // write. Only the fields this change touched go back.
          const fields = Object.keys(op.patch) as (keyof CursorModelEdit)[]
          const superseded = queue.current.some(
            (pending) =>
              pending.id === op.id &&
              fields.some((field) => Object.hasOwn(pending.patch, field)),
          )
          if (!superseded) {
            const reverted = cloneDraft(draftRef.current)
            for (const field of fields) {
              const acknowledged = committedRef.current[op.id]?.[field]
              if (acknowledged === undefined) {
                const entry = reverted[op.id]
                if (entry !== undefined) {
                  delete entry[field]
                  if (Object.keys(entry).length === 0) delete reverted[op.id]
                }
              } else {
                reverted[op.id] = {
                  ...(reverted[op.id] ?? {}),
                  [field]: acknowledged,
                }
              }
            }
            draftRef.current = reverted
            setDraft(reverted)
          }
          const text = t('cursorModelWriteFailed', {
            model: nameOf(op.id),
            message: message(failure),
          })
          errorsRef.current = { ...errorsRef.current, [op.id]: text }
          setErrors(errorsRef.current)
        }
      }
    })().finally(() => {
      draining.current = false
    })
  }, [onSaved, rpc, t])

  /** Settle every queued change before a read describes the document. */
  const idle = useCallback(async (): Promise<void> => {
    while (draining.current) await drainDone.current
  }, [])

  /**
   * Seed the page from one host read.
   *
   * The stored map is the starting point, not an empty record: a change sends
   * the whole map back, so an empty one would drop every setting the reader did
   * not touch — including the models this catalog no longer lists.
   */
  const adopt = useCallback((next: CursorModelsView) => {
    viewRef.current = next
    setView(next)
    const stored = cloneDraft(next.storedModels)
    draftRef.current = stored
    committedRef.current = cloneDraft(next.storedModels)
    setDraft(stored)
    textsRef.current = {}
    setTexts({})
    editingRef.current = undefined
    setEditing(undefined)
    errorsRef.current = {}
    setErrors({})
  }, [])

  const load = useCallback(
    async (force: boolean, attempt = 0): Promise<void> => {
      if (force) setReloading(true)
      else setLoading(true)
      setPageError('')
      try {
        // A read started now must describe the document the queued changes
        // left behind, not the one before them.
        await idle()
        const before = generation.current
        const data = await callSubscriptionsAuth<CursorModelsView>(
          rpc,
          'cursorModels',
          force ? { force: true } : {},
        )
        if (!alive.current) return
        // A change made while this read was in flight is newer than the
        // document it describes. Adopting that document would show the older
        // rows, and the next write would be built from the older map; read
        // again instead, a bounded number of times.
        const overtaken =
          generation.current !== before ||
          draining.current ||
          queue.current.length > 0
        if (overtaken && attempt < 3) return load(force, attempt + 1)
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
    [adopt, idle, rpc, t],
  )

  useEffect(() => {
    void load(false)
    // The dialog reads once on open; Reload is the explicit refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on mount
  }, [])

  const nameOf = (id: string): string =>
    viewRef.current?.models.find((model) => model.id === id)?.name ?? id

  /** Apply one field change to the reader's view and queue it for the host. */
  const commit = useCallback(
    (id: string, patch: CursorModelEdit) => {
      const next = withModelEdit(draftRef.current, id, patch)
      if (sameEntry(next[id], draftRef.current[id])) return
      draftRef.current = next
      setDraft(next)
      queue.current.push({ id, patch })
      startDrain()
    },
    [startDrain],
  )

  const toggle = useCallback(
    (id: string, enabled: boolean) => {
      commit(id, { enabled })
    },
    [commit],
  )

  const reset = useCallback(
    (id: string) => {
      textsRef.current = without(textsRef.current, id)
      setTexts(textsRef.current)
      errorsRef.current = without(errorsRef.current, id)
      setErrors(errorsRef.current)
      commit(id, { contextWindow: undefined })
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
      const typed = textsRef.current[id]
      // Opening the field and leaving it without typing is not a change: an
      // absent text must not read as "clear the stored override".
      if (typed === undefined) {
        editingRef.current = undefined
        setEditing(undefined)
        return
      }
      const text = typed
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
      commit(id, { contextWindow: tokens ?? undefined })
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

  /**
   * Close the dialog without dropping a window the reader just typed.
   *
   * A flushed change is written before the dialog goes away, and a refused one
   * keeps it open so the row can state the failure: closing over a failed save
   * would hide the only place that says the window was not stored.
   */
  const close = useCallback(() => {
    const open = editingRef.current
    if (open === undefined && !draining.current && queue.current.length === 0) {
      onClose()
      return
    }
    if (open !== undefined) flushText(open)
    void idle().then(() => {
      if (!alive.current) return
      const failed = open !== undefined && errorsRef.current[open] !== undefined
      if (!failed) onClose()
    })
  }, [flushText, idle, onClose])

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
      onCancel={(event) => {
        // Escape must not drop a field the reader is still editing; route it
        // through the same flush and failure-hold as the Close button.
        if (editingRef.current === undefined) return
        event.preventDefault()
        close()
      }}
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
          <button type="button" autoFocus onClick={close}>
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
