/**
 * Unit tests for the `/subscriptions-auth` `image` endpoint: payload
 * validation, the base64 round trip through a fake attachment store, and the
 * no-service / read-failure error results. Drives the real plugin wiring with
 * a fake host connection; DSH_HOME is redirected to a temp dir. Also covers
 * the `status` endpoint degrading per provider when one store entry is corrupt.
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { RpcResult } from '../src/compat.js'
import { SUBSCRIPTIONS_AUTH_ENDPOINTS } from '../src/auth/rpc.js'
import { createFakeConnection } from './fake-connection.js'
import type { FakeConnectionHandler } from './fake-connection.js'

const home = mkdtempSync(join(tmpdir(), 'router-rpc-test-'))
// Suite-level hook: the mkdtemp is top-level, so there is no test context to hang t.after on.
after(() => {
  rmSync(home, { recursive: true, force: true })
})
process.env.DSH_HOME = home
/** The auth store every mount in this file shares; a test that writes it removes it again. */
const authFile = join(
  process.env.DSH_HOME,
  'plugins',
  'subscriptions',
  'auth.json',
)

// Imports after the env override so the store path resolves under the temp home.
const plugin = await import('../src/index.js')

interface FakeStore {
  readImage(
    ref: unknown,
    signal?: AbortSignal,
  ): Promise<{ ref: unknown; data: Uint8Array }>
}

/**
 * The credential seam a mount supplies. Tests that never touch a credential
 * omit it; the key-route cases provide the methods they exercise.
 */
type FakeCredentials = Partial<
  Pick<CredentialProvider, 'resolve' | 'describe' | 'set' | 'unset'>
>

/** Mount the plugin with fake llm/connection (and optional attachments); return the RPC handler. */
async function mount(
  attachments?: FakeStore,
  credentials?: FakeCredentials,
  config: Record<string, unknown> = {},
): Promise<FakeConnectionHandler> {
  const ctx = new Context()
  // Capture route re-announcements, the host's signal to re-list models.
  const replacedRoutes: string[][] = []
  ctx.provide('llm', {
    registerAdapter: () =>
      Object.assign(() => {}, {
        replace: (routes: string[]) => {
          replacedRoutes.push(routes)
        },
      }),
  })
  const fake = createFakeConnection()
  ctx.provide('connection', fake.connection)
  if (attachments !== undefined) ctx.provide('attachments', attachments)
  if (credentials !== undefined)
    ctx.provide('credentials', credentials as CredentialProvider)
  // codexClientVersion pins the presented version so `status` never reaches
  // for the npm registry (the hermetic run blocks it); the config branch is
  // the deterministic one for a mounted-plugin test.
  ctx.plugin(plugin, {
    providers: ['codex'],
    codexClientVersion: '0.153.4',
    ...config,
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(fake.registered(), 'the subscriptions-auth routes were registered')
  ;(fake.handler as unknown as { replacedRoutes: string[][] }).replacedRoutes =
    replacedRoutes
  return fake.handler
}

test('usage-only RPC reports key presence and rejects unknown sources without exposing secrets', async () => {
  const handler = await mount(undefined, {
    resolve: async (ref) =>
      ref === 'OPENCODE_GO_API_KEY'
        ? { value: 'go-secret', source: 'env' }
        : undefined,
  })
  const signal = new AbortController().signal
  const status = await handler('externalStatus', {}, signal)
  assert.deepEqual(status, {
    ok: true,
    value: {
      'opencode-go': { configured: true },
      'kimi-code': { configured: false },
      minimax: { configured: false },
      'minimax-cn': { configured: false },
      'ollama-cloud': { configured: false },
      cursor: { configured: false },
    },
  })
  assert.ok(!JSON.stringify(status).includes('go-secret'))
  const unknown = await handler(
    'externalUsage',
    { source: 'not-a-source' },
    signal,
  )
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.equal(unknown.error.code, 'bad-request')
  const missing = await handler(
    'externalUsage',
    { source: 'kimi-code' },
    signal,
  )
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error.message, /not configured/)
})

test('removed Cursor and proxy RPC endpoints have no routes', async () => {
  const handler = await mount()
  const signal = new AbortController().signal
  for (const endpoint of [
    // The old standalone plugin's account endpoints stay gone; the settings
    // card instead serves cursorModels, cursorSetSettings, and
    // cursorRefreshContext.
    'cursorStatus',
    'cursorLogin',
    'cursorCancel',
    'cursorLogout',
    'cursorUsage',
    'proxyGet',
    'proxySet',
    'proxyTest',
  ]) {
    await assert.rejects(handler(endpoint, {}, signal), /no route registered/)
  }
})

const REF = {
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 2,
  width: 1,
  height: 1,
}

async function call(
  handler: FakeConnectionHandler,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  return handler('image', payload, new AbortController().signal)
}

test('image endpoint: base64 round trip through the attachment store', async () => {
  const seen: unknown[] = []
  const handler = await mount({
    readImage: (ref) => {
      seen.push(ref)
      return Promise.resolve({ ref, data: new Uint8Array([104, 105]) })
    },
  })
  const result = await call(handler, REF)
  assert.deepEqual(result, {
    ok: true,
    value: { mediaType: 'image/png', dataBase64: 'aGk=' },
  })
  assert.deepEqual(
    seen,
    [REF],
    'the full validated reference reaches readImage',
  )
})

test('image endpoint: no attachment service → internal error result', async () => {
  const handler = await mount()
  const result = await call(handler, REF)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /no attachment service/)
  }
})

