/**
 * The key routes' credential surface: what the card is told, what a save and a
 * removal do to the store, and the refusals a misconfigured host or route gets.
 *
 * The seam is a fake, so these cases prove the surface's mapping, its use of the
 * route's operator-controlled reference, and its fixed refusal sentences. What
 * the real provider does with a value (its file format, its environment layers)
 * belongs to that provider's tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KeyCredentialError,
  KeyCredentials,
} from '../src/providers/key-credentials.js'
import type {
  KeyCredentialSeam,
  KeyRouteId,
} from '../src/providers/key-credentials.js'

/** A synthetic secret no refusal may repeat. */
const SECRET = 'sk-marked-value-0123456789'

/**
 * A per-reference store with the seam's layering: the DSH file first, then an
 * environment fallback. A write replaces the file layer; a removal exposes the
 * fallback again, which is what the card must then state.
 */
function fakeSeam(files: Record<string, string>, env: Record<string, string>) {
  const calls: { method: 'describe' | 'set' | 'unset'; ref: string }[] = []
  const seam: KeyCredentialSeam = {
    async describe(ref) {
      calls.push({ method: 'describe', ref })
      if (files[ref] !== undefined)
        return {
          configured: true,
          writable: true,
          source: 'file',
          masked: `${files[ref].slice(0, 3)}…`,
        }
      if (env[ref] !== undefined)
        return { configured: true, writable: true, source: 'env' }
      return { configured: false, writable: true }
    },
    async set(ref, value) {
      calls.push({ method: 'set', ref })
      files[ref] = value
    },
    async unset(ref) {
      calls.push({ method: 'unset', ref })
      delete files[ref]
    },
  }
  return { seam, calls, files, env }
}

function surfaceOf(
  seam: KeyCredentialSeam | undefined,
  refs: Partial<Record<KeyRouteId, string | undefined>> = {
    cursor: 'CURSOR_API_KEY',
    'ollama-cloud': 'OLLAMA_API_KEY',
  },
  onChanged?: (route: KeyRouteId) => void,
) {
  const seen: { route: KeyRouteId; ref: string | undefined }[] = []
  return {
    seen,
    surface: new KeyCredentials({
      editableRefOf: (route) => {
        seen.push({ route, ref: refs[route] })
        return refs[route]
      },
      seam: () => seam,
      ...(onChanged === undefined ? {} : { onChanged }),
    }),
  }
}

test('describe states the stored origin with the host masked preview', async () => {
  const fake = fakeSeam({ CURSOR_API_KEY: SECRET }, {})
  const { surface } = surfaceOf(fake.seam)
  assert.deepEqual(await surface.describe('cursor'), {
    route: 'cursor',
    keyRef: 'CURSOR_API_KEY',
    configured: true,
    source: 'file',
    writable: true,
    masked: 'sk-…',
  })
})

test('describe states the environment origin without a preview', async () => {
  // The oldest supported host reports no masked preview, so the card must be
  // able to say where the value came from without one.
  const fake = fakeSeam({}, { OLLAMA_API_KEY: 'env-value' })
  const { surface } = surfaceOf(fake.seam)
  const view = await surface.describe('ollama-cloud')
  assert.equal(view.source, 'env')
  assert.equal(view.configured, true)
  assert.equal('masked' in view, false)
})

test('describe reports a missing key without a source', async () => {
  const fake = fakeSeam({}, {})
  const { surface } = surfaceOf(fake.seam)
  assert.deepEqual(await surface.describe('cursor'), {
    route: 'cursor',
    keyRef: 'CURSOR_API_KEY',
    configured: false,
    writable: true,
  })
})

test('set stores under the route reference, reports the write, and clears the file layer', async () => {
  const fake = fakeSeam({}, { OLLAMA_API_KEY: 'env-value' })
  const changed: KeyRouteId[] = []
  const { surface } = surfaceOf(fake.seam, undefined, (route) =>
    changed.push(route),
  )
  const result = await surface.set('ollama-cloud', SECRET)
  assert.equal(result.committed, true)
  assert.equal(fake.files.OLLAMA_API_KEY, SECRET)
  assert.equal(
    fake.calls.some(
      (call) => call.method === 'set' && call.ref === 'OLLAMA_API_KEY',
    ),
    true,
  )
  assert.equal(result.view?.source, 'file')
  assert.deepEqual(changed, ['ollama-cloud'])
})

