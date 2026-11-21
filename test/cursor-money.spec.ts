import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMoney } from '../src/client/money-format.js'
import { hasMoney, windowTooltip } from '../src/client/UsageBar.js'

type T = Parameters<typeof windowTooltip>[1]
const DICT: Record<string, string> = {
  usageMeterUsed: 'Used {used}% · Remaining {remaining}%',
  usageBarUsed: 'Used {value}',
  usageBarLimit: 'Ceiling {value}',
  usageBarRemaining: 'Remaining {value}',
  usageResets: 'resets {date}',
  usageMeterInvalid: 'Quota unavailable',
  usageMeterStale: 'Reading is stale or unavailable; refresh to confirm',
}
const t = ((key: string, params?: Record<string, unknown>) => {
  const values = params ?? {}
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    DICT[key] ?? key,
  )
}) as unknown as T

test('money formats cents with the window currency', () => {
  assert.equal(formatMoney(53_713, 'USD', 'en-US'), '$537.13')
  assert.equal(formatMoney(250_000, 'USD', 'en-US'), '$2,500.00')
  assert.equal(formatMoney(0, 'USD', 'en-US'), '$0.00')
  assert.equal(formatMoney(undefined, 'USD'), '')
  assert.equal(formatMoney(Number.NaN, 'USD'), '')
  // An unknown code must not throw.
  assert.match(formatMoney(120, 'ZZZ', 'en-US'), /1\.20/)
})

test('a money window states used, ceiling, remaining, and reset', () => {
  const window = {
    kind: 'other' as const,
    scope: 'Included usage',
    usedPercent: 21.49,
    usedAmount: 53_713,
    limitAmount: 250_000,
    remainingAmount: 196_287,
    currency: 'USD',
    resetsAt: Date.UTC(2026, 11, 1),
  }
  assert.equal(hasMoney(window), true)
  const text = windowTooltip(window, t)
  assert.match(text, /537[.,]13/)
  assert.match(text, /2\s?500[.,]00/)
  assert.match(text, /1\s?962[.,]87/)
  assert.match(text, /resets/)
})

test('a percentage window states used and remaining shares', () => {
  const text = windowTooltip({ kind: 'weekly', usedPercent: 62 }, t)
  assert.match(text, /used 62/i)
  assert.match(text, /remaining 38/i)
  assert.match(
    windowTooltip({ kind: 'weekly', usedPercent: 62 }, t, 'remaining'),
    /used 38/i,
  )
})

test('an invalid reading and a stale one are named', () => {
  const invalid = windowTooltip({ kind: 'weekly', usedPercent: Number.NaN }, t)
  assert.match(invalid, /Quota unavailable/)
  const stale = windowTooltip(
    { kind: 'weekly', usedPercent: 40 },
    t,
    'used',
    true,
  )
  assert.match(stale, /stale or unavailable/i)
})
