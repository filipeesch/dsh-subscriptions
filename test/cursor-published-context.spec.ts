import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  MODELS_DEV_URL,
  PublishedContext,
  hasPublishedCatalogShape,
  lastSegment,
  mostDeclared,
  normalizeModelKey,
  projectWindows,
  publishedEntries,
  vendorOf,
} from '../src/providers/cursor/published-context.js'
import {
  loadPublishedContext,
  parsePublishedContextSnapshot,
  savePublishedContext,
} from '../src/providers/cursor/published-context-store.js'
import type { PublishedModel } from '../src/providers/cursor/published-context.js'

const published = {
  anthropic: {
    models: {
      'claude-sonnet-5-5': {
        id: 'claude-sonnet-5-5',
        name: 'Claude Sonnet 5.5',
        limit: { context: 1_000_000 },
      },
    },
  },
  deepseek: {
    models: {
      'deepseek/deepseek-v41-flash-1017': {
        id: 'deepseek/deepseek-v41-flash-1017',
        name: 'DeepSeek V4.1 Flash',
        limit: { context: 1_048_576 },
      },
    },
  },
  gateway: {
    models: {
      'deepseek-v41-flash-1017': {
        id: 'deepseek-v41-flash-1017',
        limit: { context: 200_000 },
      },
    },
  },
  nodescribed: { models: { bare: { id: 'bare', name: 'Bare' } } },
}

function entriesOf(): PublishedModel[] {
  return publishedEntries(published)
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** A service with a loaded projection for one deepseek id. */
function seededService(overrides = {}) {
  const service = new PublishedContext({
    enabled: () => true,
    // A fresh snapshot and a same-window clock: notes never fetch here.
    freshMs: 60_000,
    now: () => 1_000,
    fetch: async () => jsonResponse(published),
    ...overrides,
  })
  service.load({
    version: 2,
    fetchedAt: 950,
    windows: { 'deepseek-v41-flash-1017': 1_048_576 },
  })
  return service
}

test('ids normalize and resolve their vendor', () => {
  assert.equal(normalizeModelKey('DeepSeek V4.1 Flash'), 'deepseekv41flash')
  assert.equal(
    lastSegment('deepseek/deepseek-v41-flash-1017'),
    'deepseek-v41-flash-1017',
  )
  assert.equal(lastSegment('claude'), 'claude')
  assert.equal(vendorOf('claude-opus-5-5'), 'anthropic')
  assert.equal(vendorOf('gpt-5.6-sol'), 'openai')
  assert.equal(vendorOf('deepseek-v41-flash-1017'), 'deepseek')
  assert.equal(vendorOf('composer-2.5'), undefined)
})

test('published entries keep only models that declare a capacity', () => {
  const entries = entriesOf()
  assert.equal(entries.length, 3)
  assert.equal(
    entries.find((entry) => entry.id === 'deepseek-v41-flash-1017')?.context,
    200_000,
  )
  assert.deepEqual(publishedEntries('not a document'), [])
  assert.deepEqual(publishedEntries([1, 2]), [])
  assert.deepEqual(publishedEntries({ p: { models: [] } }), [])
})

test('projection prefers the vendor entry and the most declared value', () => {
  assert.deepEqual(projectWindows(['deepseek-v41-flash-1017'], entriesOf()), {
    'deepseek-v41-flash-1017': 1_048_576,
  })
  const gatewayOnly = entriesOf().filter(
    (entry) => entry.provider === 'gateway',
  )
  assert.deepEqual(projectWindows(['deepseek-v41-flash-1017'], gatewayOnly), {
    'deepseek-v41-flash-1017': 200_000,
  })
  assert.deepEqual(projectWindows(['claude-sonnet-5-5'], entriesOf()), {
    'claude-sonnet-5-5': 1_000_000,
  })
  assert.deepEqual(projectWindows(['composer-2'], entriesOf()), {})
  assert.deepEqual(projectWindows(['Claude Sonnet 5.5'], entriesOf()), {
    'Claude Sonnet 5.5': 1_000_000,
  })
})

test('a gateway whose name merely contains a vendor is not the vendor', () => {
  const entries = publishedEntries({
    'deepseek-mirror': {
      models: {
        'deepseek-v41-flash-1017': {
          id: 'deepseek-v41-flash-1017',
          limit: { context: 200_000 },
        },
      },
    },
    deepseek: {
      models: {
        'deepseek-v41-flash-1017': {
          id: 'deepseek-v41-flash-1017',
          limit: { context: 1_048_576 },
        },
      },
    },
  })
  // Exact provider identity takes the vendor's value, not the mirror's.
  assert.deepEqual(projectWindows(['deepseek-v41-flash-1017'], entries), {
    'deepseek-v41-flash-1017': 1_048_576,
  })
})

test('disagreement resolves by most declared, then the larger value', () => {
  assert.equal(mostDeclared([300, 300, 400]), 300)
  assert.equal(mostDeclared([300, 400]), 400)
  assert.equal(mostDeclared([]), undefined)
})

test('the document shape check separates malformed input from an empty projection', () => {
  assert.equal(hasPublishedCatalogShape(published), true)
  assert.equal(hasPublishedCatalogShape({}), false)
  // A provider that is not an object is a broken response.
  assert.equal(hasPublishedCatalogShape({ invalid: true }), false)
  // A provider whose models entry is an array is not the catalog shape.
  assert.equal(hasPublishedCatalogShape({ p: { models: [] } }), false)
  assert.equal(hasPublishedCatalogShape({ p: {} }), false)
  assert.equal(hasPublishedCatalogShape([]), false)
  assert.equal(hasPublishedCatalogShape(null), false)
  assert.equal(hasPublishedCatalogShape('not a document'), false)
  // Whether an entry carries a capacity is the projection's business: the
  // endpoint lists image, speech, and transcription models with no window, and
  // one of those must not hide the readable entries.
  assert.equal(
    hasPublishedCatalogShape({
      p: { models: { x: { limit: { context: 0 } } } },
    }),
    true,
  )
  assert.equal(hasPublishedCatalogShape({ p: { models: { x: null } } }), true)
  assert.equal(
    hasPublishedCatalogShape({ p: { models: { x: { id: 'x' } } } }),
    true,
  )
})

test('the service reads a persisted projection and reports staleness', () => {
  let now = 1_000
  const service = new PublishedContext({
    enabled: () => true,
    now: () => now,
    freshMs: 100,
  })
  service.load({
    version: 2,
    fetchedAt: 950,
    windows: { 'deepseek-v41-flash-1017': 1_048_576 },
  })
  // Until the catalog lists the id there is nothing to serve.
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), undefined)
  service.note(['deepseek-v41-flash-1017'])
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), 1_048_576)
  assert.equal(service.fetchedAt(), 950)
  assert.equal(service.stale(), false)
  now = 1_050
  assert.equal(service.stale(), true)
  // A snapshot from another rules version is discarded.
  service.load({ version: 1, fetchedAt: now, windows: {} })
  assert.equal(service.fetchedAt(), 950)
})

