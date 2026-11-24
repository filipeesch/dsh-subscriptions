import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchCursorUsage } from '../src/providers/cursor/quota.js'

const CYCLE = {
  billingCycleStart: '1793491200000',
  billingCycleEnd: '1796083200000',
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function fakeFetch(responses: unknown[]): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    })
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected request ' + url)
    const body = JSON.stringify(next)
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

function exchange(token = 'access-token') {
  return { accessToken: token, refreshToken: 'refresh' }
}

test('an enterprise plan reports spend against its ceiling', async () => {
  const { fetch, calls } = fakeFetch([
    exchange(),
    {
      ...CYCLE,
      spendLimitUsage: {
        limitType: 'team',
        overallLimit: 250_000,
        overallUsed: 53_713,
        overallRemaining: 196_287,
        pooledLimit: '10000000',
        pooledRemaining: '10000000',
      },
    },
    { planInfo: { planName: 'Enterprise' } },
  ])
  const usage = await fetchCursorUsage('crsr_key', { http: fetch })
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, 'Enterprise')
  const window = usage.windows?.[0]
  assert.equal(window?.kind, 'other')
  assert.equal(window?.scope, 'Included usage')
  assert.equal(window?.usedAmount, 53_713)
  assert.equal(window?.limitAmount, 250_000)
  assert.equal(window?.remainingAmount, 196_287)
  assert.equal(window?.currency, 'USD')
  assert.equal(Math.round(window!.usedPercent! * 100) / 100, 21.49)
  assert.equal(window?.resetsAt, Number(CYCLE.billingCycleEnd))
  assert.equal(window?.startsAt, Number(CYCLE.billingCycleStart))
  assert.equal(window?.fixedWindow, true)

  // The exchange carries the API key; the period read carries the access
  // token plus the Connect headers, and asks for pooled usage.
  assert.equal(
    calls[0]?.url,
    'https://api2.cursor.sh/auth/exchange_user_api_key',
  )
  assert.equal(calls[0]?.headers.authorization, 'Bearer crsr_key')
  assert.equal(
    calls[1]?.url,
    'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
  )
  assert.equal(calls[1]?.headers.authorization, 'Bearer access-token')
  assert.equal(calls[1]?.headers['connect-protocol-version'], '1')
  assert.equal(calls[1]?.headers['x-cursor-client-type'], 'cli')
  assert.deepEqual(calls[1]?.body, { include_pooled_usage: true })
})

test('a personal plan reports percent buckets', async () => {
  const { fetch } = fakeFetch([
    exchange(),
    {
      ...CYCLE,
      planUsage: {
        autoPercentUsed: 13.2,
        apiPercentUsed: 84.8,
        totalPercentUsed: 23.4,
        autoLimit: 100_000,
        apiLimit: 500_000,
        limit: 600_000,
      },
    },
    { planInfo: { planName: 'Pro' } },
  ])
  const usage = await fetchCursorUsage('crsr_key', { http: fetch })
  assert.equal(usage.plan, 'Pro')
  assert.deepEqual(
    usage.windows?.map((window) => [
      window.scope,
      Math.round(window.usedPercent ?? -1),
    ]),
    [
      ['Cursor models', 13],
      ['Other models', 85],
      ['Overall', 23],
    ],
  )
  assert.equal(usage.windows?.[0]?.limitAmount, 100_000)
  // A percentage of a plan allowance is not a dollar figure.
  assert.equal(usage.windows?.[0]?.usedAmount, undefined)
})

test('spend without a limit uses the configured ceiling', async () => {
  const { fetch } = fakeFetch([
    exchange(),
    {
      ...CYCLE,
      spendLimitUsage: {
        overallLimit: 0,
        overallUsed: 53_713,
        limitType: 'user',
      },
    },
    { planInfo: { planName: 'Enterprise' } },
  ])
  const usage = await fetchCursorUsage('crsr_key', {
    http: fetch,
    ceilingUSD: 2_500,
  })
  const window = usage.windows?.[0]
  assert.equal(window?.limitAmount, 250_000)
  assert.equal(window?.usedAmount, 53_713)
  assert.equal(window?.remainingAmount, 196_287)
  assert.equal(Math.round(window!.usedPercent!), 21)
})

test('spend without a limit keeps the amount and no share', async () => {
  const { fetch } = fakeFetch([
    exchange(),
    {
      ...CYCLE,
      spendLimitUsage: { overallLimit: 0, overallUsed: 53_713 },
    },
    { planInfo: { planName: 'Enterprise' } },
  ])
  const usage = await fetchCursorUsage('crsr_key', { http: fetch })
  assert.equal(usage.supported, true)
  const window = usage.windows?.[0]
  assert.equal(window?.usedAmount, 53_713)
  assert.equal(window?.currency, 'USD')
  assert.equal(window?.limitAmount, undefined)
  assert.equal(window?.usedPercent, undefined)
  assert.equal(window?.resetsAt, Number(CYCLE.billingCycleEnd))
})

