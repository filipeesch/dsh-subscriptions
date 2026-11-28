/**
 * The Settings page's provider table, the rows it derives, and the roster that
 * renders them.
 *
 * The rows are the page's only claim about which providers exist, so these cases
 * pin the derivation rather than the markup: route-family order instead of the
 * order things were configured, a snapshot that decides every route family, an
 * Ollama connection that counts as configured with an address and no key, and a
 * confirmation that must not wait for the read that reconciles it. The roster
 * cases then pin the three list states and the collapse rule — a collapsed row
 * renders no detail, so it starts no read.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROSTER_PROVIDERS,
  SELECTOR_PROVIDERS,
  configuredIds,
  configuredRows,
} from '../src/client/provider-roster.js'
import type { RosterInput } from '../src/client/provider-roster.js'
import { ProviderRoster, rowStateText } from '../src/client/ProviderRoster.js'
import { en } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import { nodes, text } from './component-harness.js'
import type { Node } from './component-harness.js'

const t = (key: SubscriptionsKey, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ''),
  )

/** One OAuth provider's status with the given account keys. */
function status(...accounts: string[]) {
  return {
    busy: false,
    accounts: accounts.map((key, index) => ({ key, isDefault: index === 0 })),
  }
}

const EMPTY: RosterInput = { statuses: {}, routes: undefined }

test('rows follow the route families, not the order things were configured', () => {
  const rows = configuredRows({
    statuses: { codex: status('a'), claude: status('b') },
    routes: {
      configured: {
        minimax: { configured: true },
        cursor: { configured: true },
        'kimi-code': { configured: true },
        'ollama-cloud': { configured: true },
      },
      ollama: {},
    },
  })
  assert.deepEqual(
    rows.map((row) => row.id),
    ['codex', 'claude', 'cursor', 'ollama', 'kimi-code', 'minimax'],
  )
})

test('a provider with no configuration has no row', () => {
  const rows = configuredRows({
    statuses: { codex: status() },
    routes: { configured: { cursor: { configured: false } }, ollama: {} },
  })
  assert.deepEqual(rows, [])
  assert.equal(configuredIds(rows).size, 0)
})

test('the selector lists every provider by display name', () => {
  assert.deepEqual(
    SELECTOR_PROVIDERS.map((entry) => entry.name),
    [
      'Claude',
      'Codex (ChatGPT)',
      'Cursor',
      'GitHub Copilot',
      'Google Antigravity',
      'Grok (X Premium)',
      'Kimi Code',
      'MiniMax',
      'MiniMax CN',
      'Ollama',
      'OpenCode Go',
    ],
  )
  assert.equal(ROSTER_PROVIDERS.length, 11)
  assert.equal(SELECTOR_PROVIDERS.length, 11)
})

test('an account count of one and of several read differently', () => {
  const one = configuredRows({
    statuses: { codex: status('a') },
    routes: undefined,
  })
  const many = configuredRows({
    statuses: { codex: status('a', 'b') },
    routes: undefined,
  })
  assert.equal(rowStateText(t, one[0]!), '1 account connected')
  assert.equal(rowStateText(t, many[0]!), '2 accounts connected')
})