test('image endpoint: read failure → internal error result with the message', async () => {
  const handler = await mount({
    readImage: () => Promise.reject(new Error('digest mismatch')),
  })
  const result = await call(handler, REF)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /digest mismatch/)
  }
})

test('image endpoint: payload validation', async () => {
  const handler = await mount({
    readImage: () => Promise.reject(new Error('unused')),
  })
  const bad = [
    [{}, /attachmentId/],
    [{ ...REF, attachmentId: '' }, /attachmentId/],
    [{ ...REF, mediaType: 'image/tiff' }, /mediaType/],
    [{ ...REF, bytes: 0 }, /bytes/],
    [{ ...REF, width: 1.5 }, /width/],
    [{ ...REF, name: 7 }, /name/],
    ['nope', /object/],
  ] as const
  for (const [payload, pattern] of bad) {
    const result = await call(handler, payload)
    assert.equal(result.ok, false, JSON.stringify(payload))
    if (!result.ok) {
      assert.equal(result.error.code, 'bad-request')
      assert.match(result.error.message, pattern)
    }
  }
})

test('video endpoint: base64 round trip from the videos directory', async () => {
  const videosDir = join(
    process.env.DSH_HOME as string,
    'plugins',
    'subscriptions',
    'videos',
  )
  mkdirSync(videosDir, { recursive: true })
  writeFileSync(join(videosDir, 'clip.mp4'), Buffer.from('hi'))
  const handler = await mount()
  const result = await handler(
    'video',
    { name: 'clip.mp4' },
    new AbortController().signal,
  )
  assert.deepEqual(result, {
    ok: true,
    value: { mediaType: 'video/mp4', dataBase64: 'aGk=' },
  })
})

test('video endpoint: name validation and missing file', async () => {
  const handler = await mount()
  const bad = [
    {},
    { name: '' },
    { name: 'clip.webm' },
    { name: '../escape.mp4' },
    { name: 'a/b.mp4' },
    'nope',
  ]
  for (const payload of bad) {
    const result = await handler('video', payload, new AbortController().signal)
    assert.equal(result.ok, false, JSON.stringify(payload))
    if (!result.ok) assert.equal(result.error.code, 'bad-request')
  }
  const missing = await handler(
    'video',
    { name: 'absent.mp4' },
    new AbortController().signal,
  )
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.error.code, 'internal')
})

test('speed endpoints: per-session tier round trip and payload validation', async () => {
  // Logged in, `speed` would fetch the real Codex catalog for its fast models.
  assert.equal(
    existsSync(authFile),
    false,
    'another test left a signed-in auth store behind',
  )
  const handler = await mount()
  const signal = new AbortController().signal
  // Logged out and undiscovered: standard tier, no fast-capable models.
  assert.deepEqual(await handler('speed', { sessionId: 's1' }, signal), {
    ok: true,
    value: { tier: 'standard', fastModels: [] },
  })
  assert.deepEqual(
    await handler('setSpeed', { sessionId: 's1', tier: 'fast' }, signal),
    {
      ok: true,
      value: { ok: true },
    },
  )
  assert.deepEqual(await handler('speed', { sessionId: 's1' }, signal), {
    ok: true,
    value: { tier: 'fast', fastModels: [] },
  })
  // Another session is unaffected; setting standard clears the entry.
  assert.deepEqual(await handler('speed', { sessionId: 's2' }, signal), {
    ok: true,
    value: { tier: 'standard', fastModels: [] },
  })
  await handler('setSpeed', { sessionId: 's1', tier: 'standard' }, signal)
  assert.deepEqual(await handler('speed', { sessionId: 's1' }, signal), {
    ok: true,
    value: { tier: 'standard', fastModels: [] },
  })

  const bad = [
    ['speed', {}, /sessionId/],
    ['speed', 'nope', /object/],
    ['speed', { sessionId: 's1', model: 1 }, /model/],
    ['setSpeed', { sessionId: 's1' }, /tier/],
    ['setSpeed', { sessionId: 's1', tier: 'ludicrous' }, /tier/],
  ] as const
  for (const [endpoint, payload, pattern] of bad) {
    const result = await handler(endpoint, payload, signal)
    assert.equal(result.ok, false, JSON.stringify(payload))
    if (!result.ok) {
      assert.equal(result.error.code, 'bad-request')
      assert.match(result.error.message, pattern)
    }
  }
})

