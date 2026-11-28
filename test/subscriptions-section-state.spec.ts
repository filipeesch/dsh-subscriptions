/**
 * The Settings page's roster state machine, and the account row an expanded row
 * renders.
 *
 * The page owns which rows exist: one configured-set read decides them, a failed
 * read keeps the last successful rows, and a collapsed row starts no usage read.
 * The usage block now lives in the row's detail, so those cases mount the detail
 * directly with fixture state; the page reaches them only through an expansion.
 *
 * The hook dispatcher runs the page's own load and refresh logic; it does not
 * reconcile children, so a row's inner markup appears here because the page calls
 * its pure detail function during render, not because React mounted a child.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import {
  PlanWindowsAbsentNote,
  SubscriptionsSection,
} from '../src/client/SubscriptionsSection.js'
import { OAuthProviderDetail } from '../src/client/OAuthProviderDetail.js'
import type {
  ProviderStatus,
  UsageWindow,
} from '../src/client/SubscriptionsSection.js'
import { AddProviderForm } from '../src/client/AddProviderForm.js'
import { UsageBadgeDisplaySetting } from '../src/client/UsageBadgeDisplaySetting.js'
import { UsageWindowRow } from '../src/client/UsageWindowRow.js'
import { en } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import { Component, nodes, settle, text } from './component-harness.js'
import type { Node } from './component-harness.js'

/** One poller interval plus slack, for a test that must let a poller stop. */
const POLL_WAIT_MS = 2_200

const t = (key: SubscriptionsKey, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ''),
  )

/** Whether the page mounted the missing-plan-windows note. */
function noteMounted(tree: unknown): boolean {
  return nodes(tree).some((node) => node.type === PlanWindowsAbsentNote)
}

/** The money row the detail mounted, when it mounted one. */
function moneyRowMounted(tree: unknown): boolean {
  return nodes(tree).some(
    (node) =>
      node.type === UsageWindowRow &&
      node.props.window.usedAmount !== undefined,
  )
}

/** The address every fixture read answers on. */
const base = 'http://127.0.0.1:11434'

const OLLAMA_VIEW = {
  provider: 'ollama-cloud',
  settings: {},
  effective: { baseURL: base, apiKeyRef: 'OLLAMA_API_KEY', web: false },
  models: [],
  configOverridesModels: false,
  keyUsable: true,
}

function statusOf(accounts: string[]): ProviderStatus {
  return {
    busy: false,
    accounts: accounts.map((key, index) => ({ key, isDefault: index === 0 })),
  }
}

const PROVIDERS: Record<string, ProviderStatus> = {
  codex: statusOf([]),
  claude: statusOf(['claude@example.invalid']),
  grok: statusOf([]),
  copilot: statusOf([]),
  antigravity: statusOf([]),
}

/** One scripted answer per endpoint, plus the calls the page made. */
function fakeRpc(overrides: {
  status?: () => Promise<unknown>
  external?: () => Promise<unknown>
  usage?: (payload: unknown) => Promise<unknown>
  login?: () => Promise<unknown>
  cancel?: () => Promise<unknown>
}) {
  const calls: { endpoint: string; payload: unknown }[] = []
  const rpc = {
    call: async (_channel: string, endpoint: string, payload: unknown) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'subscriptions-auth.status')
        return overrides.status === undefined
          ? { ok: true, value: { providers: PROVIDERS } }
          : await overrides.status()
      if (endpoint === 'subscriptions-auth.externalStatus')
        return overrides.external === undefined
          ? { ok: true, value: { 'kimi-code': { configured: true } } }
          : await overrides.external()
      if (endpoint === 'subscriptions-auth.ollamaSettings')
        return { ok: true, value: OLLAMA_VIEW }
      if (endpoint === 'subscriptions-auth.usage')
        return overrides.usage === undefined
          ? { ok: true, value: {} }
          : await overrides.usage(payload)
      if (endpoint === 'subscriptions-auth.login')
        return overrides.login === undefined
          ? {
              ok: true,
              value: { authorizeUrl: 'https://example.invalid/oauth' },
            }
          : await overrides.login()
      if (endpoint === 'subscriptions-auth.cancel')
        return overrides.cancel === undefined
          ? { ok: true, value: { ok: true } }
          : await overrides.cancel()
      // Every remaining endpoint answers something renderable.
      return { ok: true, value: {} }
    },
  } as unknown as ConnectionHandle['rpc']
  return { rpc, calls }
}