test('clear removes the stored copy and reports the environment that takes over', async () => {
  const fake = fakeSeam({ CURSOR_API_KEY: SECRET }, { CURSOR_API_KEY: 'env' })
  const changed: KeyRouteId[] = []
  const { surface } = surfaceOf(fake.seam, undefined, (route) =>
    changed.push(route),
  )
  const result = await surface.clear('cursor')
  assert.equal(result.committed, true)
  assert.equal(fake.files.CURSOR_API_KEY, undefined)
  assert.equal(
    fake.calls.some(
      (call) => call.method === 'unset' && call.ref === 'CURSOR_API_KEY',
    ),
    true,
  )
  // The environment layer supplies the route again: the card must say so
  // rather than claim the route has no key.
  assert.equal(result.view?.configured, true)
  assert.equal(result.view?.source, 'env')
  assert.deepEqual(changed, ['cursor'])
})

test('a committed write whose state cannot be read is not reported as a failed write', async () => {
  const fake = fakeSeam({}, {})
  let describeCalls = 0
  const seam: KeyCredentialSeam = {
    ...fake.seam,
    async describe(ref) {
      describeCalls += 1
      if (describeCalls > 0 && fake.files[ref] !== undefined)
        throw new Error(`broken store ${SECRET}`)
      return await fake.seam.describe(ref)
    },
  }
  const { surface } = surfaceOf(seam)
  const result = await surface.set('cursor', SECRET)
  assert.equal(result.committed, true)
  assert.equal(result.view, undefined)
  assert.match(result.readError ?? '', /saved, but the credential state/)
  assert.doesNotMatch(result.readError ?? '', new RegExp(SECRET))
})

test('a refused write answers a fixed sentence that never repeats the value', async () => {
  const fake = fakeSeam({}, {})
  const seam: KeyCredentialSeam = {
    ...fake.seam,
    async set() {
      throw new Error(`upstream rejected ${SECRET}`)
    },
  }
  const { surface } = surfaceOf(seam)
  await assert.rejects(surface.set('cursor', SECRET), (error: Error) => {
    assert.ok(error instanceof KeyCredentialError)
    assert.match(error.message, /refused to store the key/)
    assert.doesNotMatch(error.message, new RegExp(SECRET))
    return true
  })
})

test('a malformed configured reference is refused by route, never by value', async () => {
  const fake = fakeSeam({}, {})
  const { surface } = surfaceOf(fake.seam, { cursor: SECRET })
  await assert.rejects(surface.describe('cursor'), (error: Error) => {
    assert.match(error.message, /cursor/)
    assert.match(error.message, /not a valid reference name/)
    assert.doesNotMatch(error.message, new RegExp(SECRET))
    return true
  })
  assert.deepEqual(fake.calls, [], 'no seam call reaches a malformed name')
})

test('a route whose reference the browser can rename is refused', async () => {
  // Ollama Cloud can take its reference from a card-editable setting; were that
  // reference accepted here, the browser could aim this surface at any
  // credential the host knows.
  const fake = fakeSeam({ DEEPSEEK_API_KEY: 'a-real-key' }, {})
  const { surface } = surfaceOf(fake.seam, {
    cursor: 'CURSOR_API_KEY',
    'ollama-cloud': undefined,
  })
  await assert.rejects(surface.describe('ollama-cloud'), /this card can rename/)
  await assert.rejects(surface.set('ollama-cloud', SECRET), /can rename/)
  await assert.rejects(surface.clear('ollama-cloud'), /can rename/)
  assert.deepEqual(fake.calls, [], 'the unrelated reference is never touched')
})

test('the reference is resolved once per operation', async () => {
  const fake = fakeSeam({}, {})
  const { surface, seen } = surfaceOf(fake.seam)
  await surface.describe('cursor')
  assert.equal(seen.length, 1)
  await surface.set('cursor', 'value')
  assert.equal(seen.length, 2, 'one resolution for the write and its read back')
})

test('a host without a credential provider refuses instead of crashing', async () => {
  const { surface } = surfaceOf(undefined)
  await assert.rejects(surface.describe('cursor'), /no credential provider/)
  await assert.rejects(surface.set('cursor', 'x'), /no credential provider/)
  await assert.rejects(surface.clear('cursor'), /no credential provider/)
})