test('status endpoint: one corrupt provider entry degrades alone, others still report', async (t) => {
  // The exact corruption seen in the wild: empty tokens under a claude key.
  // Before the fix this rejected the WHOLE status call and the UI sat on
  // "Checking…" forever with every provider blind.
  mkdirSync(join(authFile, '..'), { recursive: true })
  t.after(() => {
    rmSync(authFile, { force: true })
  })
  writeFileSync(
    authFile,
    JSON.stringify({
      codex: {
        default: 'acct-1',
        accounts: {
          'acct-1': {
            accessToken: 'at',
            refreshToken: 'rt',
            expiresAt: Date.now() + 3600_000,
            accountId: 'acct-1',
          },
        },
      },
      claude: {
        default: 'corrupt',
        accounts: {
          corrupt: { accessToken: '', refreshToken: '', expiresAt: 0 },
        },
      },
    }),
    { mode: 0o600 },
  )
  const handler = await mount()
  const result = await handler('status', {}, new AbortController().signal)
  assert.ok(result.ok, 'the status call itself must succeed')
  if (!result.ok) return
  const providers = (
    result.value as {
      providers: Record<string, { accounts: unknown[]; detail?: string }>
    }
  ).providers
  assert.equal(
    providers.codex.accounts.length,
    1,
    'codex still reports its account',
  )
  assert.equal(
    providers.claude.accounts.length,
    0,
    'the corrupt claude entry is skipped',
  )
})

test('the Cursor card reads settings and validates the ceiling payload', async () => {
  const handler = await mount()
  const signal = new AbortController().signal
  const initial = await handler('cursorSettings', {}, signal)
  assert.equal(initial.ok, true)
  if (initial.ok) {
    const value = initial.value as {
      keyRef: string
      knownContext: { enabled: boolean }
    }
    assert.equal(value.keyRef, 'CURSOR_API_KEY')
    assert.equal(value.knownContext.enabled, true)
  }
  // A malformed payload is refused instead of clearing the stored value.
  for (const payload of [
    null,
    {},
    { ceilingUSD: 0 },
    { ceilingUSD: -5 },
    { ceilingUSD: 10_000_000 },
    { ceilingUSD: '2500' },
  ]) {
    const result = await handler('cursorSetCeiling', payload, signal)
    assert.equal(result.ok, false, JSON.stringify(payload))
    if (!result.ok) assert.equal(result.error.code, 'bad-request')
  }
  const saved = await handler('cursorSetCeiling', { ceilingUSD: 2500 }, signal)
  assert.equal(saved.ok, true)
  const stored = await handler('cursorSettings', {}, signal)
  assert.equal(
    stored.ok && (stored.value as { ceilingUSD?: number }).ceilingUSD,
    2500,
  )
  // An explicit null is the only way to clear it.
  assert.equal(
    (await handler('cursorSetCeiling', { ceilingUSD: null }, signal)).ok,
    true,
  )
  const cleared = await handler('cursorSettings', {}, signal)
  assert.equal(
    cleared.ok && (cleared.value as { ceilingUSD?: number }).ceilingUSD,
    undefined,
  )
})

test('the Cursor model manager reads rows and validates its writes', async () => {
  // The Cursor route registers only when credentials exist; the handler needs
  // the retained registration handle to observe the picker notification.
  const handler = await mount(undefined, { resolve: async () => undefined })
  const signal = new AbortController().signal
  const models = await handler('cursorModels', {}, signal)
  assert.equal(models.ok, true)
  if (models.ok) {
    const value = models.value as {
      provider: string
      models: unknown[]
      knownContext: { enabled: boolean }
    }
    assert.equal(value.provider, 'cursor')
    assert.deepEqual(value.models, [])
    assert.equal(value.knownContext.enabled, true)
  }
  // The force flag is a boolean when present.
  const malformed = await handler('cursorModels', { force: 'yes' }, signal)
  assert.equal(malformed.ok, false)
  if (!malformed.ok) assert.equal(malformed.error.code, 'bad-request')
  // A settings write needs an object.
  for (const payload of [
    null,
    {},
    { settings: null },
    { settings: [] },
    { settings: 'x' },
  ]) {
    const result = await handler('cursorSetSettings', payload, signal)
    assert.equal(result.ok, false, JSON.stringify(payload))
  }
  const saved = await handler(
    'cursorSetSettings',
    {
      settings: {
        publishedContext: false,
        models: { 'composer-2': { contextWindow: 200_000 } },
      },
    },
    signal,
  )
  assert.equal(saved.ok, true)
  const after = await handler('cursorSettings', {}, signal)
  assert.equal(
    after.ok && (after.value as { publishedContext: boolean }).publishedContext,
    false,
  )
  // Refreshing with a disabled source reports why it did not run.
  const status = await handler('cursorRefreshContext', {}, signal)
  assert.equal(status.ok, true)
  if (status.ok) {
    const value = status.value as {
      enabled: boolean
      status: string
      reason?: string
    }
    assert.equal(value.enabled, false)
    assert.equal(value.status, 'unavailable')
    assert.equal(value.reason, 'disabled')
  }
  const replaces = (handler as unknown as { replacedRoutes: string[][] })
    .replacedRoutes
  const beforeInvalid = replaces.length
  // An invalid field is a bad request that names the field, not an internal error.
  const invalid = await handler(
    'cursorSetSettings',
    { settings: { models: { m: { contextWindow: -1 } } } },
    signal,
  )
  assert.equal(invalid.ok, false)
  assert.equal(replaces.length, beforeInvalid, 'a refused save is silent')
  // A successful save re-announces the route so a loaded picker re-lists.
  const beforeSave = replaces.length
  const savedModels = await handler(
    'cursorSetSettings',
    { settings: { models: { 'claude-sonnet-5-5': { enabled: false } } } },
    signal,
  )
  assert.equal(savedModels.ok, true)
  assert.ok(
    replaces.length > beforeSave && replaces.at(-1)?.includes('cursor'),
    'the Cursor route was re-announced after this save',
  )
  if (!invalid.ok) {
    assert.equal(invalid.error.code, 'bad-request')
    assert.match(invalid.error.message, /contextWindow/)
  }
})
test('the key credential endpoint states the origin without a value or a preview the host lacks', async () => {
  const handler = await mount(undefined, {
    resolve: async () => undefined,
    describe: async () => ({ configured: true, source: 'env', writable: true }),
  })
  const signal = new AbortController().signal
  const result = await handler('keyCredential', { route: 'cursor' }, signal)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, {
    route: 'cursor',
    keyRef: 'CURSOR_API_KEY',
    configured: true,
    source: 'env',
    writable: true,
  })
})

