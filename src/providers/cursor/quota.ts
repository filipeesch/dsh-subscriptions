/**
 * Cursor's subscription quota, read with the account's own API key.
 *
 * Cursor's dashboard endpoints are not documented. The working recipe, verified
 * against a live enterprise account, is:
 *
 * 1. `POST /auth/exchange_user_api_key` with the API key as a bearer returns an
 *    access token. The API key alone gets 401 on the dashboard RPCs.
 * 2. `POST /aiserver.v1.DashboardService/GetCurrentPeriodUsage` with
 *    `include_pooled_usage: true` returns the cycle, the plan's percent buckets,
 *    and the spend limit. Without the flag the server omits both usage objects;
 *    with `personal_scope: true` it zeroes the limits.
 * 3. `POST /aiserver.v1.DashboardService/GetPlanInfo` names the plan.
 *
 * The enterprise response reports money (`overallLimit` / `overallUsed` in
 * cents) across a calendar month; a personal plan reports percentages. Both map
 * onto the shared usage window, which carries the amounts when they exist.
 * Cursor's owner-facing dashboard requires a session cookie the plugin does not
 * have, so these RPCs are the only source; a shape change fails the read and
 * leaves the rest of the route working.
 */

import type { ProviderUsage, UsageWindow } from '../common.js'
import { parseProviderJson, readBoundedJson } from '../common.js'
import type { FetchFn } from '../common.js'

/** Where Cursor's dashboard RPCs live. */
export const DEFAULT_CURSOR_ENDPOINT = 'https://api2.cursor.sh'

const MAX_BODY_BYTES = 1024 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function numeric(value: unknown): number | undefined {
  const number =
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number)
    ? number
    : undefined
}

function integer(value: unknown): number | undefined {
  const number = numeric(value)
  return number !== undefined && Number.isInteger(number) ? number : undefined
}

/** A finite, non-negative amount in the provider's minor unit. */
function amount(value: unknown): number | undefined {
  const parsed = numeric(value)
  return parsed === undefined || parsed < 0 ? undefined : parsed
}

/** A finite, strictly positive amount. */
function positive(value: unknown): number | undefined {
  const parsed = amount(value)
  return parsed === undefined || parsed === 0 ? undefined : parsed
}

function percent(value: unknown): number | undefined {
  const number = numeric(value)
  return number !== undefined && number >= 0 && number <= 100
    ? number
    : undefined
}

/** One RPC call; a non-2xx response fails with a fixed, credential-free message. */
async function call(
  url: string,
  token: string,
  body: unknown,
  http: FetchFn,
  signal: AbortSignal | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const response = await http(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    throw new Error(`Cursor usage endpoint returned HTTP ${response.status}`)
  }
  return parseProviderJson(response, 'cursor usage')
}

/**
 * Read one account's Cursor quota.
 *
 * @param apiKey - the Cursor API key the route also uses for chat.
 * @param options - ceiling fallback, HTTP seam, cancellation, endpoint override.
 * @returns the provider usage; windows are empty when the account reports none.
 * @throws when the key is rejected or an endpoint changes shape; the caller
 *   shows the failure and keeps the previous reading.
 */
