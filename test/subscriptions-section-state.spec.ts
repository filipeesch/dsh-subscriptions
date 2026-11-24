/**
 * The settings page renders every provider card while each account's usage is
 * still loading, and again after a usage read fails. Those two states used to
 * dereference the reading before it existed; these cases mount the real section
 * with a fixture RPC and assert what a reader sees.
 *
 * The hook dispatcher runs the component's own load/refresh logic; it does not
 * reconcile children, so a provider card's inner markup is not part of what this
 * proves. What it covers is the section's own state machine and the account row
 * it renders, including the "no plan window" note.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import {
  PlanWindowsAbsentNote,
  SubscriptionsSection,
} from '../src/client/SubscriptionsSection.js'
import { UsageWindowRow } from '../src/client/UsageWindowRow.js'
import { en } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import { Component, nodes, settle, text } from './component-harness.js'

const t = (key: SubscriptionsKey, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ''),
  )

/** Whether the page mounted the missing-plan-windows note. */
function noteMounted(component: Component): boolean {
  return nodes(component.tree).some(
    (node) => node.type === PlanWindowsAbsentNote,
  )
}

/** The money row the page mounted, when it mounted one. */
function moneyRowMounted(component: Component): boolean {
  return nodes(component.tree).some(
    (node) =>
      node.type === UsageWindowRow &&
      node.props.window.usedAmount !== undefined,
  )
}

/** The browser global the section touches after a successful usage read. */
async function withBrowser(work: () => Promise<void>): Promise<void> {
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  globals.window = { dispatchEvent: () => true }
  try {
    await work()
  } finally {
    if (previous === undefined) delete globals.window
    else globals.window = previous
  }
}

const STATUS = {
  ok: true,
  value: {
    providers: {
      codex: { busy: false, accounts: [] },
      claude: {
        busy: false,
        accounts: [{ key: 'claude@example.invalid', isDefault: true }],
      },
      grok: { busy: false, accounts: [] },
      copilot: { busy: false, accounts: [] },
      antigravity: { busy: false, accounts: [] },
    },
  },
}

/** The section with a Claude account, and one scripted usage answer. */
function sectionWith(usageAnswer: () => Promise<unknown>) {
  const rpc = {
    call: async (_channel: string, endpoint: string) => {
      if (endpoint === 'subscriptions-auth.status') return STATUS
      if (endpoint === 'subscriptions-auth.usage') return await usageAnswer()
      // The card and field endpoints stay quiet: this file is about the account
      // row, and every one of them answers something renderable.
      return { ok: true, value: {} }
    },
  } as unknown as ConnectionHandle['rpc']
  return new Component(() => SubscriptionsSection({ rpc, t: t as never }))
}

const BUDGET_READING = {
  ok: true,
  value: {
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
  },
}

test('a pending usage read renders the loading line, not a crash', async () => {
  await withBrowser(async () => {
    const component = sectionWith(() => new Promise(() => {}))
    await settle(component)
    const body = text(component.tree)
    assert.match(body, new RegExp(en.usageLoading))
    assert.equal(noteMounted(component), false)
  })
})

test('a failed usage read states the error and no missing-window note', async () => {
  await withBrowser(async () => {
    const component = sectionWith(async () => ({
      ok: false,
      error: { message: 'fixture usage failure' },
    }))
    await settle(component)
    const body = text(component.tree)
    assert.match(body, /fixture usage failure/)
    assert.equal(noteMounted(component), false)
  })
})

test('a budget-only reading states the missing plan windows once', async () => {
  await withBrowser(async () => {
    const component = sectionWith(async () => BUDGET_READING)
    await settle(component)
    assert.equal(moneyRowMounted(component), true, 'the budget row is listed')
    assert.equal(
      noteMounted(component),
      true,
      'the page states the missing plan windows',
    )
  })
})

test('a reading with a plan window carries no missing-window note', async () => {
  await withBrowser(async () => {
    const component = sectionWith(async () => ({
      ok: true,
      value: {
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
        ],
      },
    }))
    await settle(component)
    assert.equal(moneyRowMounted(component), true)
    assert.equal(noteMounted(component), false)
  })
})