test('a disabled source serves no capacity even with a snapshot', () => {
  let enabled = true
  const service = seededService({ enabled: () => enabled })
  service.note(['deepseek-v41-flash-1017'])
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), 1_048_576)
  enabled = false
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), undefined)
  enabled = true
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), 1_048_576)
})

test('a withdrawn id stops being served immediately', () => {
  const service = seededService()
  service.load({
    version: 2,
    fetchedAt: 950,
    windows: {
      'deepseek-v41-flash-1017': 1_048_576,
      'claude-sonnet-5-5': 1_000_000,
    },
  })
  service.note(['deepseek-v41-flash-1017', 'claude-sonnet-5-5'])
  service.note(['deepseek-v41-flash-1017'])
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), 1_048_576)
  assert.equal(service.windowFor('claude-sonnet-5-5'), undefined)
})

test('a refresh projects the listed ids and persists the snapshot', async () => {
  const now = 5_000
  let fetched = 0
  const persisted: unknown[] = []
  const service = new PublishedContext({
    enabled: () => true,
    now: () => now,
    fetch: async (url) => {
      fetched += 1
      assert.equal(String(url), MODELS_DEV_URL)
      return jsonResponse(published)
    },
    persist: (snapshot) => {
      persisted.push(snapshot)
    },
  })
  const outcome = await service.refresh([
    'deepseek-v41-flash-1017',
    'composer-2',
  ])
  assert.deepEqual(outcome, {
    status: 'refreshed',
    fetchedAt: 5_000,
    windows: 1,
  })
  assert.equal(fetched, 1)
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), 1_048_576)
  assert.equal(service.windowFor('composer-2'), undefined)
  assert.equal(persisted.length, 1)
  await Promise.all([
    service.refresh(['deepseek-v41-flash-1017']),
    service.refresh(['deepseek-v41-flash-1017']),
  ])
  assert.equal(fetched, 2)
})

test('a refresh projects the newest id set after the fetch completes', async () => {
  let release: (value: Response) => void = () => undefined
  const service = new PublishedContext({
    enabled: () => true,
    fetch: () =>
      new Promise<Response>((resolve) => {
        release = resolve
      }),
  })
  const pending = service.refresh(['deepseek-v41-flash-1017'])
  // The catalog changes while the request is in flight.
  service.note(['claude-sonnet-5-5'])
  release(jsonResponse(published))
  const outcome = await pending
  assert.equal(outcome.status, 'refreshed')
  assert.equal(service.windowFor('claude-sonnet-5-5'), 1_000_000)
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), undefined)
})