test('a key save stores under the route reference, returns the stored view, and refreshes the route', async () => {
  const written: { ref: string; value: string }[] = []
  const stored: { value: string | undefined } = { value: undefined }
  const handler = await mount(undefined, {
    resolve: async () => undefined,
    async describe() {
      return stored.value === undefined
        ? { configured: false, writable: true }
        : {
            configured: true,
            source: 'file',
            writable: true,
            masked: 'oll...',
          }
    },
    async set(ref, value) {
      written.push({ ref, value })
      stored.value = value
    },
    async unset(ref) {
      written.push({ ref, value: '' })
      stored.value = undefined
    },
  })
  const signal = new AbortController().signal
  const saved = await handler(
    'keySetCredential',
    { route: 'ollama-cloud', value: '  ollama-key  ' },
    signal,
  )
  assert.equal(saved.ok, true)
  assert.deepEqual(written, [{ ref: 'OLLAMA_API_KEY', value: 'ollama-key' }])
  if (saved.ok) {
    const result = saved.value as {
      committed: boolean
      view?: { keyRef: string; source?: string }
    }
    assert.equal(result.committed, true)
    assert.equal(result.view?.keyRef, 'OLLAMA_API_KEY')
    assert.equal(result.view?.source, 'file')
  }

  // A Cursor save re-announces its route so the picker re-lists against the
  // new key; the Ollama save above has no models to re-list.
  const replaces = (handler as unknown as { replacedRoutes: string[][] })
    .replacedRoutes
  const before = replaces.length
  const cursorSaved = await handler(
    'keySetCredential',
    { route: 'cursor', value: 'cursor-key' },
    signal,
  )
  assert.equal(cursorSaved.ok, true)
  assert.ok(
    replaces.length > before && replaces.at(-1)?.includes('cursor'),
    'the Cursor route was re-announced after the key save',
  )

  const cleared = await handler(
    'keyClearCredential',
    { route: 'cursor' },
    signal,
  )
  assert.equal(cleared.ok, true)
  assert.equal(
    written.some(
      (entry) => entry.ref === 'CURSOR_API_KEY' && entry.value === '',
    ),
    true,
  )
  if (cleared.ok) {
    const result = cleared.value as {
      committed: boolean
      view?: { configured: boolean }
    }
    assert.equal(result.committed, true)
    assert.equal(result.view?.configured, false)
  }
})

test('the key credential endpoints refuse an unknown route, a blank value, and a host without the seam', async () => {
  const handler = await mount(undefined, {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
    unset: async () => {},
  })
  const signal = new AbortController().signal
  for (const route of ['claude', 'codex', undefined, 42]) {
    const result = await handler('keyCredential', { route }, signal)
    assert.equal(result.ok, false, String(route))
    if (!result.ok) assert.equal(result.error.code, 'bad-request')
  }
  const blank = await handler(
    'keySetCredential',
    { route: 'cursor', value: '   ' },
    signal,
  )
  assert.equal(blank.ok, false)
  if (!blank.ok) assert.equal(blank.error.code, 'bad-request')

  // A profile that mounts no credential provider answers a refusal naming what
  // is missing instead of crashing the endpoint.
  const unsupported = await mount()
  const refused = await unsupported(
    'keyCredential',
    { route: 'cursor' },
    signal,
  )
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.error.message, /credential provider/)
})
test('every endpoint in the channel table is registered and answers', async () => {
  // A handler map entry with no mounted route would surface here as the fake
  // connection's "no route registered" rejection rather than at the browser.
  const handler = await mount()
  const signal = new AbortController().signal
  // The Ollama listing would reach the provider with a valid address; a
  // malformed one is refused by the payload rules before any request.
  const payloads: Partial<Record<string, unknown>> = {
    ollamaModels: { baseURL: 'not-a-url' },
  }
  for (const endpoint of SUBSCRIPTIONS_AUTH_ENDPOINTS) {
    const result = await handler(endpoint, payloads[endpoint] ?? {}, signal)
    assert.equal(
      typeof (result as { ok?: unknown }).ok,
      'boolean',
      `${endpoint} answered an RPC result`,
    )
  }
})

