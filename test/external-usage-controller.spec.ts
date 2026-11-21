import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ExternalUsageController } from '../src/providers/external-usage-controller.js'

test('usage-only status reports configured refs without returning their values', async () => {
  const refs = new Map([['OPENCODE_GO_API_KEY', 'go-secret']])
  const controller = new ExternalUsageController(async (name) => {
    const value = refs.get(name)
    return value === undefined ? undefined : { value }
  })
  assert.deepEqual(await controller.status(), {
    'opencode-go': { configured: true },
    'kimi-code': { configured: false },
    minimax: { configured: false },
    'minimax-cn': { configured: false },
    'ollama-cloud': { configured: false },
    cursor: { configured: false },
  })
  assert.ok(!JSON.stringify(await controller.status()).includes('go-secret'))
  await assert.rejects(() => controller.usage('kimi-code'), /not configured/)
})

test('Kimi Code resolves the credential name used by the DSH base install', async () => {
  const seen: string[] = []
  const controller = new ExternalUsageController(async (name) => {
    seen.push(name)
    return name === 'KIMI_CODING_API_KEY' ? { value: 'kimi-secret' } : undefined
  })
  assert.deepEqual((await controller.status())['kimi-code'], {
    configured: true,
  })
  assert.ok(seen.includes('KIMI_CODING_API_KEY'))
  assert.ok(!JSON.stringify(await controller.status()).includes('kimi-secret'))
})

test('Kimi Code usage sends the resolved key to the Kimi usages endpoint', async () => {
  let calls = 0
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    calls += 1
    assert.equal(String(url), 'https://api.kimi.com/coding/v1/usages')
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      'Bearer kimi-secret',
    )
    return Response.json({
      usages: {
        limit_7d: { usedRatio: 0.25, resetAt: '2026-10-01T00:00:00Z' },
      },
    })
  }) as typeof fetch
  const controller = new ExternalUsageController(async (name) => {
    assert.equal(name, 'KIMI_CODING_API_KEY')
    return { value: 'kimi-secret' }
  }, http)
  assert.deepEqual(await controller.usage('kimi-code'), {
    supported: true,
    plan: 'Kimi Code',
    windows: [
      {
        kind: 'weekly',
        usedPercent: 25,
        fixedWindow: true,
        windowDurationMs: 604_800_000,
        resetsAt: Date.parse('2026-10-01T00:00:00Z'),
      },
    ],
  })
  assert.equal(calls, 1)
})

test('MiniMax regions resolve subscription refs and forward cancellation', async () => {
  const signal = new AbortController().signal
  for (const [source, ref, domain] of [
    ['minimax', 'MINIMAX_API_KEY', 'io'],
    ['minimax-cn', 'MINIMAX_CN_API_KEY', 'cn'],
  ] as const) {
    const http = (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(
        String(url),
        `https://www.minimax.${domain}/v1/token_plan/remains`,
      )
      assert.equal(init?.signal, signal)
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        'Bearer secret',
      )
      return Response.json({
        model_remains: [
          {
            model_name: 'M',
            current_interval_total_count: 100,
            current_interval_usage_count: 25,
          },
        ],
      })
    }) as typeof fetch
    const controller = new ExternalUsageController(
      async (name) => (name === ref ? { value: 'secret' } : undefined),
      http,
    )
    assert.equal((await controller.status())[source].configured, true)
    assert.ok(!JSON.stringify(await controller.status()).includes('secret'))
    assert.equal(
      (await controller.usage(source, signal)).windows![0]!.usedPercent,
      75,
    )
  }
})

test('usage-only keys are resolved on every read so DSH credential changes take effect', async () => {
  let key = 'first'
  const headers: string[] = []
  const http = (async (_url: string | URL | Request, init?: RequestInit) => {
    headers.push((init?.headers as Record<string, string>).authorization)
    return Response.json({ usage: { rolling: { percent: 10 } } })
  }) as typeof fetch
  const controller = new ExternalUsageController(
    async () => ({ value: key }),
    http,
  )
  await controller.usage('opencode-go')
  key = 'second'
  await controller.usage('opencode-go')
  assert.deepEqual(headers, ['Bearer first', 'Bearer second'])
})