function sectionWith(overrides: Parameters<typeof fakeRpc>[0]) {
  const { rpc, calls } = fakeRpc(overrides)
  return {
    calls,
    component: new Component(() =>
      SubscriptionsSection({ rpc, t: t as never }),
    ),
  }
}

/** The browser global the page touches after a successful usage read. */
async function withBrowser(work: () => Promise<void>): Promise<void> {
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  globals.window = { dispatchEvent: () => true, open: () => undefined }
  try {
    await work()
  } finally {
    if (previous === undefined) delete globals.window
    else globals.window = previous
  }
}

/** The node a case needs, or a failure that names what was missing. */
function mustNode(found: Node | undefined, what: string): Node {
  if (found === undefined) throw new Error('missing ' + what)
  return found
}

/** A button by its exact copy. */
function buttonByText(tree: unknown, label: string): Node {
  const found = nodes(tree).find(
    (node) => node.type === 'button' && text(node) === label,
  )
  if (found === undefined) {
    throw new Error(
      'missing button ' +
        label +
        '; buttons: ' +
        JSON.stringify(
          nodes(tree)
            .filter((node) => node.type === 'button')
            .map((node) => text(node)),
        ),
    )
  }
  return found
}

/** The row header for a provider, or undefined when it has no row. */
function findRowHeader(tree: unknown, label: string): Node | undefined {
  return nodes(tree).find(
    (node) =>
      node.type === 'button' &&
      node.props['aria-expanded'] !== undefined &&
      text(node).includes(label),
  )
}

/** The row header button whose label names one provider. */
function rowHeader(tree: unknown, label: string): Node {
  return mustNode(
    nodes(tree).find(
      (node) =>
        node.type === 'button' &&
        node.props['aria-expanded'] !== undefined &&
        text(node).includes(label),
    ),
    'row header for ' + label,
  )
}

test('the roster lists only the providers this installation configured', async () => {
  await withBrowser(async () => {
    const { component } = sectionWith({})
    await settle(component)
    const body = text(component.tree)
    assert.match(body, /Claude/)
    assert.match(body, /Kimi Code/)
    assert.doesNotMatch(body, /Cursor/)
    assert.doesNotMatch(body, /No providers configured/)
  })
})

test('a failed reconciliation keeps the rows and the confirmed provider, then Retry recovers', async () => {
  await withBrowser(async () => {
    let failing = true
    const { component } = sectionWith({
      status: async () =>
        failing
          ? { ok: false, error: { message: 'offline' } }
          : { ok: true, value: { providers: PROVIDERS } },
      external: async () =>
        failing
          ? { ok: false, error: { message: 'offline' } }
          : {
              ok: true,
              value: {
                'kimi-code': { configured: true },
                cursor: { configured: true },
              },
            },
    })
    await settle(component)
    // First read fails: the failure is stated, never an empty list.
    assert.match(text(component.tree), new RegExp(en.rosterFailedTitle))
    failing = false
    buttonByText(component.tree, en.rosterRetry).props.onClick()
    await settle(component)
    assert.ok(rowHeader(component.tree, 'Claude'), 'the read reported Claude')
    assert.ok(rowHeader(component.tree, 'Kimi Code'), 'and the managed source')
    // A confirmation whose reconciliation fails keeps its row and the failure.
    failing = true
    buttonByText(component.tree, '+ Add provider').props.onClick()
    await settle(component)
    const form = mustNode(
      nodes(component.tree).find((node) => node.type === AddProviderForm),
      'add form',
    )
    form.props.onConfirmed('cursor', 'key', 'Cursor API key saved.')
    await settle(component)
    assert.ok(rowHeader(component.tree, 'Claude'), 'the previous rows stay')
    assert.ok(rowHeader(component.tree, 'Cursor'), 'the confirmed row stays')
    assert.match(text(component.tree), new RegExp(en.rosterFailedTitle))
    const add = mustNode(
      nodes(component.tree).find(
        (node) => node.type === 'button' && text(node) === '+ Add provider',
      ),
      'add action',
    )
    assert.equal(add.props.disabled, true, 'a failing read withholds adding')
    // Retry reconciles and the rows are the read's answer, once.
    failing = false
    buttonByText(component.tree, en.rosterRetry).props.onClick()
    await settle(component)
    assert.equal(
      nodes(component.tree).filter(
        (node) =>
          node.type === 'button' && node.props['aria-expanded'] !== undefined,
      ).length,
      3,
      'three configured providers, one row each',
    )
    assert.doesNotMatch(text(component.tree), new RegExp(en.rosterFailedTitle))
  })
})