test('the Ollama connection setting cannot aim credential CRUD at another reference', async () => {
  // Ollama Cloud's reference is editable from its card. If a card-editable name
  // were accepted as the CRUD target, this endpoint set would let the browser
  // overwrite or remove any credential the host knows.
  const seen: string[] = []
  const handler = await mount(undefined, {
    resolve: async () => undefined,
    describe: async (ref) => {
      seen.push(String(ref))
      return { configured: true, writable: true, source: 'file', masked: 'x…' }
    },
    set: async (ref) => {
      seen.push(String(ref))
    },
    unset: async (ref) => {
      seen.push(String(ref))
    },
  })
  const signal = new AbortController().signal
  const moved = await handler(
    'ollamaSetSettings',
    { settings: { apiKeyRef: 'DEEPSEEK_API_KEY' } },
    signal,
  )
  assert.equal(moved.ok, true, 'the reference itself is still a card setting')
  // The effective reference now comes from the browser-editable store, so the
  // credential surface refuses every operation instead of following it.
  for (const endpoint of ['keyCredential', 'keyClearCredential'] as const) {
    const refused = await handler(endpoint, { route: 'ollama-cloud' }, signal)
    assert.equal(refused.ok, false, endpoint)
    if (!refused.ok) {
      assert.equal(refused.error.code, 'internal')
      assert.match(refused.error.message, /this card can rename/)
    }
  }
  const refusedWrite = await handler(
    'keySetCredential',
    { route: 'ollama-cloud', value: 'attacker' },
    signal,
  )
  assert.equal(refusedWrite.ok, false)
  assert.deepEqual(seen, [], 'no reference was read or written')
})

test('the legacy endpoint diagnostics are preserved by the endpoint split', async () => {
  const handler = await mount(undefined, { resolve: async () => undefined })
  const signal = new AbortController().signal
  // A source field that is missing or blank keeps the shared reader's message;
  // an unknown source names the accepted set.
  const blank = await handler('externalUsage', {}, signal)
  assert.equal(blank.ok, false)
  if (!blank.ok) {
    assert.equal(blank.error.code, 'bad-request')
    assert.match(blank.error.message, /payload.source must be a non-empty/)
  }
  const unknown = await handler(
    'externalUsage',
    { source: 'not-a-source' },
    signal,
  )
  assert.equal(unknown.ok, false)
  if (!unknown.ok) {
    assert.equal(unknown.error.code, 'bad-request')
    assert.match(unknown.error.message, /payload.source must be one of/)
  }
  // A non-object payload reaches the reader's own TypeError, which the channel
  // reports as an internal failure — the diagnostics the endpoint always had.
  const notObject = await handler('externalUsage', null, signal)
  assert.equal(notObject.ok, false)
  if (!notObject.ok) assert.equal(notObject.error.code, 'internal')
  // The Ollama settings endpoint refuses a non-object payload itself and leaves
  // the settings validator to name a bad document.
  const nullSettings = await handler('ollamaSetSettings', null, signal)
  assert.equal(nullSettings.ok, false)
  if (!nullSettings.ok) {
    assert.equal(nullSettings.error.code, 'bad-request')
    assert.match(nullSettings.error.message, /payload must be an object/)
  }
  const badDocument = await handler('ollamaSetSettings', {}, signal)
  assert.equal(badDocument.ok, false)
  if (!badDocument.ok) {
    assert.equal(badDocument.error.code, 'bad-request')
    assert.match(badDocument.error.message, /Ollama settings must be an object/)
  }
})

