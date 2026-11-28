/**
 * The Settings page's provider table and the configured set derived from it.
 *
 * One table decides both lists the page renders: the roster walks it in route
 * order — OAuth session routes, then Cursor, then Ollama, then the key-managed
 * sources — while the add form's selector walks it by display name, because a
 * lookup list is searched rather than scanned by route. A provider this
 * installation is not configured for has no row; it is reachable only from that
 * selector.
 */

import type { ProviderId } from '../providers/ids.js'
import type { ProviderStatus } from './SubscriptionsSection.js'

/** Every provider the settings page can list or configure. */
export type RosterProviderId =
  | ProviderId
  | 'cursor'
  | 'ollama'
  | 'opencode-go'
  | 'kimi-code'
  | 'minimax'
  | 'minimax-cn'

/** How a provider is configured, and which detail its row expands to. */
export type ProviderFamily = 'oauth' | 'cursor' | 'ollama' | 'managed'

/** One provider the page can list. */
export interface ProviderEntry {
  id: RosterProviderId
  /** Brand name, kept out of the dictionaries. */
  name: string
  family: ProviderFamily
}

/** The roster order: route families in the order the page always used. */
export const ROSTER_PROVIDERS: readonly ProviderEntry[] = [
  { id: 'codex', name: 'Codex (ChatGPT)', family: 'oauth' },
  { id: 'claude', name: 'Claude', family: 'oauth' },
  { id: 'grok', name: 'Grok (X Premium)', family: 'oauth' },
  { id: 'copilot', name: 'GitHub Copilot', family: 'oauth' },
  { id: 'antigravity', name: 'Google Antigravity', family: 'oauth' },
  { id: 'cursor', name: 'Cursor', family: 'cursor' },
  { id: 'ollama', name: 'Ollama', family: 'ollama' },
  { id: 'opencode-go', name: 'OpenCode Go', family: 'managed' },
  { id: 'kimi-code', name: 'Kimi Code', family: 'managed' },
  { id: 'minimax', name: 'MiniMax', family: 'managed' },
  { id: 'minimax-cn', name: 'MiniMax CN', family: 'managed' },
]

/**
 * The selector order: every provider by display name. The comparator reads code
 * units rather than a locale, so two installs with different locales list the
 * same order.
 */