test('MiniMax returns the standard model beside video for both regions', async () => {
  // Shaped after the public MiniMax-AI/cli quota fixtures: the standard model
  // carries explicit remaining percentages with zero counts, video carries counts.
  const start = Date.now() - 3_600_000
  const body = {
    base_resp: { status_code: 0 },
    model_remains: [
      {
        model_name: 'general',
        start_time: start,
        end_time: start + 18_000_000,
        weekly_start_time: start,
        weekly_end_time: start + 604_800_000,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_remaining_percent: 94,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        current_weekly_remaining_percent: 98,
      },
      {
        model_name: 'video',
        start_time: start,
        end_time: start + 86_400_000,
        weekly_start_time: start,
        weekly_end_time: start + 604_800_000,
        current_interval_total_count: 3,
        current_interval_usage_count: 3,
        current_interval_remaining_percent: 100,
        current_weekly_total_count: 21,
        current_weekly_usage_count: 21,
        current_weekly_remaining_percent: 100,
      },
    ],
  }
  for (const [source, ref] of [
    ['minimax', 'MINIMAX_API_KEY'],
    ['minimax-cn', 'MINIMAX_CN_API_KEY'],
  ] as const) {
    const http = (async () => Response.json(body)) as typeof fetch
    const controller = new ExternalUsageController(
      async (name) => (name === ref ? { value: 'secret' } : undefined),
      http,
    )
    const usage = await controller.usage(source)
    assert.deepEqual(
      usage.windows!.map((w) => `${w.scope}/${w.kind}=${w.usedPercent}`),
      [
        'general/session=6',
        'general/weekly=2',
        'video/other=0',
        'video/weekly=0',
      ],
    )
    assert.ok(!JSON.stringify(usage).includes('secret'))
  }
})

test('Ollama Cloud honors a custom credential ref override', async () => {
  const seen: string[] = []
  const controller = new ExternalUsageController(
    async (name) => {
      seen.push(name)
      return name === 'CUSTOM_OLLAMA_REF' ? { value: 'k' } : undefined
    },
    fetch,
    { 'ollama-cloud': 'CUSTOM_OLLAMA_REF' },
  )
  assert.deepEqual(await controller.status(), {
    'opencode-go': { configured: false },
    'kimi-code': { configured: false },
    minimax: { configured: false },
    'minimax-cn': { configured: false },
    'ollama-cloud': { configured: true },
    cursor: { configured: false },
  })
  assert.ok(seen.includes('CUSTOM_OLLAMA_REF'))
})

test('usage snapshots ref and host before the first await', async () => {
  // Regression for the cross-save race: a slow credential resolver must
  // not let a mid-flight save send the old ref's key to the new host.
  const seen: { url: string; auth: string }[] = []
  const controller = new ExternalUsageController(
    async (name) => {
      if (name === 'SLOW') {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { value: 'slow-key' }
      }
      return { value: 'fast-key' }
    },
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: String((init?.headers as Record<string, string>).authorization),
      })
      return Response.json({
        included: { balance_usd: 50, allowance_usd: 100 },
      })
    }) as typeof fetch,
    { 'ollama-cloud': 'SLOW' },
    'http://host-a/api',
  )
  const first = controller.usage('ollama-cloud')
  // Save switches host and ref while the first resolve is still pending.
  ;(controller as unknown as { refs: Record<string, () => string> }).refs[
    'ollama-cloud'
  ] = () => 'FAST'
  ;(controller as unknown as { ollamaBaseURL: () => string }).ollamaBaseURL =
    () => 'http://host-b/api'
  const second = controller.usage('ollama-cloud')
  await first
  await second
  // Pairings must hold regardless of completion order: the first call
  // keeps slow-key on the old host; the second rides the new pairing.
  assert.deepEqual(
    seen.find((call) => call.url === 'http://host-a/api/balance'),
    { url: 'http://host-a/api/balance', auth: 'Bearer slow-key' },
  )
  assert.deepEqual(
    seen.find((call) => call.url === 'http://host-b/api/balance'),
    { url: 'http://host-b/api/balance', auth: 'Bearer fast-key' },
  )
})