test('the saved key reaches the Ollama provider read, and a foreign destination gets no stored key', async () => {
  // A layered, per-reference seam: the file layer is what a save writes, and a
  // local HTTP server stands in for the provider so the assertion is about the
  // request the plugin actually sent, not about the fake it called.
  const received: { path: string; authorization: string | undefined }[] = []
  const server = createServer((request, response) => {
    received.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
    })
    response.setHeader('content-type', 'application/json')
    if (request.url?.startsWith('/tags')) {
      response.end(JSON.stringify({ models: [{ model: 'glm-5.3:cloud' }] }))
      return
    }
    // /show enrichment is optional; an empty object is enough.
    response.end(JSON.stringify({}))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const baseURL = `http://127.0.0.1:${address.port}`
  try {
    const files = new Map<string, string>()
    const env = new Map([['OLLAMA_TEST_KEY', 'environment-key']])
    const seam = {
      async describe(ref: string) {
        if (files.has(ref))
          return {
            configured: true,
            writable: true,
            source: 'file',
            masked: 'env…',
          }
        if (env.has(ref))
          return { configured: true, writable: true, source: 'env' }
        return { configured: false, writable: true }
      },
      async set(ref: string, value: string) {
        files.set(ref, value)
      },
      async unset(ref: string) {
        files.delete(ref)
      },
      resolve: async (ref: string) => {
        const value = files.get(ref) ?? env.get(ref)
        return value === undefined ? undefined : { value, source: 'file' }
      },
    }
    const handler = await mount(undefined, seam, {
      ollama: { apiKeyRef: 'OLLAMA_TEST_KEY', baseURL },
    })
    const signal = new AbortController().signal
    // The settings file is shared across this spec; clear it so the route reads
    // the operator reference this case configured.
    const reset = await handler('ollamaSetSettings', { settings: {} }, signal)
    assert.equal(reset.ok, true)
    const saved = await handler(
      'keySetCredential',
      { route: 'ollama-cloud', value: 'saved-key' },
      signal,
    )
    assert.equal(saved.ok, true)
    received.length = 0
    const listed = await handler('ollamaModels', {}, signal)
    assert.ok(listed.ok, JSON.stringify(listed))
    assert.ok(
      received.length > 0 &&
        received.some((entry) => entry.path.startsWith('/tags')),
      'the provider listing was requested',
    )
    assert.equal(
      received[0]?.authorization,
      'Bearer saved-key',
      'the provider received the saved key',
    )

    // A destination other than the configured one gets no stored credential;
    // the request never leaves the machine because it is refused before it.
    const foreign = await handler(
      'ollamaModels',
      { baseURL: 'https://not-configured.example' },
      signal,
    )
    assert.equal(foreign.ok, false)
    if (!foreign.ok) {
      assert.equal(foreign.error.code, 'bad-request')
      assert.match(foreign.error.message, /enter the API key/)
    }
    // The typed one-time key is still allowed there.
    const typedForeign = await handler(
      'ollamaModels',
      { baseURL: baseURL, apiKey: 'one-time-key' },
      signal,
    )
    assert.equal(typedForeign.ok, true)
    assert.equal(received.at(-1)?.authorization, 'Bearer one-time-key')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  }
})

test('a settings view omits a reference that is not a reference name', async () => {
  // A name that is not a POSIX identifier may be a value someone pasted; it is
  // never printed back by a settings read.
  const handler = await mount(
    undefined,
    { resolve: async () => undefined },
    {
      cursor: { apiKeyRef: 'sk-pasted-secret-0123456789' },
    },
  )
  const signal = new AbortController().signal
  const settings = await handler('cursorSettings', {}, signal)
  assert.equal(settings.ok, true)
  if (settings.ok) {
    const value = settings.value as { keyRef: string }
    assert.equal(value.keyRef, '')
    assert.ok(!JSON.stringify(settings).includes('sk-pasted-secret'))
  }
})

