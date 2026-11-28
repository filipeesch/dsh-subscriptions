/**
 * The Settings page's roster: one collapsed row per configured provider, the
 * preference band's sibling rather than part of it, and the three states a
 * configured-set read can leave it in.
 *
 * The rows come from provider-roster: which providers have one is decided there,
 * and so is the fixed order. This module only decides how a row states its route
 * and what the region under it renders. It holds no state: the page owns the
 * expanded set, the outcome line, and every detail a row expands to.
 */

import type { ReactNode, Ref } from 'react'
import type { SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { rosterStyles as styles } from './subscription-section-styles.js'
import type { ConfiguredRow, RosterProviderId } from './provider-roster.js'

type Translate = SubscriptionsSectionInjected['t']

/**
 * The sentence a collapsed row states about its route.
 * @param t - section translate.
 * @param row - the row whose route is described.
 * @returns the localized state, without the provider name.
 */
export function rowStateText(t: Translate, row: ConfiguredRow): string {
  switch (row.state) {
    case 'accounts-one':
      return t('rosterAccountOne')
    case 'accounts-many':
      return t('rosterAccounts', { count: row.accounts ?? 2 })
    case 'key':
      return t('externalUsageConnected')
    case 'cloud-key':
      return t('rosterCloudKey')
    case 'address':
      return t('rosterAddress')
    case 'idle-key':
      return t('rosterKeyIdle')
    case 'attention':
      return t('rosterAttention')
  }
}

/** The disclosure marker; presentational, so it stays out of the row's name. */
function Chevron({ open }: { open: boolean }) {
  return (
    <span aria-hidden="true" style={open ? styles.chevronOpen : styles.chevron}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path
          d="M4.5 2.5 8 6l-3.5 3.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

/** Which of the three list states the last read left behind. */
export type RosterPhase = 'checking' | 'ready' | 'failed'

export interface ProviderRosterProps {
  t: Translate
  rows: readonly ConfiguredRow[]
  phase: RosterPhase
  /** The last read's failure; shown above the rows when a snapshot exists. */
  error?: string
  /** What the add form's confirmation saved, until the form opens again. */
  outcome?: string
  expanded: ReadonlySet<RosterProviderId>
  onToggle: (id: RosterProviderId) => void
  onAdd: () => void
  onRetry: () => void
  /** Where focus returns after the add form closes. */
  headingRef?: Ref<HTMLHeadingElement>
  /** A row's expanded controls; called only while the row is expanded. */
  renderDetail: (row: ConfiguredRow) => ReactNode
}

/** One bordered panel for the list's empty, checking, and failed states. */
function ListPanel({
  title,
  line,
  children,
}: {
  /** Absent for the checking state, which has nothing to name yet. */
  title?: string
  line: string
  children?: ReactNode
}) {
  return (
    <div style={styles.panel}>
      {title !== undefined && <p style={styles.panelTitle}>{title}</p>}
      <p style={styles.panelLine}>{line}</p>
      {children !== undefined && (
        <div style={styles.panelActions}>{children}</div>
      )}
    </div>
  )
}

/**
 * The roster body: heading and add action, the outcome line, and the list.
 * @param props - see {@link ProviderRosterProps}.
 * @returns the roster, in whichever of its three states applies.
 */
export function ProviderRoster(props: ProviderRosterProps) {
  const { t, rows, phase, error, outcome, expanded } = props
  // Adding needs a snapshot to mark the configured providers from, and a read
  // that is not currently failing: a partially known set must not open a form.
  const canAdd = phase === 'ready' && error === undefined
  const failure =
    error === undefined
      ? undefined
      : ListPanel({
          title: t('rosterFailedTitle'),
          line: t('rosterFailedHint'),
          children: (
            <button type="button" style={styles.retry} onClick={props.onRetry}>
              {t('rosterRetry')}
            </button>
          ),
        })
  return (
    <div style={styles.block}>
      <div style={styles.heading}>
        <h2 ref={props.headingRef} tabIndex={-1} style={styles.headingTitle}>
          {t('rosterTitle')}
        </h2>
        <button
          type="button"
          className="dsh-subscription-primary"
          style={styles.add}
          disabled={!canAdd}
          onClick={props.onAdd}
        >
          {t('rosterAdd')}
        </button>
      </div>
      {outcome !== undefined && (
        <p style={styles.outcome} role="status">
          {outcome}
        </p>
      )}
      {phase === 'checking' && ListPanel({ line: t('rosterChecking') })}
      {/* A failed read is stated whenever it happened, and the empty state never
          stands in for it: "could not load" and "nothing configured" are
          different answers, and rows from the last successful read stay. */}
      {failure}
      {phase === 'ready' &&
        rows.length === 0 &&
        error === undefined &&
        ListPanel({ title: t('rosterEmptyTitle'), line: t('rosterEmptyHint') })}
      {phase === 'ready' && rows.length > 0 && (
        <div style={styles.list}>
          {rows.map((row, index) => {
            const open = expanded.has(row.id)
            const headerId = 'dsh-roster-header-' + row.id
            const regionId = 'dsh-roster-region-' + row.id
            return (
              <div
                key={row.id}
                style={index === 0 ? styles.firstRow : styles.row}
              >
                <h3 style={styles.rowHeading}>
                  <button
                    id={headerId}
                    type="button"
                    style={styles.rowHeader}
                    aria-expanded={open}
                    aria-controls={regionId}
                    onClick={() => props.onToggle(row.id)}
                  >
                    <Chevron open={open} />
                    <span style={styles.rowLabel}>{row.name}</span>
                    <span
                      style={
                        row.state === 'attention'
                          ? styles.rowStateAttention
                          : styles.rowState
                      }
                    >
                      {' · ' + rowStateText(t, row)}
                    </span>
                  </button>
                </h3>
                {/* `hidden` removes the region from the tree; the explicit
                    display keeps the UA rule from losing to the inline column. */}
                <div
                  id={regionId}
                  role="region"
                  aria-labelledby={headerId}
                  hidden={!open}
                  style={{
                    ...styles.region,
                    display: open ? 'flex' : 'none',
                  }}
                >
                  {open ? props.renderDetail(row) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
