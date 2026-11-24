/**
 * The Claude usage reader's second account shape: an enterprise seat reported
 * as a dollar budget, and the OAuth-apps weekly lane beside the plan windows.
 *
 * Shapes come from a live read of the endpoint by the account owner: the plan
 * buckets were null, `limits` was empty, and the budget arrived in `spend` with
 * an explicit exponent and currency, plus a flat `extra_usage` block. The
 * endpoint is not a published contract, so these fixtures pin the two shapes the
 * reader accepts rather than the provider's promises.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchClaudeUsage } from '../src/providers/claude.js'
import type { ClaudeSession } from '../src/auth/store.js'

const session = {
  accessToken: 'fake-access',
  refreshToken: 'fake-refresh',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'user:inference user:profile',
} as ClaudeSession

const cliVersion = async (): Promise<string> => '2.1.329'

/** Answer every request with one payload, the way the endpoint would. */
function usage(payload: unknown) {
  return async (): Promise<Response> => Response.json(payload)
}

/** An enterprise seat: every plan bucket null, the budget in the spend block. */
function enterprisePayload(overrides: Record<string, unknown> = {}) {
  return {
    five_hour: null,
    seven_day: null,
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [],
    extra_usage: {
      is_enabled: true,
      monthly_limit: 60000,
      used_credits: 60021,
      utilization: 100,
      currency: 'USD',
      decimal_places: 2,
    },
    spend: {
      used: { amount_minor: 60021, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 60000, currency: 'USD', exponent: 2 },
      percent: 100,
      enabled: true,
      severity: 'critical',
      balance: null,
      cap: { money: null, credits: { amount_minor: 60000, exponent: 2 } },
    },
    ...overrides,
  }
}

test('an enterprise seat reads as one money window after no plan window', async () => {
  const reading = await fetchClaudeUsage(
    session,
    usage(enterprisePayload()),
    undefined,
    cliVersion,
  )
  assert.equal(reading.supported, true)
  assert.deepEqual(reading.windows, [
    {
      kind: 'other',
      scope: 'Extra usage',
      usedPercent: 100,
      usedAmount: 60021,
      limitAmount: 60000,
      limitSource: 'provider',
      remainingAmount: 0,
      currency: 'USD',
    },
  ])
  assert.equal(reading.planWindowsAbsent, true)
})