test('an invalid amount or an unknown shape fails instead of showing a number', async () => {
  const negative = fakeFetch([
    exchange(),
    {
      ...CYCLE,
      spendLimitUsage: { overallLimit: 10_000, overallUsed: -1 },
    },
    { planInfo: { planName: 'Enterprise' } },
  ])
  await assert.rejects(
    fetchCursorUsage('crsr_key', { http: negative.fetch }),
    /not recognized/,
  )
  const drift = fakeFetch([exchange(), { unexpected: true }, {}])
  await assert.rejects(
    fetchCursorUsage('crsr_key', { http: drift.fetch }),
    /not recognized/,
  )
})

test('a rejected key fails with a fixed message and no token echo', async () => {
  const fetchImpl = (async () =>
    new Response('{"error":"unauthorized"}', {
      status: 401,
    })) as unknown as typeof fetch
  await assert.rejects(
    fetchCursorUsage('crsr_secret', { http: fetchImpl }),
    (error: Error) => {
      assert.match(error.message, /HTTP 401/)
      assert.equal(error.message.includes('crsr_secret'), false)
      return true
    },
  )
})

test('a plan-info failure leaves the usage reading intact', async () => {
  const { fetch } = fakeFetch([
    exchange(),
    {
      ...CYCLE,
      spendLimitUsage: {
        overallLimit: 250_000,
        overallUsed: 1_000,
        overallRemaining: 249_000,
      },
    },
  ])
  // The plan call receives no scripted response and throws; usage still maps.
  const usage = await fetchCursorUsage('crsr_key', { http: fetch })
  assert.equal(usage.windows?.length, 1)
  assert.equal(usage.plan, undefined)
})

test('a present but invalid limit is drift, not a reason to use the fallback', async () => {
  const { fetch } = fakeFetch([
    exchange(),
    {
      ...CYCLE,
      spendLimitUsage: { overallLimit: -5, overallUsed: 100 },
    },
    { planInfo: { planName: 'Enterprise' } },
  ])
  await assert.rejects(
    fetchCursorUsage('crsr_key', { http: fetch, ceilingUSD: 2_500 }),
    /not recognized/,
  )
})

test('the limit origin travels with the window', async () => {
  const provided = fakeFetch([
    exchange(),
    {
      ...CYCLE,
      spendLimitUsage: {
        overallLimit: 10_000,
        overallUsed: 1_000,
        overallRemaining: 9_000,
      },
    },
    { planInfo: { planName: 'Enterprise' } },
  ])
  const a = await fetchCursorUsage('crsr_key', { http: provided.fetch })
  assert.equal(a.windows?.[0]?.limitSource, 'provider')

  const configured = fakeFetch([
    exchange(),
    { ...CYCLE, spendLimitUsage: { overallUsed: 1_000 } },
    { planInfo: { planName: 'Enterprise' } },
  ])
  const b = await fetchCursorUsage('crsr_key', {
    http: configured.fetch,
    ceilingUSD: 2_500,
  })
  assert.equal(b.windows?.[0]?.limitSource, 'configured')
  assert.equal(b.windows?.[0]?.limitAmount, 250_000)
  assert.equal(b.windows?.[0]?.remainingAmount, 249_000)
})

test('an exchanged token that cannot ride a header is refused before the second request', async () => {
  // The token comes from the provider, not from the card, and it rides its own
  // header: a transport error quoting that header would carry it. The marker must
  // not reach the message and no request may be attempted with it.
  const marker = 'sk-token-marker'
  const { fetch, calls } = fakeFetch([exchange(`${marker}\r\nX-Injected: 1`)])
  await assert.rejects(
    () => fetchCursorUsage('api-key', { http: fetch }),
    (error: Error) => {
      assert.match(error.message, /control characters/)
      assert.doesNotMatch(error.message, new RegExp(marker))
      return true
    },
  )
  assert.equal(calls.length, 1, 'only the exchange was requested')
  assert.ok(!calls[0]?.headers.authorization?.includes(marker))
})

test('a transport failure is reported without the request it carried', async () => {
  // Node's invalid-header error quotes the value it rejected. The controller's
  // transport guard replaces that failure with a fixed sentence, so the value
  // cannot reach the reply; the fetch stub here throws the way undici does.
  const marker = 'sk-header-value-marker'
  const http = (async () => {
    throw new TypeError(
      `Headers.append: "${marker}" is an invalid header value`,
    )
  }) as unknown as typeof fetch
  const { ExternalUsageController } =
    await import('../src/providers/external-usage-controller.js')
  const controller = new ExternalUsageController(
    async () => ({ value: 'api-key', source: 'file' }),
    http,
  )
  await assert.rejects(
    () => controller.usage('opencode-go'),
    (error: Error) => {
      assert.match(error.message, /usage endpoint could not be reached/)
      assert.doesNotMatch(error.message, new RegExp(marker))
      return true
    },
  )
})