test('a committed credential carries a generation that a changed one supersedes', async () => {
  const files = new Map<string, string>()
  const seam = {
    async describe(ref: string) {
      return files.has(ref)
        ? { configured: true, writable: true, source: 'file', masked: 'x…' }
        : { configured: false, writable: true }
    },
    async set(ref: string, value: string) {
      files.set(ref, value)
    },
    async unset(ref: string) {
      files.delete(ref)
    },
    resolve: async (ref: string) => {
      const value = files.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
  }
  const handler = await mount(undefined, seam, {
    ollama: { apiKeyRef: 'OLLAMA_TEST_KEY', baseURL: 'http://127.0.0.1:9' },
  })
  const signal = new AbortController().signal
  const reset = await handler('ollamaSetSettings', { settings: {} }, signal)
  assert.equal(reset.ok, true)
  const first = await handler(
    'keySetCredential',
    { route: 'ollama-cloud', value: 'first-key' },
    signal,
  )
  assert.ok(first.ok)
  const firstGeneration = (first.value as { generation: number }).generation
  assert.equal(typeof firstGeneration, 'number')
  // Another writer replaces the key.
  const second = await handler(
    'keySetCredential',
    { route: 'ollama-cloud', value: 'second-key' },
    signal,
  )
  assert.ok(second.ok)
  const secondGeneration = (second.value as { generation: number }).generation
  assert.notEqual(secondGeneration, firstGeneration)

  // The earlier generation can no longer answer for the stored credential, and
  // it is a distinct outcome, not a failure.
  const stale = await handler(
    'keyValidateCredential',
    { route: 'ollama-cloud', generation: firstGeneration },
    signal,
  )
  assert.ok(stale.ok)
  assert.equal((stale.value as { outcome: string }).outcome, 'superseded')
})

test('the listing keeps the destination refusal apart from a missing key', async () => {
  const handler = await mount(
    undefined,
    {
      resolve: async () => undefined,
      describe: async () => ({ configured: false, writable: true }),
      set: async () => {},
      unset: async () => {},
    },
    { ollama: { apiKeyRef: 'OLLAMA_TEST_KEY' } },
  )
  const signal = new AbortController().signal
  const reset = await handler('ollamaSetSettings', { settings: {} }, signal)
  assert.equal(reset.ok, true)
  const configured = await handler('ollamaModels', {}, signal)
  assert.equal(configured.ok, false)
  if (!configured.ok) {
    assert.equal(configured.error.code, 'bad-request')
    assert.match(configured.error.message, /no Ollama API key is configured/)
  }
  const foreign = await handler(
    'ollamaModels',
    { baseURL: 'https://not-configured.example' },
    signal,
  )
  assert.equal(foreign.ok, false)
  if (!foreign.ok) {
    assert.equal(foreign.error.code, 'bad-request')
    assert.match(foreign.error.message, /enter the API key/)
  }
})

test('a listing failure is reported without the provider text it came from', async () => {
  const marker = 'sk-synthetic-provider-marker'
  const server = createServer((_request, response) => {
    response.statusCode = 500
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ error: marker }))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const baseURL = `http://127.0.0.1:${address.port}`
  try {
    const handler = await mount(
      undefined,
      {
        resolve: async () => ({ value: 'stored-key', source: 'file' }),
        describe: async () => ({ configured: true, writable: true }),
        set: async () => {},
        unset: async () => {},
      },
      { ollama: { apiKeyRef: 'OLLAMA_TEST_KEY', baseURL } },
    )
    const signal = new AbortController().signal
    const reset = await handler('ollamaSetSettings', { settings: {} }, signal)
    assert.equal(reset.ok, true)
    const listed = await handler('ollamaModels', {}, signal)
    assert.equal(listed.ok, false)
    if (!listed.ok) {
      assert.equal(listed.error.code, 'internal')
      assert.match(
        listed.error.message,
        /the Ollama endpoint could not be read/,
      )
      assert.ok(!JSON.stringify(listed).includes(marker))
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  }
})

test('a value with control characters is refused before it reaches a header', async () => {
  const handler = await mount(undefined, {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
    unset: async () => {},
  })
  const signal = new AbortController().signal
  const saved = await handler(
    'keySetCredential',
    { route: 'cursor', value: 'a\r\nInjected: header' },
    signal,
  )
  assert.equal(saved.ok, false)
  if (!saved.ok) {
    assert.equal(saved.error.code, 'bad-request')
    assert.match(saved.error.message, /control characters/)
  }
  const listed = await handler(
    'ollamaModels',
    { apiKey: 'line\nbreak' },
    signal,
  )
  assert.equal(listed.ok, false)
  if (!listed.ok) {
    assert.equal(listed.error.code, 'bad-request')
    assert.match(listed.error.message, /control characters/)
  }
})

test('a card-chosen address stops the stored key from being spent anywhere', async () => {
  // The policy covers the paths the card does not drive directly: usage status,
  // the usage read, discovery, and web. The address setting is browser-editable,
  // so changing it must not turn the stored key into a travel permit.
  const handler = await mount(
    undefined,
    {
      resolve: async (ref) =>
        ref === 'OLLAMA_TEST_KEY'
          ? { value: 'stored-key', source: 'file' as const }
          : undefined,
      describe: async () => ({ configured: true, writable: true }),
      set: async () => {},
      unset: async () => {},
    },
    { ollama: { apiKeyRef: 'OLLAMA_TEST_KEY' } },
  )
  const signal = new AbortController().signal
  const reset = await handler('ollamaSetSettings', { settings: {} }, signal)
  assert.ok(reset.ok, JSON.stringify(reset))
  const configured = await handler('externalStatus', {}, signal)
  assert.ok(configured.ok)
  if (configured.ok) {
    const status = configured.value as Record<string, { configured: boolean }>
    assert.equal(
      status['ollama-cloud']?.configured,
      true,
      JSON.stringify(configured),
    )
  }

  // The card replaces the operator address with one of its own.
  const moved = await handler(
    'ollamaSetSettings',
    { settings: { baseURL: 'https://elsewhere.example' } },
    signal,
  )
  assert.equal(moved.ok, true)
  const view = await handler('ollamaSettings', {}, signal)
  assert.ok(view.ok)
  if (view.ok) {
    assert.equal((view.value as { keyUsable: boolean }).keyUsable, false)
  }
  const status = await handler('externalStatus', {}, signal)
  assert.ok(status.ok)
  if (status.ok) {
    const entries = status.value as Record<string, { configured: boolean }>
    assert.equal(entries['ollama-cloud']?.configured, false)
  }
  const usage = await handler(
    'externalUsage',
    { source: 'ollama-cloud' },
    signal,
  )
  assert.equal(usage.ok, false)
  if (!usage.ok) assert.match(usage.error.message, /not configured/)

  // Putting the operator address back restores the credential for every path.
  const restored = await handler('ollamaSetSettings', { settings: {} }, signal)
  assert.equal(restored.ok, true)
  const again = await handler('externalStatus', {}, signal)
  assert.ok(again.ok)
  if (again.ok) {
    const entries = again.value as Record<string, { configured: boolean }>
    assert.equal(entries['ollama-cloud']?.configured, true)
  }
})

test('a change that lands during the validation read supersedes its verdict', async () => {
  // The route's read runs on the host and is bound to the generation it was
  // asked about. A save that lands while that read is in flight owns the
  // credential, so the answer must be superseded rather than a pass for a key
  // this writer no longer holds.
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrived: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/tags')) {
      arrived?.()
      await gate
    }
    response.setHeader('content-type', 'application/json')
    if (request.url?.startsWith('/tags')) {
      response.end(JSON.stringify({ models: [{ model: 'glm-5.3:cloud' }] }))
      return
    }
    response.end(JSON.stringify({}))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const baseURL = `http://127.0.0.1:${address.port}`
  try {
    const files = new Map<string, string>()
    const seam = {
      async describe(ref: string) {
        return files.has(ref)
          ? { configured: true, writable: true, source: 'file', masked: 'x…' }
          : { configured: false, writable: true }
      },
      async set(ref: string, value: string) {
        files.set(ref, value)
      },
      async unset(ref: string) {
        files.delete(ref)
      },
      resolve: async (ref: string) => {
        const value = files.get(ref)
        return value === undefined ? undefined : { value, source: 'file' }
      },
    }
    const handler = await mount(undefined, seam, {
      ollama: { apiKeyRef: 'OLLAMA_TEST_KEY', baseURL },
    })
    const signal = new AbortController().signal
    const reset = await handler('ollamaSetSettings', { settings: {} }, signal)
    assert.equal(reset.ok, true)
    const first = await handler(
      'keySetCredential',
      { route: 'ollama-cloud', value: 'first-key' },
      signal,
    )
    assert.ok(first.ok)
    const generation = (first.value as { generation: number }).generation
    const validation = handler(
      'keyValidateCredential',
      { route: 'ollama-cloud', generation },
      signal,
    )
    // The read is in flight; a second save commits the same value, so only the
    // generation says which write this verdict belongs to.
    await started
    const replaced = await handler(
      'keySetCredential',
      { route: 'ollama-cloud', value: 'first-key' },
      signal,
    )
    assert.ok(replaced.ok)
    release?.()
    const answer = await validation
    assert.ok(answer.ok)
    assert.equal((answer.value as { outcome: string }).outcome, 'superseded')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  }
})