test('the share falls back to the amounts when the endpoint reports none', async () => {
  const payload = enterprisePayload({
    spend: {
      used: { amount_minor: 15000, exponent: 2, currency: 'USD' },
      limit: { amount_minor: 60000, exponent: 2, currency: 'USD' },
      enabled: true,
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  assert.equal(reading.windows?.[0]?.usedPercent, 25)
})

test('a declared exponent other than two is normalized to cents', async () => {
  // Five units at exponent zero are five dollars, not five cents.
  const payload = enterprisePayload({
    spend: {
      used: { amount_minor: 5, exponent: 0, currency: 'USD' },
      limit: { amount_minor: 20, exponent: 0, currency: 'USD' },
      enabled: true,
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  const window = reading.windows?.[0]
  assert.equal(window?.usedAmount, 500)
  assert.equal(window?.limitAmount, 2000)
  assert.equal(window?.remainingAmount, 1500)
})

test('the flat extra-usage block is read when the spend block is absent', async () => {
  const payload = enterprisePayload({ spend: null })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  const window = reading.windows?.[0]
  assert.equal(window?.scope, 'Extra usage')
  assert.equal(window?.usedAmount, 60021)
  assert.equal(window?.limitAmount, 60000)
  assert.equal(window?.currency, 'USD')
  assert.equal(reading.planWindowsAbsent, true)
})

test('the spend block wins over the flat block', async () => {
  const payload = enterprisePayload({
    extra_usage: { is_enabled: true, monthly_limit: 1, used_credits: 1 },
    spend: {
      used: { amount_minor: 700, exponent: 2, currency: 'USD' },
      limit: { amount_minor: 1400, exponent: 2, currency: 'USD' },
      enabled: true,
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  assert.equal(reading.windows?.[0]?.usedAmount, 700)
})

test('a disabled budget produces no window', async () => {
  for (const payload of [
    enterprisePayload({ spend: { enabled: false, used: { amount_minor: 1 } } }),
    enterprisePayload({
      spend: null,
      extra_usage: { is_enabled: false, monthly_limit: 100, used_credits: 50 },
    }),
  ]) {
    const reading = await fetchClaudeUsage(
      session,
      usage(payload),
      undefined,
      cliVersion,
    )
    assert.deepEqual(reading.windows, [])
    assert.equal(reading.planWindowsAbsent, undefined)
  }
})

test('an unusable amount is omitted rather than rendered as zero', async () => {
  for (const amount of [{ amount_minor: -1 }, { amount_minor: 'many' }]) {
    const payload = enterprisePayload({
      spend: { enabled: true, used: amount, limit: { amount_minor: 100 } },
      extra_usage: null,
    })
    const reading = await fetchClaudeUsage(
      session,
      usage(payload),
      undefined,
      cliVersion,
    )
    assert.deepEqual(reading.windows, [])
  }
})

test('spend without a ceiling states the amount and invents no share', async () => {
  const payload = enterprisePayload({
    spend: { used: { amount_minor: 1250, exponent: 2, currency: 'USD' } },
    extra_usage: null,
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  const window = reading.windows?.[0]
  assert.equal(window?.usedAmount, 1250)
  assert.equal(window?.usedPercent, undefined)
  assert.equal(window?.limitAmount, undefined)
  assert.equal(window?.remainingAmount, undefined)
})

test('the OAuth-apps lane is its own scoped weekly window', async () => {
  const resets = new Date(Date.now() + 86_400_000).toISOString()
  const reading = await fetchClaudeUsage(
    session,
    usage({
      five_hour: { utilization: 10, resets_at: resets },
      seven_day: { utilization: 20, resets_at: resets },
      seven_day_oauth_apps: { utilization: 30, resets_at: resets },
    }),
    undefined,
    cliVersion,
  )
  assert.deepEqual(
    reading.windows?.map((window) => [window.kind, window.scope]),
    [
      ['session', undefined],
      ['weekly', undefined],
      ['weekly', 'OAuth apps'],
    ],
  )
  assert.equal(reading.planWindowsAbsent, undefined)
})

test('a subscription that also reports overage keeps the plan quota first', async () => {
  const resets = new Date(Date.now() + 3_600_000).toISOString()
  const reading = await fetchClaudeUsage(
    session,
    usage({
      ...enterprisePayload(),
      five_hour: { utilization: 12, resets_at: resets },
      seven_day: { utilization: 40, resets_at: resets },
      spend: {
        used: { amount_minor: 300, exponent: 2, currency: 'USD' },
        limit: { amount_minor: 6000, exponent: 2, currency: 'USD' },
        enabled: true,
      },
    }),
    undefined,
    cliVersion,
  )
  const kinds = reading.windows?.map((window) => window.kind)
  assert.deepEqual(kinds, ['session', 'weekly', 'other'])
  assert.equal(reading.windows?.at(-1)?.scope, 'Extra usage')
  assert.equal(reading.planWindowsAbsent, undefined)
})

test('the structured plan list still outranks the flat buckets beside a budget', async () => {
  const reading = await fetchClaudeUsage(
    session,
    usage({
      ...enterprisePayload(),
      five_hour: { utilization: 90 },
      limits: [{ kind: 'session', percent: 5 }],
    }),
    undefined,
    cliVersion,
  )
  assert.equal(reading.windows?.[0]?.usedPercent, 5)
  assert.equal(reading.windows?.at(-1)?.scope, 'Extra usage')
})

test('an unusable structured ceiling drops the budget instead of falling back', async () => {
  // The spend block is authoritative when present. A ceiling it states but
  // cannot support must not be replaced by the older flat block, and must not
  // become a spend-only row either.
  const payload = enterprisePayload({
    spend: {
      enabled: true,
      used: { amount_minor: 1500, exponent: 2, currency: 'USD' },
      limit: { amount_minor: -1, exponent: 2, currency: 'USD' },
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  assert.deepEqual(reading.windows, [])
})

test('an unusable structured spend does not fall through to the flat block', async () => {
  const payload = enterprisePayload({
    spend: { enabled: true, used: { amount_minor: 'many' } },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  assert.deepEqual(reading.windows, [])
})

test('a ceiling the flat block reports as zero stays zero', async () => {
  const payload = enterprisePayload({
    spend: null,
    extra_usage: {
      is_enabled: true,
      used_credits: 500,
      monthly_limit: 0,
      decimal_places: 2,
      currency: 'USD',
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  const window = reading.windows?.[0]
  assert.equal(window?.limitAmount, 0)
  assert.equal(window?.limitSource, 'provider')
  // No proportion is derived from a zero ceiling.
  assert.equal(window?.usedPercent, undefined)
  assert.equal(window?.remainingAmount, 0)
})

test('a ceiling stated in another currency is dropped, not divided', async () => {
  const payload = enterprisePayload({
    spend: {
      enabled: true,
      used: { amount_minor: 1500, exponent: 2, currency: 'USD' },
      limit: { amount_minor: 6000, exponent: 2, currency: 'EUR' },
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  const window = reading.windows?.[0]
  assert.equal(window?.usedAmount, 1500)
  assert.equal(window?.currency, 'USD')
  assert.equal(window?.limitAmount, undefined)
  assert.equal(window?.usedPercent, undefined)
})

test('the reported balance becomes the remaining amount', async () => {
  const payload = enterprisePayload({
    spend: {
      enabled: true,
      used: { amount_minor: 1500, exponent: 2, currency: 'USD' },
      limit: { amount_minor: 6000, exponent: 2, currency: 'USD' },
      balance: { amount_minor: 4100, exponent: 2, currency: 'USD' },
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  assert.equal(reading.windows?.[0]?.remainingAmount, 4100)
})

test('a reported share above the seam contract is clamped', async () => {
  const payload = enterprisePayload({
    spend: {
      enabled: true,
      used: { amount_minor: 6300, exponent: 2, currency: 'USD' },
      limit: { amount_minor: 6000, exponent: 2, currency: 'USD' },
      percent: 105,
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  assert.equal(reading.windows?.[0]?.usedPercent, 100)
})

test('the flat block scales both numbers by its declared decimals', async () => {
  const payload = enterprisePayload({
    spend: null,
    extra_usage: {
      is_enabled: true,
      used_credits: 1_5,
      monthly_limit: 2_0,
      decimal_places: 1,
      currency: 'USD',
      utilization: 75,
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  const window = reading.windows?.[0]
  assert.equal(window?.usedAmount, 150)
  assert.equal(window?.limitAmount, 200)
  assert.equal(window?.usedPercent, 75)
})
test('a declared scale that cannot be read is invalid, not a default', async () => {
  const payload = enterprisePayload({
    spend: {
      enabled: true,
      used: { amount_minor: 1500, exponent: 'two', currency: 'USD' },
      limit: { amount_minor: 6000, exponent: 2, currency: 'USD' },
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  assert.deepEqual(reading.windows, [])
})

test('a spend block that is not an object is invalid, not absent', async () => {
  const payload = enterprisePayload({ spend: 'disabled' as never })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  // The flat block beside it must not answer for a drifted spend block.
  assert.deepEqual(reading.windows, [])
})

test('an extra-usage block that is not an object is not read as absent', async () => {
  const payload = enterprisePayload({
    spend: null,
    extra_usage: 'truthy' as never,
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  assert.deepEqual(reading.windows, [])
})

test('a balance in another currency is ignored and the remaining amount derived', async () => {
  const payload = enterprisePayload({
    spend: {
      enabled: true,
      used: { amount_minor: 1500, exponent: 2, currency: 'USD' },
      limit: { amount_minor: 6000, exponent: 2, currency: 'USD' },
      balance: { amount_minor: 9000, exponent: 2, currency: 'EUR' },
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  assert.equal(reading.windows?.[0]?.remainingAmount, 4500)
})

test('an unusable balance is ignored without dropping the window', async () => {
  const payload = enterprisePayload({
    spend: {
      enabled: true,
      used: { amount_minor: 1500, exponent: 2, currency: 'USD' },
      limit: { amount_minor: 6000, exponent: 2, currency: 'USD' },
      balance: { amount_minor: -1, exponent: 2, currency: 'USD' },
    },
  })
  const reading = await fetchClaudeUsage(
    session,
    usage(payload),
    undefined,
    cliVersion,
  )
  assert.equal(reading.windows?.[0]?.usedAmount, 1500)
  assert.equal(reading.windows?.[0]?.remainingAmount, 4500)
})