test('a first read that fails states the failure instead of an empty roster', async () => {
  await withBrowser(async () => {
    const { component } = sectionWith({
      external: async () => ({ ok: false, error: { message: 'offline' } }),
    })
    await settle(component)
    const body = text(component.tree)
    assert.match(body, new RegExp(en.rosterFailedTitle))
    assert.match(body, new RegExp(en.rosterRetry))
    assert.doesNotMatch(body, new RegExp(en.rosterEmptyTitle))
    assert.doesNotMatch(body, /Kimi Code/)
  })
})

test('the display preferences sit in a closed disclosure above the roster', async () => {
  await withBrowser(async () => {
    const { component } = sectionWith({})
    await settle(component)
    const band = mustNode(
      nodes(component.tree).find((node) => node.type === 'details'),
      'preferences disclosure',
    )
    assert.equal(band.props.open, undefined, 'closed by default')
    const summary = mustNode(
      nodes(band.props.children).find((node) => node.type === 'summary'),
      'preferences summary',
    )
    assert.equal(text(summary), en.rosterPreferences)
    assert.equal(
      nodes(band.props.children).some(
        (node) => node.type === UsageBadgeDisplaySetting,
      ),
      true,
      'the three preferences render inside the band',
    )
  })
})

test('an answer that predates a removal cannot resurrect the row', async () => {
  await withBrowser(async () => {
    // Read 0 is the mount; reads 1 and 2 are two overlapping reconciliations.
    // The older one still reports Cursor and answers last.
    let read = -1
    const gates: (() => void)[] = []
    const answers = [
      { cursor: true, kimi: true },
      { cursor: true, kimi: true },
      { cursor: false, kimi: true },
    ]
    const { component } = sectionWith({
      status: async () => {
        const mine = ++read
        if (mine > 0) {
          await new Promise<void>((resolve) => {
            gates[mine - 1] = resolve
          })
        }
        return {
          ok: true,
          value: {
            providers: { ...PROVIDERS, claude: { busy: false, accounts: [] } },
          },
        }
      },
      external: async () => {
        const answer = answers[read] ?? { cursor: false, kimi: true }
        return {
          ok: true,
          value: {
            ...(answer.kimi ? { 'kimi-code': { configured: true } } : {}),
            ...(answer.cursor ? { cursor: { configured: true } } : {}),
          },
        }
      },
    })
    await settle(component)
    assert.ok(
      rowHeader(component.tree, 'Cursor'),
      'the mount read listed Cursor',
    )
    // Two confirmations start two reconciliations before either answers.
    buttonByText(component.tree, '+ Add provider').props.onClick()
    await settle(component)
    const form = mustNode(
      nodes(component.tree).find((node) => node.type === AddProviderForm),
      'add form',
    )
    form.props.onConfirmed('cursor', 'key', 'Cursor API key saved.')
    form.props.onConfirmed('cursor', 'key', 'Cursor API key saved.')
    await settle(component)
    assert.equal(gates.length, 2, 'two reads are in flight')
    gates[1]!()
    await settle(component)
    assert.equal(
      findRowHeader(component.tree, 'Cursor'),
      undefined,
      'the newest answer reports Cursor gone',
    )
    gates[0]!()
    await settle(component)
    assert.equal(
      findRowHeader(component.tree, 'Cursor'),
      undefined,
      'the older answer is dropped instead of resurrecting the row',
    )
    assert.match(text(component.tree), /Kimi Code/)
  })
})