function cursorRouter(): {
  http: typeof fetch
  periods: () => number
  fail: (value: boolean) => void
} {
  let periods = 0
  let failing = false
  const http = (async (url: string | URL | Request) => {
    const target = String(url)
    if (target.includes('exchange_user_api_key')) {
      return Response.json({ accessToken: 'access-token' })
    }
    if (target.includes('GetCurrentPeriodUsage')) {
      periods += 1
      if (failing) throw new Error('boom')
      return Response.json({
        billingCycleStart: '1',
        billingCycleEnd: '2',
        spendLimitUsage: {
          overallLimit: 10_000,
          overallUsed: 1_000,
          overallRemaining: 9_000,
        },
      })
    }
    return Response.json({ planInfo: { planName: 'Enterprise' } })
  }) as typeof fetch
  return {
    http,
    periods: () => periods,
    fail: (value: boolean) => {
      failing = value
    },
  }
}

test('one Cursor reading serves every caller until forced or invalidated', async () => {
  const router = cursorRouter()
  const controller = new ExternalUsageController(
    async () => ({ value: 'cursor-secret' }),
    router.http,
  )
  const first = await controller.usage('cursor')
  const second = await controller.usage('cursor')
  assert.equal(router.periods(), 1)
  assert.deepEqual(second.windows, first.windows)
  await controller.usage('cursor', undefined, true)
  assert.equal(router.periods(), 2)
  controller.invalidate('cursor')
  await controller.usage('cursor')
  assert.equal(router.periods(), 3)
})

test('a failed refresh marks the shared reading stale for later readers', async () => {
  const router = cursorRouter()
  const controller = new ExternalUsageController(
    async () => ({ value: 'cursor-secret' }),
    router.http,
  )
  const good = await controller.usage('cursor')
  router.fail(true)
  const failed = await controller.usage('cursor', undefined, true)
  assert.deepEqual(failed.windows, good.windows)
  assert.equal(failed.stale, true)
  assert.equal(typeof failed.observedAt, 'number')
  // The next ordinary read inside the window must not look fresh again.
  const later = await controller.usage('cursor')
  assert.equal(later.stale, true)
  assert.equal(later.observedAt, failed.observedAt)
})

test('a changed credential reads again instead of serving the old account', async () => {
  const router = cursorRouter()
  let value = 'cursor-one'
  const controller = new ExternalUsageController(
    async () => ({ value }),
    router.http,
  )
  await controller.usage('cursor')
  value = 'cursor-two'
  await controller.usage('cursor')
  assert.equal(router.periods(), 2)
})

test('an invalidated read is neither joined nor republished', async () => {
  let releaseFirst!: () => void
  let periods = 0
  const http = (async (url: string | URL | Request) => {
    const target = String(url)
    if (target.includes('exchange_user_api_key')) {
      return Response.json({ accessToken: 'access-token' })
    }
    if (target.includes('GetCurrentPeriodUsage')) {
      periods += 1
      if (periods === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        return Response.json({
          billingCycleStart: '1',
          billingCycleEnd: '2',
          spendLimitUsage: { overallLimit: 10_000, overallUsed: 1_000 },
        })
      }
      return Response.json({
        billingCycleStart: '1',
        billingCycleEnd: '2',
        spendLimitUsage: { overallLimit: 10_000, overallUsed: 2_000 },
      })
    }
    return Response.json({ planInfo: { planName: 'Enterprise' } })
  }) as typeof fetch
  const controller = new ExternalUsageController(
    async () => ({ value: 'cursor-secret' }),
    http,
  )
  const pending = controller.usage('cursor', undefined, true)
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.invalidate('cursor')
  const fresh = await controller.usage('cursor')
  assert.equal(periods, 2, 'the new caller must not join the detached read')
  assert.equal(fresh.windows?.[0]?.usedAmount, 2_000)
  assert.equal(typeof fresh.observedAt, 'number')
  releaseFirst()
  const old = await pending
  assert.equal(old.windows?.[0]?.usedAmount, 1_000)
  assert.equal(typeof old.observedAt, 'number')
})