export async function fetchCursorUsage(
  apiKey: string,
  options: {
    /** Monthly ceiling in US dollars, used only when the response has spend but no limit. */
    ceilingUSD?: number | undefined
    http?: FetchFn
    signal?: AbortSignal
    endpoint?: string
  } = {},
): Promise<ProviderUsage> {
  const http = options.http ?? fetch
  const endpoint = (options.endpoint ?? DEFAULT_CURSOR_ENDPOINT).replace(
    /\/+$/,
    '',
  )
  const signal = options.signal

  const exchange = record(
    await call(
      `${endpoint}/auth/exchange_user_api_key`,
      apiKey,
      {},
      http,
      signal,
    ),
  )
  const accessToken = exchange?.accessToken
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Cursor did not return an access token for this API key')
  }

  const periodResponse = await http(
    `${endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'x-cursor-client-type': 'cli',
      },
      body: JSON.stringify({ include_pooled_usage: true }),
      ...(signal === undefined ? {} : { signal }),
    },
  )
  if (!periodResponse.ok) {
    await periodResponse.body?.cancel().catch(() => undefined)
    throw new Error(
      `Cursor usage endpoint returned HTTP ${periodResponse.status}`,
    )
  }
  const period = record(
    await readBoundedJson(periodResponse, 'cursor usage', MAX_BODY_BYTES),
  )
  if (period === undefined)
    throw new Error('Cursor usage response is not an object')

  const cycleStart = integer(period.billingCycleStart)
  const cycleEnd = integer(period.billingCycleEnd)
  const timing = cycleTiming(cycleStart, cycleEnd)
  const spend = record(period.spendLimitUsage)
  const planUsage = record(period.planUsage)

  const windows: UsageWindow[] = []
  const rawUsed = spend?.overallUsed
  const rawLimit = spend?.overallLimit
  const rawRemaining = spend?.overallRemaining
  // A present but unusable amount is drift; it must not silently become the
  // fallback ceiling or a made-up remainder.
  const presentInvalid = (value: unknown) =>
    value !== undefined && amount(value) === undefined
  const spendValid =
    !presentInvalid(rawUsed) &&
    !presentInvalid(rawLimit) &&
    !presentInvalid(rawRemaining)
  const overallUsed = spendValid ? amount(rawUsed) : undefined
  const providedLimit = spendValid ? positive(rawLimit) : undefined

  if (overallUsed !== undefined) {
    const configured = positive(
      options.ceilingUSD === undefined
        ? undefined
        : Math.round(options.ceilingUSD * 100),
    )
    const limit = providedLimit ?? configured
    const remaining =
      limit === undefined
        ? spendValid
          ? amount(rawRemaining)
          : undefined
        : providedLimit === undefined
          ? Math.max(0, limit - overallUsed)
          : (amount(rawRemaining) ?? Math.max(0, limit - overallUsed))
    windows.push({
      kind: 'other',
      scope: 'Included usage',
      // Spend without a ceiling is still spend: report the amount and leave
      // the share unknown instead of inventing a percentage.
      ...(limit === undefined
        ? {}
        : { usedPercent: Math.min(100, (overallUsed / limit) * 100) }),
      usedAmount: overallUsed,
      ...(limit === undefined
        ? {}
        : {
            limitAmount: limit,
            limitSource:
              providedLimit === undefined ? 'configured' : 'provider',
          }),
      ...(remaining === undefined || remaining < 0
        ? {}
        : { remainingAmount: remaining }),
      currency: 'USD',
      ...timing,
    })
  }

  if (windows.length === 0 && planUsage !== undefined) {
    const buckets: { key: string; scope: string; limitKey: string }[] = [
      { key: 'autoPercentUsed', scope: 'Cursor models', limitKey: 'autoLimit' },
      { key: 'apiPercentUsed', scope: 'Other models', limitKey: 'apiLimit' },
      { key: 'totalPercentUsed', scope: 'Overall', limitKey: 'limit' },
    ]
    for (const bucket of buckets) {
      const usedPercent = percent(planUsage[bucket.key])
      if (usedPercent === undefined) continue
      // Only amounts the provider reports are shown; a percentage of a plan
      // allowance is not a dollar figure.
      const limitCents = positive(planUsage[bucket.limitKey])
      windows.push({
        kind: 'other',
        scope: bucket.scope,
        usedPercent,
        ...(limitCents === undefined
          ? {}
          : { limitAmount: limitCents, limitSource: 'provider' }),
        ...timing,
      })
    }
  }

  if (windows.length === 0) {
    // A JSON object without either known shape is schema drift, not a plan
    // with no usage; the card must say the read failed, not show zero.
    throw new Error('Cursor usage response was not recognized')
  }

  const plan = await planName(endpoint, accessToken, http, signal).catch(
    () => undefined,
  )
  return {
    supported: true,
    ...(windows.length === 0 ? {} : { windows }),
    ...(plan === undefined ? {} : { plan }),
  }
}

/** Window timing shared by every Cursor window: a provider-declared cycle. */
function cycleTiming(
  start: number | undefined,
  end: number | undefined,
): Pick<
  UsageWindow,
  'startsAt' | 'resetsAt' | 'windowDurationMs' | 'fixedWindow'
> {
  if (start === undefined || end === undefined || end <= start) return {}
  return {
    startsAt: start,
    resetsAt: end,
    windowDurationMs: end - start,
    fixedWindow: true,
  }
}

/** The plan's display name; a failure leaves the usage reading intact. */
async function planName(
  endpoint: string,
  accessToken: string,
  http: FetchFn,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const body = record(
    await call(
      `${endpoint}/aiserver.v1.DashboardService/GetPlanInfo`,
      accessToken,
      {},
      http,
      signal,
      { 'connect-protocol-version': '1', 'x-cursor-client-type': 'cli' },
    ),
  )
  const info = record(body?.planInfo)
  const name = info?.planName
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}