test('a status answer still moves while the roster read fails', async () => {
  await withBrowser(async () => {
    let grokAccounts = ['grok@example.invalid']
    let externalFails = false
    const { component } = sectionWith({
      status: async () => ({
        ok: true,
        value: {
          providers: {
            ...PROVIDERS,
            grok: {
              busy: false,
              accounts: grokAccounts.map((key, index) => ({
                key,
                isDefault: index === 0,
              })),
            },
          },
        },
      }),
      external: async () =>
        externalFails
          ? { ok: false, error: { message: 'external down' } }
          : { ok: true, value: { 'kimi-code': { configured: true } } },
      // The instant-login path: the route answers without a browser step.
      login: async () => ({ ok: true, value: { authorizeUrl: '' } }),
    })
    await settle(component)
    rowHeader(component.tree, 'Grok').props.onClick()
    await settle(component)
    // The account arrives, and from then on the configured-set read fails.
    grokAccounts = ['grok@example.invalid', 'second@example.invalid']
    externalFails = true
    buttonByText(component.tree, en.addAccount).props.onClick()
    await settle(component)
    assert.match(
      text(component.tree),
      /second@example\.invalid/,
      'the status answer reached the row detail',
    )
    assert.match(
      text(component.tree),
      new RegExp(t('rosterAccounts', { count: 2 })),
      'and the collapsed row counts it before the next full read',
    )
    assert.match(text(component.tree), new RegExp(en.rosterFailedTitle))
    assert.ok(findRowHeader(component.tree, 'Kimi Code'), 'the rows stay')
  })
})

test('a failed cancel keeps its error while the attempt is still busy', async () => {
  await withBrowser(async () => {
    let busy = false
    const { component } = sectionWith({
      status: async () => ({
        ok: true,
        value: {
          providers: {
            ...PROVIDERS,
            claude: {
              busy,
              accounts: [{ key: 'claude@example.invalid', isDefault: true }],
            },
          },
        },
      }),
      external: async () => ({
        ok: true,
        value: { 'kimi-code': { configured: true } },
      }),
      cancel: async () => ({ ok: false, error: { message: 'cancel failed' } }),
    })
    await settle(component)
    rowHeader(component.tree, 'Claude').props.onClick()
    await settle(component)
    busy = true
    buttonByText(component.tree, en.addAccountOAuth).props.onClick()
    await settle(component)
    assert.ok(
      buttonByText(component.tree, en.cancel),
      'the attempt started, so its cancel is offered',
    )
    buttonByText(component.tree, en.cancel).props.onClick()
    await settle(component)
    assert.match(text(component.tree), /cancel failed/, 'the failure is stated')
    assert.ok(
      buttonByText(component.tree, en.cancel),
      'the attempt is still running, so its cancel is still offered',
    )
    // The poller keeps observing the attempt, and its successful answers must
    // not erase the cancellation failure while the attempt is still running.
    await new Promise((resolve) => setTimeout(resolve, POLL_WAIT_MS))
    await settle(component)
    assert.match(
      text(component.tree),
      /cancel failed/,
      'still busy, still stated',
    )
    // Once the host reports settlement, the poller stops and the error clears.
    busy = false
    await new Promise((resolve) => setTimeout(resolve, POLL_WAIT_MS))
    await settle(component)
    assert.doesNotMatch(text(component.tree), /cancel failed/)
    component.unmount()
  })
})
test('a cancel that answers after unmount starts no poller', async () => {
  await withBrowser(async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let busy = true
    const { component, calls } = sectionWith({
      status: async () => ({
        ok: true,
        value: {
          providers: {
            ...PROVIDERS,
            claude: { busy, accounts: [{ key: 'me', isDefault: true }] },
          },
        },
      }),
      external: async () => ({
        ok: true,
        value: { 'kimi-code': { configured: true } },
      }),
      cancel: async () => {
        await gate
        return { ok: true, value: { ok: true } }
      },
    })
    await settle(component)
    rowHeader(component.tree, 'Claude').props.onClick()
    await settle(component)
    buttonByText(component.tree, en.cancel).props.onClick()
    await settle(component)
    // The settings page closes before the cancel request answers.
    component.unmount()
    const before = calls.filter(
      (call) => call.endpoint === 'subscriptions-auth.status',
    ).length
    busy = false
    release()
    await settle(component)
    await new Promise((resolve) => setTimeout(resolve, POLL_WAIT_MS))
    assert.equal(
      calls.filter((call) => call.endpoint === 'subscriptions-auth.status')
        .length,
      before,
      'no poll happened after unmount',
    )
  })
})