test('a disabled source and an empty id list report why nothing was fetched', async () => {
  let fetched = 0
  const disabled = new PublishedContext({
    enabled: () => false,
    fetch: async () => {
      fetched += 1
      return jsonResponse(published)
    },
  })
  assert.deepEqual(await disabled.refresh(['x']), {
    status: 'unavailable',
    reason: 'disabled',
  })
  const enabled = new PublishedContext({
    enabled: () => true,
    fetch: async () => {
      fetched += 1
      return jsonResponse(published)
    },
  })
  assert.deepEqual(await enabled.refresh([]), {
    status: 'unavailable',
    reason: 'no-models',
  })
  assert.equal(fetched, 0)
})

test('a failed refresh keeps the previous projection and reports it', async () => {
  const service = seededService({
    fetch: async () => {
      throw new Error('offline')
    },
  })
  const outcome = await service.refresh(['deepseek-v41-flash-1017'])
  assert.equal(outcome.status, 'failed')
  if (outcome.status === 'failed') {
    assert.match(outcome.reason, /offline/)
    assert.equal(outcome.fetchedAt, 950)
  }
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), 1_048_576)
})

test('a malformed success keeps the previous projection and its timestamp', async () => {
  const service = seededService({
    now: () => 9_000,
    fetch: async () => jsonResponse({ invalid: true }),
  })
  const outcome = await service.refresh(['deepseek-v41-flash-1017'])
  assert.equal(outcome.status, 'failed')
  assert.equal(service.fetchedAt(), 950)
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), 1_048_576)
})

test('a timeout and an oversized body fail without throwing', async () => {
  const warnings: string[] = []
  const timedOut = new PublishedContext({
    enabled: () => true,
    timeoutMs: 5,
    onWarn: (message) => warnings.push(message),
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted by timeout'))
        })
      }),
  })
  assert.equal((await timedOut.refresh(['x'])).status, 'failed')
  assert.match(warnings[0] as string, /aborted by timeout/)

  const oversized = new PublishedContext({
    enabled: () => true,
    maxBytes: 8,
    onWarn: (message) => warnings.push(message),
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('x'.repeat(20)))
            controller.close()
          },
        }),
      ),
  })
  assert.equal((await oversized.refresh(['x'])).status, 'failed')
  assert.match(warnings[1] as string, /size cap/)
})

test('the note path refreshes only when stale, out of band', async () => {
  let fetched = 0
  let now = 10
  const service = new PublishedContext({
    enabled: () => true,
    freshMs: 100,
    now: () => now,
    fetch: async () => {
      fetched += 1
      return jsonResponse(published)
    },
  })
  service.note(['deepseek-v41-flash-1017'])
  await new Promise((resolveWait) => setTimeout(resolveWait, 0))
  assert.equal(fetched, 1)
  service.note(['deepseek-v41-flash-1017'])
  await new Promise((resolveWait) => setTimeout(resolveWait, 0))
  assert.equal(fetched, 1)
  now = 1_000
  service.note(['deepseek-v41-flash-1017'])
  await new Promise((resolveWait) => setTimeout(resolveWait, 0))
  assert.equal(fetched, 2)
})

test('an entry without a capacity does not fail the refresh', async () => {
  // The shape this projection reads from the live endpoint: image, speech, and
  // transcription models declare no context window at all, and a zero window
  // stands beside the readable entries.
  const document = {
    anthropic: published.anthropic,
    openai: {
      models: {
        'gpt-image-2': { id: 'gpt-image-2', limit: { context: 0 } },
        'gpt-transcribe': { id: 'gpt-transcribe' },
      },
    },
  }
  const service = new PublishedContext({
    enabled: () => true,
    now: () => 9_000,
    fetch: async () => jsonResponse(document),
  })
  assert.deepEqual(
    await service.refresh(['claude-sonnet-5-5', 'gpt-image-2']),
    {
      status: 'refreshed',
      fetchedAt: 9_000,
      windows: 1,
    },
  )
  assert.equal(service.windowFor('claude-sonnet-5-5'), 1_000_000)
  assert.equal(service.windowFor('gpt-image-2'), undefined)
})

test('an unreadable entry is skipped rather than fatal', async () => {
  const service = seededService({
    now: () => 9_000,
    fetch: async () =>
      jsonResponse({
        p: { models: { x: null, y: { id: 'y', limit: { context: 300_000 } } } },
      }),
  })
  assert.deepEqual(await service.refresh(['y']), {
    status: 'refreshed',
    fetchedAt: 9_000,
    windows: 1,
  })
  assert.equal(service.windowFor('y'), 300_000)
  assert.equal(service.fetchedAt(), 9_000)
})

