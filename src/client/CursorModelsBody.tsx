/**
 * The model manager's presentational half.
 *
 * Each component is a function of its props: the container in
 * `CursorModelsManager` owns the fetch, the edits, and the debounced writes,
 * and these render exactly what it passes in. Keeping them hook-free is what
 * lets a test render a row or a list by calling the function.
 */

import type { ModelListState } from './model-filter.js'
import {
  formatWindowLabel,
  windowNote,
  type CursorRow,
  type Translate,
} from './cursor-manager-derive.js'

/** Every interaction one row offers. */
export interface CursorRowHandlers {
  onToggle: (id: string, enabled: boolean) => void
  onEdit: (id: string) => void
  onReset: (id: string) => void
  onText: (id: string, text: string) => void
  onCommit: (id: string) => void
  onCancel: () => void
}

/**
 * A pencil, drawn inline: the glyph forms of a pencil differ between platforms,
 * and a missing one reads as a paperclip.
 */
function PencilIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M11 2.5 13.5 5 5 13.5H2.5V11z" />
      <path d="M9.5 4 12 6.5" />
    </svg>
  )
}

/** An arrow curving back on itself: the return to the automatic value. */
function ResetIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 8a5 5 0 1 0 1.6-3.7" />
      <path d="M2.5 3.5V7H6" />
    </svg>
  )
}

/** One model: its name and id, then the window and its controls. */
export function CursorModelRow({
  t,
  row,
  disabled,
  handlers,
}: {
  t: Translate
  row: CursorRow
  disabled: boolean
  handlers: CursorRowHandlers
}) {
  const note = windowNote(t, row)
  const windowName = t('cursorModelWindowFor', { model: row.name })
  const errorId = 'cursor-model-error-' + row.id
  const invalid = row.editing && row.error !== undefined
  return (
    <li
      className={
        'dsh-cursor-model' + (row.enabled ? '' : ' dsh-cursor-model-off')
      }
    >
      <label className="dsh-cursor-model-head">
        <input
          type="checkbox"
          checked={row.enabled}
          disabled={disabled}
          aria-label={t('cursorModelEnabled', { model: row.name })}
          onChange={(event) => handlers.onToggle(row.id, event.target.checked)}
        />
        <span className="dsh-cursor-model-name">{row.name}</span>
        <span className="dsh-cursor-model-id">{row.id}</span>
        {!row.described && (
          <span className="dsh-cursor-model-id">
            · {t('cursorModelNotDescribed')}
          </span>
        )}
      </label>
      <div className="dsh-cursor-model-controls">
        {row.editing ? (
          <>
            <input
              className="dsh-cursor-window-input"
              inputMode="numeric"
              autoFocus
              value={row.text}
              disabled={disabled}
              aria-invalid={invalid}
              aria-label={windowName}
              aria-describedby={invalid ? errorId : undefined}
              onChange={(event) => handlers.onText(row.id, event.target.value)}
              onBlur={() => handlers.onCommit(row.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handlers.onCommit(row.id)
                if (event.key === 'Escape') handlers.onCancel()
              }}
            />
          </>
        ) : (
          <>
            {/* The source is real text, not an aria-label on a static span:
                a screen reader then reads the value and where it came from,
                and the title carries the same sentence for a pointer. */}
            <span className="dsh-cursor-chip" title={note}>
              {formatWindowLabel(row.tokens)}
              <span className="dsh-cursor-sr"> ({note})</span>
            </span>
            {row.overridable && (
              <button
                type="button"
                className="dsh-cursor-icon"
                disabled={disabled}
                aria-label={t('cursorModelOverride', { model: row.name })}
                title={t('cursorModelOverride', { model: row.name })}
                onClick={() => handlers.onEdit(row.id)}
              >
                <PencilIcon />
              </button>
            )}
            {row.source === 'manual' && (
              <button
                type="button"
                className="dsh-cursor-icon"
                disabled={disabled}
                aria-label={t('cursorModelResetOverride', { model: row.name })}
                title={t('cursorModelResetOverride', { model: row.name })}
                onClick={() => handlers.onReset(row.id)}
              >
                <ResetIcon />
              </button>
            )}
          </>
        )}
      </div>
      {row.error !== undefined && (
        <p role="alert" id={errorId} className="dsh-cursor-model-error">
          {row.error}
        </p>
      )}
    </li>
  )
}

/** The list, its summary, and the two states that replace rows. */
export function CursorModelsBody({
  t,
  rows,
  listState,
  query,
  disabled,
  handlers,
}: {
  t: Translate
  rows: readonly CursorRow[]
  listState: ModelListState
  query: string
  disabled: boolean
  handlers: CursorRowHandlers
}) {
  if (listState === 'provider-empty')
    return <p className="dsh-subscription-hint">{t('cursorModelsEmpty')}</p>
  if (listState === 'filter-empty')
    return (
      <p className="dsh-subscription-hint">
        {t('modelDefaultsFilterEmpty', { query })}
      </p>
    )
  return (
    <ul className="dsh-cursor-models">
      {rows.map((row) => (
        <CursorModelRow
          key={row.id}
          t={t}
          row={row}
          disabled={disabled}
          handlers={handlers}
        />
      ))}
    </ul>
  )
}
