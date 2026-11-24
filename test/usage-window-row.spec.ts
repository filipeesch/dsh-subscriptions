/**
 * The one window row every card mounts: the label rule, the numbers a window
 * carries, and the line a card states when its reading has a budget but no plan
 * window.
 *
 * Rendered statically: hooks fall back to their defaults, so these cases pin the
 * text and the label rule, not the browser layout or the meter's colors (those
 * live in the bar and pace specs).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  UsageWindowRow,
  usageWindowLabel,
  usageWindowValue,
} from '../src/client/UsageWindowRow.js'
import { formatMoney } from '../src/client/money-format.js'
import { PlanWindowsAbsentNote } from '../src/client/SubscriptionsSection.js'
import type { UsageWindow } from '../src/client/SubscriptionsSection.js'

const t = ((key: string) => key) as never
const translate = (key: string): string => key

test('a money window states the amount spent and the ceiling', () => {
  const window: UsageWindow = {
    kind: 'other',
    scope: 'Extra usage',
    usedAmount: 60_021,
    limitAmount: 60_000,
    limitSource: 'provider',
    remainingAmount: 0,
    currency: 'USD',
    usedPercent: 100,
  }
  const html = renderToStaticMarkup(
    createElement(UsageWindowRow, {
      window,
      t,
      observedAt: Date.now(),
    }),
  )
  assert.match(html, /Extra usage/)
  // The row routes amounts through the shared money formatter, whatever locale
  // the host renders it in.
  assert.ok(html.includes(formatMoney(60_021, 'USD')))
  assert.ok(html.includes(formatMoney(60_000, 'USD')))
  // A full meter is not the only cue: the row states what is left, including
  // an exhausted window's zero.
  assert.ok(html.includes(formatMoney(0, 'USD')))
  assert.match(html, /usageBarRemaining/)
})

test('a money window without a ceiling states that its share is unknown', () => {
  const window: UsageWindow = {
    kind: 'other',
    scope: 'Extra usage',
    usedAmount: 1_250,
    currency: 'USD',
  }
  const value = usageWindowValue(translate as never, window, 'used')
  assert.ok(value.includes(formatMoney(1_250, 'USD')))
  assert.match(value, /usageMeterShareUnavailable/)
  const html = renderToStaticMarkup(
    createElement(UsageWindowRow, { window, t }),
  )
  assert.match(html, /usageMeterShareUnavailable/)
})

test('a percent window states the share the preference selects', () => {
  const window: UsageWindow = { kind: 'session', usedPercent: 40 }
  assert.equal(
    usageWindowValue(translate as never, window, 'used'),
    'quotaUsedPercent',
  )
  const html = renderToStaticMarkup(
    createElement(UsageWindowRow, { window, t }),
  )
  assert.match(html, /usageSession/)
  assert.match(html, /quotaUsedPercent/)
})

test('a stale reading marks the row stale and keeps its numbers', () => {
  const window: UsageWindow = {
    kind: 'weekly',
    usedPercent: 12,
    resetsAt: Date.now() + 3_600_000,
  }
  const html = renderToStaticMarkup(
    createElement(UsageWindowRow, { window, t, stale: true }),
  )
  assert.match(html, /usageMeterStale/)
  assert.match(html, /usageResets/)
  assert.match(html, /quotaUsedPercent/)

  // A stale money row keeps the amounts it last reported.
  const money: UsageWindow = {
    kind: 'other',
    scope: 'Extra usage',
    usedAmount: 1_500,
    limitAmount: 6_000,
    currency: 'USD',
    usedPercent: 25,
  }
  const staleMoney = renderToStaticMarkup(
    createElement(UsageWindowRow, { window: money, t, stale: true }),
  )
  assert.ok(staleMoney.includes(formatMoney(1_500, 'USD')))
  assert.match(staleMoney, /usageMeterStale/)
})

test('a ceiling without a share states the amounts and no share note', () => {
  // A zero ceiling is a stated ceiling: the row must not claim the share is
  // unknown just because no ratio can be derived from it.
  const window: UsageWindow = {
    kind: 'other',
    scope: 'Extra usage',
    usedAmount: 500,
    limitAmount: 0,
    currency: 'USD',
  }
  const value = usageWindowValue(translate as never, window, 'used')
  assert.ok(value.includes(formatMoney(500, 'USD')))
  assert.ok(value.includes(formatMoney(0, 'USD')))
  assert.doesNotMatch(value, /usageMeterShareUnavailable/)
})

test('the percent preference selects the share label', () => {
  const window: UsageWindow = { kind: 'session', usedPercent: 40 }
  assert.equal(
    usageWindowValue(translate as never, window, 'remaining'),
    'quotaRemainingPercent',
  )
})

test('one label rule names a lane by itself and a kind with its scope', () => {
  assert.equal(
    usageWindowLabel(translate as never, {
      kind: 'weekly',
      scope: 'OAuth apps',
    }),
    'usageWeekly · OAuth apps',
  )
  assert.equal(
    usageWindowLabel(translate as never, { kind: 'weekly', scope: 'Opus' }),
    'usageWeekly · Opus',
  )
  assert.equal(
    usageWindowLabel(translate as never, {
      kind: 'other',
      scope: 'Extra usage',
    }),
    'Extra usage',
  )
  assert.equal(
    usageWindowLabel(translate as never, { kind: 'other' }),
    'usageWindow',
  )
  assert.equal(
    usageWindowLabel(translate as never, { kind: 'other', scope: 'Monthly' }),
    'usageMonthly',
  )
})

test('the missing-plan-window note states the reading, not a failure', () => {
  const html = renderToStaticMarkup(createElement(PlanWindowsAbsentNote, { t }))
  assert.match(html, /usagePlanWindowsAbsent/)
})
test('a money window without a currency states its amounts as plain numbers', () => {
  const window: UsageWindow = {
    kind: 'other',
    scope: 'Extra usage',
    usedAmount: 150,
    limitAmount: 600,
  }
  const value = usageWindowValue(translate as never, window, 'used')
  assert.ok(value.includes('1.50'))
  assert.ok(value.includes('6.00'))
  assert.ok(value.includes('usageCurrencyUnknown'))
  assert.doesNotMatch(value, /usageMeterShareUnavailable/)
})