test('a valid catalog with no matching capacity replaces the projection', async () => {
  const service = seededService({
    now: () => 9_000,
    fetch: async () => jsonResponse({ p: { models: { x: { id: 'x' } } } }),
  })
  assert.deepEqual(await service.refresh(['deepseek-v41-flash-1017']), {
    status: 'refreshed',
    fetchedAt: 9_000,
    windows: 0,
  })
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), undefined)
})

test('a newly listed id refreshes a fresh snapshot once', async () => {
  let fetched = 0
  const service = new PublishedContext({
    enabled: () => true,
    now: () => 5_000,
    freshMs: 60_000,
    fetch: async () => {
      fetched += 1
      return jsonResponse(published)
    },
  })
  service.load({
    version: 2,
    fetchedAt: 4_999,
    windows: { 'deepseek-v41-flash-1017': 1_048_576 },
    ids: ['deepseek-v41-flash-1017'],
  })
  const settle = () => new Promise((resolveWait) => setTimeout(resolveWait, 0))
  // Covered and fresh: no fetch.
  service.note(['deepseek-v41-flash-1017'])
  await settle()
  assert.equal(fetched, 0)
  // A newly listed id is not covered, so it triggers one refresh.
  service.note(['deepseek-v41-flash-1017', 'claude-sonnet-5-5'])
  await settle()
  assert.equal(fetched, 1)
  assert.equal(service.windowFor('claude-sonnet-5-5'), 1_000_000)
  // An id the catalog describes no capacity for is covered now: no loop.
  service.note(['deepseek-v41-flash-1017', 'claude-sonnet-5-5', 'composer-2'])
  await settle()
  assert.equal(fetched, 2)
  service.note(['deepseek-v41-flash-1017', 'claude-sonnet-5-5', 'composer-2'])
  await settle()
  assert.equal(fetched, 2)
})

test('the projection store round-trips and rejects unusable documents', async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'cursor-context-')),
    'windows.json',
  )
  assert.equal(await loadPublishedContext(path), undefined)
  const snapshot = {
    version: 2,
    fetchedAt: 1_700_000_000_000,
    windows: { 'deepseek-v41-flash-1017': 1_048_576 },
    ids: ['deepseek-v41-flash-1017', 'composer-2'],
  }
  await savePublishedContext(snapshot, path)
  assert.deepEqual(await loadPublishedContext(path), snapshot)
  assert.equal(
    parsePublishedContextSnapshot(snapshot)?.windows['deepseek-v41-flash-1017'],
    1_048_576,
  )

  for (const invalid of [
    { ...snapshot, version: 1 },
    { ...snapshot, fetchedAt: 'now' },
    { ...snapshot, windows: [] },
    { ...snapshot, windows: { model: 0 } },
    { ...snapshot, windows: { model: 1.5 } },
    { ...snapshot, ids: 'x' },
    { ...snapshot, ids: [''] },
    [],
    null,
  ]) {
    assert.equal(parsePublishedContextSnapshot(invalid), undefined)
  }
  writeFileSync(path, '{not json')
  assert.equal(await loadPublishedContext(path), undefined)
})

test('a live refresh outranks a startup seed that lands later', async () => {
  const service = new PublishedContext({
    enabled: () => true,
    fetch: async () => jsonResponse(published),
    now: () => 5_000,
  })
  // The refresh completes first and updates the id set.
  await service.refresh(['deepseek-v41-flash-1017'])
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), 1_048_576)
  // A slow disk read must not replace the fresher projection.
  service.load({
    version: 2,
    fetchedAt: 1,
    windows: { 'deepseek-v41-flash-1017': 500_000 },
    ids: ['deepseek-v41-flash-1017'],
  })
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), 1_048_576)
  assert.equal(service.fetchedAt(), 5_000)
})

test('a seed that lands before the refresh is replaced by it', async () => {
  const service = new PublishedContext({
    enabled: () => true,
    fetch: async () => jsonResponse(published),
    now: () => 5_000,
  })
  service.load({
    version: 2,
    fetchedAt: 1,
    windows: { 'deepseek-v41-flash-1017': 500_000 },
    ids: ['deepseek-v41-flash-1017'],
  })
  service.note(['deepseek-v41-flash-1017'])
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), 500_000)
  await service.refresh(['deepseek-v41-flash-1017'])
  assert.equal(service.windowFor('deepseek-v41-flash-1017'), 1_048_576)
  assert.equal(service.fetchedAt(), 5_000)
})