test('a recovered status poll clears its own failure line', async () => {
  await withBrowser(async () => {
    let statusFails = false
    const { component } = sectionWith({
      status: async () =>
        statusFails
          ? { ok: false, error: { message: 'status down' } }
          : { ok: true, value: { providers: PROVIDERS } },
      external: async () => ({
        ok: true,
        value: { 'kimi-code': { configured: true } },
      }),
      login: async () => ({ ok: true, value: { authorizeUrl: '' } }),
    })
    await settle(component)
    rowHeader(component.tree, 'Claude').props.onClick()
    await settle(component)
    statusFails = true
    buttonByText(component.tree, en.addAccountOAuth).props.onClick()
    await settle(component)
    assert.match(text(component.tree), new RegExp(en.rosterFailedTitle))
    statusFails = false
    buttonByText(component.tree, en.addAccountOAuth).props.onClick()
    await settle(component)
    assert.doesNotMatch(text(component.tree), new RegExp(en.rosterFailedTitle))
  })
})

test('a collapsed roster performs no usage read and shows no window', async () => {
  await withBrowser(async () => {
    const { component, calls } = sectionWith({})
    await settle(component)
    assert.equal(
      calls.filter((call) => call.endpoint === 'subscriptions-auth.usage')
        .length,
      0,
    )
    assert.equal(
      calls.filter(
        (call) => call.endpoint === 'subscriptions-auth.externalUsage',
      ).length,
      0,
      'no row detail was mounted to read a source',
    )
    assert.equal(
      nodes(component.tree).some((node) => node.type === UsageWindowRow),
      false,
      'a collapsed row states no quota',
    )
  })
})

test('expanding a row reads that account and shows the pending line', async () => {
  await withBrowser(async () => {
    const { component, calls } = sectionWith({
      usage: () => new Promise(() => {}),
    })
    await settle(component)
    const header = rowHeader(component.tree, 'Claude')
    assert.ok(header, 'the Claude row is listed')
    assert.equal(header.props['aria-expanded'], false)
    header.props.onClick()
    await settle(component)
    const usageCalls = calls.filter(
      (call) => call.endpoint === 'subscriptions-auth.usage',
    )
    assert.equal(usageCalls.length, 1)
    assert.equal(
      (usageCalls[0]!.payload as { provider?: string }).provider,
      'claude',
    )
    assert.match(text(component.tree), new RegExp(en.usageLoading))
  })
})

test('collapsing a row again keeps the reading it already made', async () => {
  await withBrowser(async () => {
    const { component, calls } = sectionWith({
      usage: async () => ({
        ok: true,
        value: {
          supported: true,
          windows: [{ kind: 'session', usedPercent: 9 }],
        },
      }),
    })
    await settle(component)
    rowHeader(component.tree, 'Claude').props.onClick()
    await settle(component)
    rowHeader(component.tree, 'Claude').props.onClick()
    await settle(component)
    assert.equal(
      calls.filter((call) => call.endpoint === 'subscriptions-auth.usage')
        .length,
      1,
    )
    rowHeader(component.tree, 'Claude').props.onClick()
    await settle(component)
    assert.equal(
      calls.filter((call) => call.endpoint === 'subscriptions-auth.usage')
        .length,
      1,
      'the reading is kept, not repeated',
    )
  })
})