test('a reference changed after the commit supersedes its validation', async () => {
  // A Settings save moves the reference without writing the credential, so the
  // commit counter alone would let a validation authenticate another key.
  const fake = fakeSeam({}, {})
  let ref = 'CURSOR_API_KEY'
  const surface = new KeyCredentials({
    editableRefOf: () => ref,
    seam: () => fake.seam,
    resolveValue: async (name) => fake.files[name] ?? fake.env[name],
    validators: { cursor: async () => {} },
  })
  const saved = await surface.set('cursor', SECRET)
  assert.equal(saved.committed, true)
  assert.equal(
    (await surface.validate('cursor', saved.generation)).outcome,
    'valid',
  )
  ref = 'CURSOR_TEAM_KEY'
  assert.equal(
    (await surface.validate('cursor', saved.generation)).outcome,
    'superseded',
  )
})

test('a value replaced without a commit supersedes the validation too', async () => {
  const fake = fakeSeam({}, {})
  let value = 'first-key'
  const surface = new KeyCredentials({
    editableRefOf: () => 'CURSOR_API_KEY',
    seam: () => fake.seam,
    resolveValue: async () => value,
    validators: { cursor: async () => {} },
  })
  const saved = await surface.set('cursor', value)
  assert.equal(
    (await surface.validate('cursor', saved.generation)).outcome,
    'valid',
  )
  // Another writer replaced the stored value behind the service's counter.
  value = 'other-key'
  assert.equal(
    (await surface.validate('cursor', saved.generation)).outcome,
    'superseded',
  )
})

test('without a value resolver the identity is the reference alone', async () => {
  const fake = fakeSeam({}, {})
  const surface = new KeyCredentials({
    editableRefOf: () => 'CURSOR_API_KEY',
    seam: () => fake.seam,
    validators: { cursor: async () => {} },
  })
  const saved = await surface.set('cursor', SECRET)
  assert.equal(
    (await surface.validate('cursor', saved.generation)).outcome,
    'valid',
  )
})

test('a slow validation is superseded by a later commit of the same value', async () => {
  // The value is identical, so a digest comparison alone would pass: the
  // generation is what says which write the verdict belongs to.
  const fake = fakeSeam({}, {})
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const surface = new KeyCredentials({
    editableRefOf: () => 'CURSOR_API_KEY',
    seam: () => fake.seam,
    resolveValue: async (ref) => fake.files[ref] ?? fake.env[ref],
    validators: {
      cursor: async () => {
        entered?.()
        await gate
      },
    },
  })
  const first = await surface.set('cursor', SECRET)
  const pending = surface.validate('cursor', first.generation)
  await started
  // The same value is committed again while the provider read is in flight.
  const second = await surface.set('cursor', SECRET)
  assert.equal(second.committed, true)
  release?.()
  assert.equal((await pending).outcome, 'superseded')
})

test('a slow clear does not overwrite the identity of the next save', async () => {
  // The clear's fallback lookup is deferred; a save that lands meanwhile owns the
  // route, and the clear's late bookkeeping must not replace it.
  const fake = fakeSeam({}, {})
  let release: (() => void) | undefined
  const deferred = new Promise<void>((resolve) => {
    release = resolve
  })
  let slow = false
  const surface = new KeyCredentials({
    editableRefOf: () => 'CURSOR_API_KEY',
    seam: () => fake.seam,
    resolveValue: async (ref) => {
      if (slow) await deferred
      return fake.files[ref] ?? fake.env[ref]
    },
    validators: { cursor: async () => {} },
  })
  await surface.set('cursor', SECRET)
  slow = true
  const clearing = surface.clear('cursor')
  // The clear has bumped the generation; a new save owns the route now.
  slow = false
  const saved = await surface.set('cursor', 'new-key')
  release?.()
  await clearing
  assert.equal(
    (await surface.validate('cursor', saved.generation)).outcome,
    'valid',
  )
})

test('the validator receives the value the commit stored', async () => {
  // The provider read must spend the verified value; handing it nothing (or
  // letting it resolve live state) is what made a verdict about another key
  // possible.
  const fake = fakeSeam({}, {})
  const seen: (string | undefined)[] = []
  const surface = new KeyCredentials({
    editableRefOf: () => 'CURSOR_API_KEY',
    seam: () => fake.seam,
    resolveValue: async (ref) => fake.files[ref] ?? fake.env[ref],
    validators: {
      cursor: async (value) => {
        seen.push(value)
      },
    },
  })
  await surface.set('cursor', SECRET)
  assert.deepEqual(seen, [], 'no read before a validation is asked for')
  const saved = await surface.set('cursor', 'other-value')
  assert.equal(
    (await surface.validate('cursor', saved.generation)).outcome,
    'valid',
  )
  assert.deepEqual(seen, ['other-value'])
})