test('a usage read refuses a stored key that cannot ride a header', async () => {
  // A value stored before the card existed can carry a control character. The
  // transport error for such a header quotes it, so the read must refuse before
  // building one, and the reply must not carry the value.
  const marker = 'sk-control-marker'
  const requests: string[] = []
  const handler = await mount(
    undefined,
    {
      resolve: async (ref) =>
        ref === 'OLLAMA_TEST_KEY'
          ? { value: `${marker}\r\nX-Injected: 1`, source: 'file' as const }
          : undefined,
      describe: async () => ({ configured: true, writable: true }),
      set: async () => {},
      unset: async () => {},
    },
    { ollama: { apiKeyRef: 'OLLAMA_TEST_KEY' } },
  )
  const signal = new AbortController().signal
  const reset = await handler('ollamaSetSettings', { settings: {} }, signal)
  assert.equal(reset.ok, true)
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    return Response.json({})
  }) as typeof fetch
  try {
    const usage = await handler(
      'externalUsage',
      { source: 'ollama-cloud' },
      signal,
    )
    assert.equal(usage.ok, false)
    if (!usage.ok) {
      assert.match(usage.error.message, /carries control characters/)
      assert.ok(!JSON.stringify(usage).includes(marker))
    }
    assert.deepEqual(requests, [] as string[], 'no request was attempted')
  } finally {
    globalThis.fetch = previous
  }
})

test('a reference changed in Settings between save and validation supersedes it', async () => {
  // The connection settings can move the reference without writing a credential,
  // so the commit counter alone would let the validation authenticate another
  // key at the same address. The committed identity is what is validated.
  const files = new Map<string, string>()
  const seam = {
    async describe(ref: string) {
      return files.has(ref)
        ? { configured: true, writable: true, source: 'file', masked: 'x…' }
        : { configured: false, writable: true }
    },
    async set(ref: string, value: string) {
      files.set(ref, value)
    },
    async unset(ref: string) {
      files.delete(ref)
    },
    resolve: async (ref: string) => {
      const value = files.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
  }
  const handler = await mount(undefined, seam, {
    ollama: { apiKeyRef: 'OLLAMA_TEST_KEY', baseURL: 'http://127.0.0.1:9' },
  })
  const signal = new AbortController().signal
  const reset = await handler('ollamaSetSettings', { settings: {} }, signal)
  assert.ok(reset.ok)
  const saved = await handler(
    'keySetCredential',
    { route: 'ollama-cloud', value: 'first-key' },
    signal,
  )
  assert.ok(saved.ok)
  const generation = (saved.value as { generation: number }).generation
  const moved = await handler(
    'ollamaSetSettings',
    { settings: { apiKeyRef: 'CUSTOM_OLLAMA_KEY' } },
    signal,
  )
  assert.ok(moved.ok)
  const answer = await handler(
    'keyValidateCredential',
    { route: 'ollama-cloud', generation },
    signal,
  )
  assert.ok(answer.ok)
  assert.equal((answer.value as { outcome: string }).outcome, 'superseded')
})