test('a confirmed provider closes the form, states what was saved, and keeps its row', async () => {
  await withBrowser(async () => {
    let cursorConfigured = false
    const { component } = sectionWith({
      external: async () => ({
        ok: true,
        value: {
          'kimi-code': { configured: true },
          cursor: { configured: cursorConfigured },
        },
      }),
    })
    await settle(component)
    const add = mustNode(
      nodes(component.tree).find(
        (node) =>
          node.type === 'button' && text(node).includes('+ Add provider'),
      ),
      'add action',
    )
    add.props.onClick()
    await settle(component)
    const form = mustNode(
      nodes(component.tree).find((node) => node.type === AddProviderForm),
      'add form',
    )
    assert.equal(
      nodes(component.tree).some(
        (node) => node.props['aria-expanded'] !== undefined,
      ),
      false,
      'the form replaces the roster',
    )
    cursorConfigured = true
    form.props.onConfirmed('cursor', 'key', 'Cursor API key saved.')
    await settle(component)
    assert.equal(
      nodes(component.tree).some((node) => node.type === AddProviderForm),
      false,
      'the form is closed',
    )
    const body = text(component.tree)
    assert.match(body, /Cursor API key saved\./)
    assert.ok(
      rowHeader(component.tree, 'Cursor'),
      'the confirmed provider has one row',
    )
  })
})

// The account row's usage block, rendered by the detail that owns it.

function detailWith(
  usage: unknown,
  options: { busy?: boolean; error?: string; detail?: string } = {},
) {
  return OAuthProviderDetail({
    t,
    provider: 'claude',
    status: {
      busy: false,
      accounts: [{ key: 'me', isDefault: true }],
      ...(options.detail === undefined ? {} : { detail: options.detail }),
    },
    error: undefined,
    usages: usage === undefined ? {} : { 'claude:me': usage as never },
    observedAt: { 'claude:me': 1 },
    usageErrors:
      options.error === undefined ? {} : { 'claude:me': options.error },
    usageLoading: { 'claude:me': options.busy === true },
    deviceCode: undefined,
    copiedCode: false,
    manualDraft: '',
    resetBusy: false,
    resetAccount: undefined,
    resetMessage: '',
    onManualDraft: () => undefined,
    onManualSubmit: () => undefined,
    onLogin: () => undefined,
    onCancel: () => undefined,
    onLogout: () => undefined,
    onSetDefault: () => undefined,
    onCopyDeviceCode: () => undefined,
    onRefreshUsage: () => undefined,
    onManage: () => undefined,
    onPrepareReset: () => undefined,
  })
}

const BUDGET_READING = {
  supported: true,
  planWindowsAbsent: true,
  windows: [
    {
      kind: 'other',
      scope: 'Extra usage',
      usedAmount: 60_021,
      limitAmount: 60_000,
      limitSource: 'provider',
      remainingAmount: 0,
      currency: 'USD',
      usedPercent: 100,
    },
  ],
}

test('a provider detail line still renders inside the row', () => {
  const tree = detailWith(undefined, { detail: 'CLI 9.9.9 · latest on npm' })
  assert.match(text(tree), /CLI 9\.9\.9 · latest on npm/)
})

test('a pending usage read renders the loading line, not a crash', () => {
  const tree = detailWith(undefined, { busy: true })
  assert.match(text(tree), new RegExp(en.usageLoading))
  assert.equal(noteMounted(tree), false)
})

test('a failed usage read states the error and no missing-window note', () => {
  const tree = detailWith(undefined, { error: 'fixture usage failure' })
  assert.match(text(tree), /fixture usage failure/)
  assert.equal(noteMounted(tree), false)
})

test('a budget-only reading states the missing plan windows once', () => {
  const tree = detailWith(BUDGET_READING)
  assert.equal(moneyRowMounted(tree), true, 'the budget row is listed')
  assert.equal(
    noteMounted(tree),
    true,
    'the page states the missing plan windows',
  )
})

test('a reading with a plan window carries no missing-window note', () => {
  const tree = detailWith({
    supported: true,
    windows: [
      { kind: 'session', usedPercent: 12 },
      {
        kind: 'other',
        scope: 'Extra usage',
        usedAmount: 300,
        limitAmount: 6_000,
        currency: 'USD',
        usedPercent: 5,
      },
    ] as UsageWindow[],
  })
  assert.equal(moneyRowMounted(tree), true)
  assert.equal(noteMounted(tree), false)
})