test('Ollama counts as configured with an address and no key', () => {
  const rows = configuredRows({
    statuses: {},
    routes: {
      configured: { 'ollama-cloud': { configured: false } },
      ollama: { baseURL: 'http://localhost:11434' },
    },
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, 'ollama')
  assert.equal(rows[0]!.state, 'address')
  assert.equal(rowStateText(t, rows[0]!), 'Local address configured')
})

test('an Ollama Cloud key and a bare address state different things', () => {
  const cloud = configuredRows({
    statuses: {},
    routes: {
      configured: { 'ollama-cloud': { configured: true } },
      ollama: { baseURL: 'http://localhost:11434' },
    },
  })
  assert.equal(cloud[0]!.state, 'cloud-key')
  assert.equal(rowStateText(t, cloud[0]!), 'Cloud API key configured')
})

test('a rejected credential states that the provider needs attention', () => {
  const rows = configuredRows({
    statuses: {},
    routes: {
      configured: { cursor: { configured: true } },
      ollama: {},
    },
    attention: new Set(['cursor']),
  })
  assert.equal(rows[0]!.state, 'attention')
  assert.equal(rowStateText(t, rows[0]!), 'Needs attention')
})

test('a confirmation adds the row before the read that reconciles it lands', () => {
  const rows = configuredRows({
    statuses: {},
    routes: { configured: {}, ollama: {} },
    confirmed: new Map([['cursor', { state: 'key' }]]),
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, 'cursor')
  assert.equal(rows[0]!.state, 'key')
})

test('the roster states checking, empty, and failed differently', () => {
  const noop = () => undefined
  const checking = ProviderRoster({
    t,
    rows: [],
    phase: 'checking',
    expanded: new Set(),
    onToggle: noop,
    onAdd: noop,
    onRetry: noop,
    renderDetail: () => null,
  })
  assert.match(text(checking), new RegExp(en.rosterChecking))
  const addButton = nodes(checking).find((node) => node.type === 'button')
  assert.equal(addButton?.props.disabled, true)

  const failed = ProviderRoster({
    t,
    rows: [],
    phase: 'failed',
    error: 'offline',
    expanded: new Set(),
    onToggle: noop,
    onAdd: noop,
    onRetry: noop,
    renderDetail: () => null,
  })
  assert.match(text(failed), new RegExp(en.rosterFailedTitle))
  assert.doesNotMatch(text(failed), new RegExp(en.rosterEmptyTitle))

  const empty = ProviderRoster({
    t,
    rows: [],
    phase: 'ready',
    expanded: new Set(),
    onToggle: noop,
    onAdd: noop,
    onRetry: noop,
    renderDetail: () => null,
  })
  assert.match(text(empty), new RegExp(en.rosterEmptyTitle))
  assert.match(text(empty), new RegExp(en.rosterEmptyHint))
})

test('a failed read over known rows keeps them and offers a retry', () => {
  const rows = configuredRows({
    statuses: { codex: status('a') },
    routes: undefined,
  })
  const tree = ProviderRoster({
    t,
    rows,
    phase: 'ready',
    error: 'offline',
    expanded: new Set(),
    onToggle: () => undefined,
    onAdd: () => undefined,
    onRetry: () => undefined,
    renderDetail: () => null,
  })
  assert.match(text(tree), /Codex \(ChatGPT\)/)
  assert.match(text(tree), new RegExp(en.rosterFailedTitle))
  assert.match(text(tree), new RegExp(en.rosterRetry))
})

test('a failed read with no known rows states the failure, not the empty list', () => {
  const tree = ProviderRoster({
    t,
    rows: [],
    phase: 'ready',
    error: 'offline',
    expanded: new Set(),
    onToggle: () => undefined,
    onAdd: () => undefined,
    onRetry: () => undefined,
    renderDetail: () => null,
  })
  assert.match(text(tree), new RegExp(en.rosterFailedTitle))
  assert.doesNotMatch(text(tree), new RegExp(en.rosterEmptyTitle))
  const add = nodes(tree).find(
    (node) => node.type === 'button' && text(node) === en.rosterAdd,
  )
  assert.equal(add?.props.disabled, true, 'a failing read withholds adding')
})

test('a rejected credential for a provider that has no row adds no row', () => {
  const rows = configuredRows({
    statuses: {},
    routes: { configured: {}, ollama: {} },
    attention: new Set(['cursor']),
  })
  assert.deepEqual(rows, [])
})

test('a stored Cloud key idle at a saved address says which it is, not a bare mark', () => {
  const rows = configuredRows({
    statuses: {},
    routes: {
      configured: { 'ollama-cloud': { configured: false } },
      ollama: { baseURL: 'http://localhost:11434', keyStored: true },
    },
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, 'ollama')
  assert.equal(rows[0]!.state, 'idle-key')
  assert.equal(rowStateText(t, rows[0]!), en.rosterKeyIdle)
})

test('a confirmation stands in when the snapshot has no account yet', () => {
  const rows = configuredRows({
    statuses: { claude: { busy: false, accounts: [] } },
    routes: { configured: {}, ollama: {} },
    confirmed: new Map([['claude', { state: 'accounts-one', accounts: 1 }]]),
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, 'claude')
  assert.equal(rows[0]!.state, 'accounts-one')
})

test('a second confirmed account is stated over a stale one-account snapshot', () => {
  const rows = configuredRows({
    statuses: {
      claude: {
        busy: false,
        accounts: [{ key: 'me', isDefault: true }],
      },
    },
    routes: { configured: {}, ollama: {} },
    confirmed: new Map([['claude', { state: 'accounts-many', accounts: 2 }]]),
  })
  assert.equal(rows[0]!.state, 'accounts-many')
  assert.equal(rows[0]!.accounts, 2)
})

test('an address alone still reads as a saved address', () => {
  const rows = configuredRows({
    statuses: {},
    routes: {
      configured: { 'ollama-cloud': { configured: false } },
      ollama: { baseURL: 'http://localhost:11434', keyStored: false },
    },
  })
  assert.equal(rows[0]!.state, 'address')
})

test('a collapsed row renders no detail and states its connection', () => {
  const rows = configuredRows({
    statuses: { codex: status('a') },
    routes: undefined,
  })
  let rendered = 0
  const tree = ProviderRoster({
    t,
    rows,
    phase: 'ready',
    expanded: new Set(),
    onToggle: () => undefined,
    onAdd: () => undefined,
    onRetry: () => undefined,
    renderDetail: () => {
      rendered += 1
      const marker: Node = { type: 'div', props: {} } as unknown as Node
      return marker
    },
  })
  assert.equal(rendered, 0, 'no detail is built for a collapsed row')
  assert.match(text(tree), /Codex \(ChatGPT\) · 1 account connected/)
  const header = nodes(tree).find(
    (node) => node.props['aria-expanded'] !== undefined,
  )
  assert.equal(header?.props['aria-expanded'], false)
})

test('an expanded row renders its detail and states that it is expanded', () => {
  const rows = configuredRows({
    statuses: { codex: status('a') },
    routes: undefined,
  })
  let rendered = 0
  const tree = ProviderRoster({
    t,
    rows,
    phase: 'ready',
    expanded: new Set(['codex']),
    onToggle: () => undefined,
    onAdd: () => undefined,
    onRetry: () => undefined,
    renderDetail: () => {
      rendered += 1
      return 'detail'
    },
  })
  assert.equal(rendered, 1)
  assert.match(text(tree), /detail/)
  const header = nodes(tree).find(
    (node) => node.props['aria-expanded'] !== undefined,
  )
  assert.equal(header?.props['aria-expanded'], true)
  assert.equal(header?.props['aria-controls'], 'dsh-roster-region-codex')
})

test('the outcome line states what a confirmation saved', () => {
  const tree = ProviderRoster({
    t,
    rows: configuredRows({
      statuses: { codex: status('a') },
      routes: undefined,
    }),
    phase: 'ready',
    outcome: 'Ollama local address saved.',
    expanded: new Set(),
    onToggle: () => undefined,
    onAdd: () => undefined,
    onRetry: () => undefined,
    renderDetail: () => null,
  })
  assert.match(text(tree), /Ollama local address saved\./)
  assert.ok(
    nodes(tree).some((node) => node.props.role === 'status'),
    'the line is announced',
  )
})

test('the empty roster case is not the same shape as an unconfigured provider', () => {
  assert.deepEqual(configuredRows(EMPTY), [])
})