export const SELECTOR_PROVIDERS: readonly ProviderEntry[] = [
  ...ROSTER_PROVIDERS,
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

/** One table entry by id, or undefined for a provider this page cannot list. */
export function providerEntry(id: RosterProviderId): ProviderEntry | undefined {
  return ROSTER_PROVIDERS.find((entry) => entry.id === id)
}

/** The external-status answer, reduced to the questions this page asks. */
export interface RouteSnapshot {
  /** One entry per external source; configured is the route's own answer. */
  configured: Readonly<Record<string, { configured: boolean } | undefined>>
  /**
   * Ollama's stored connection, from the same snapshot. `keyStored` says a Cloud
   * key exists even when the saved address makes it idle, which the route's own
   * configured answer cannot say at that address.
   */
  ollama: { baseURL?: string; keyStored?: boolean }
}

/** One committed reading of the configured set: every required answer arrived. */
export interface RosterSnapshot {
  /** The OAuth routes' accounts, as the status endpoint reported them. */
  statuses: Partial<Record<ProviderId, ProviderStatus>>
  routes: RouteSnapshot
}

/** What a collapsed row states about its route. */
export type RowState =
  | 'accounts-one'
  | 'accounts-many'
  | 'key'
  | 'cloud-key'
  | 'address'
  | 'idle-key'
  | 'attention'

/** A route the add form confirmed before the next successful read landed. */
export interface ConfirmedRow {
  state: RowState
  /** Connected accounts, when the confirmation is an authorization. */
  accounts?: number
}

/** One row of the roster: a configured provider and the state it states. */
export interface ConfiguredRow extends ProviderEntry {
  state: RowState
  /** Connected account count, for the account states. */
  accounts?: number
}

/** Everything the roster's rows are derived from. */
export interface RosterInput {
  /** The OAuth routes' accounts, as the status endpoint reported them. */
  statuses: Partial<Record<ProviderId, ProviderStatus>>
  /** The external routes' answers, or undefined until a read succeeds. */
  routes: RouteSnapshot | undefined
  /** Routes the add form confirmed, until the next successful read lands. */
  confirmed?: ReadonlyMap<RosterProviderId, ConfirmedRow>
  /** Routes whose saved credential the form's validation rejected. */
  attention?: ReadonlySet<RosterProviderId>
}

/** The row state one provider reports, or undefined when it has no row. */
function stateOf(
  entry: ProviderEntry,
  input: RosterInput,
): { state: RowState; accounts?: number } | undefined {
  const base = configuredStateOf(entry, input)
  if (base === undefined) return undefined
  // The rejected-credential mark only ever annotates a row that exists, so a key
  // the reader later removes cannot leave a phantom provider behind.
  return input.attention?.has(entry.id) === true ? { state: 'attention' } : base
}

/** The state the configured set alone reports for one provider. */
function configuredStateOf(
  entry: ProviderEntry,
  input: RosterInput,
): { state: RowState; accounts?: number } | undefined {
  if (entry.family === 'oauth') {
    // The snapshot and a confirmation can disagree: an attempt settles while the
    // read that would reconcile it fails, so the confirmation's account count
    // stands in — a provider the route just confirmed must not vanish, and a
    // second account must not read as the first one.
    const snapshot =
      input.statuses[entry.id as ProviderId]?.accounts.length ?? 0
    const confirmed = input.confirmed?.get(entry.id)
    const confirmedCount =
      confirmed?.accounts ??
      (confirmed?.state === 'accounts-one'
        ? 1
        : confirmed?.state === 'accounts-many'
          ? 2
          : 0)
    const count = Math.max(snapshot, confirmedCount)
    if (count === 0) return undefined
    return count === 1
      ? { state: 'accounts-one', accounts: 1 }
      : { state: 'accounts-many', accounts: count }
  }
  if (entry.family === 'ollama') {
    if (input.routes?.configured['ollama-cloud']?.configured === true)
      return { state: 'cloud-key' }
    const baseURL = input.routes?.ollama.baseURL
    if (baseURL !== undefined && baseURL !== '') {
      // A saved address the stored Cloud key cannot be spent at is a credential
      // the reader has to resolve, not a working local connection; the row says
      // which of the two it is rather than a bare "needs attention".
      return input.routes?.ollama.keyStored === true
        ? { state: 'idle-key' }
        : { state: 'address' }
    }
  } else if (input.routes?.configured[entry.id]?.configured === true) {
    return { state: 'key' }
  }
  // A confirmation the next read has not landed yet must not wait for it: a
  // failed reconciliation may not hide a provider the route already confirmed.
  const confirmed = input.confirmed?.get(entry.id)
  return confirmed === undefined ? undefined : { state: confirmed.state }
}

/**
 * The roster's rows, in its fixed order.
 * @param input - the last successful snapshot plus this session's confirmations.
 * @returns one row per configured provider, in ROSTER_PROVIDERS order.
 */
export function configuredRows(input: RosterInput): ConfiguredRow[] {
  const rows: ConfiguredRow[] = []
  for (const entry of ROSTER_PROVIDERS) {
    const found = stateOf(entry, input)
    if (found === undefined) continue
    rows.push({
      ...entry,
      state: found.state,
      ...(found.accounts === undefined ? {} : { accounts: found.accounts }),
    })
  }
  return rows
}

/** The providers a row exists for; the add form's selector marks these. */
export function configuredIds(
  rows: readonly ConfiguredRow[],
): ReadonlySet<RosterProviderId> {
  return new Set(rows.map((row) => row.id))
}
