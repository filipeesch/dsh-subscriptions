import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CursorSettingsStore,
  validateCursorSettings,
} from '../src/providers/cursor-settings.js'

function storeAt(): { store: CursorSettingsStore; path: string } {
  const path = join(
    mkdtempSync(join(tmpdir(), 'cursor-settings-')),
    'settings.json',
  )
  return { store: new CursorSettingsStore(path), path }
}

test('a positive ceiling validates and an invalid one is refused', () => {
  assert.deepEqual(validateCursorSettings({ monthlyCeilingUSD: 2500 }), {
    monthlyCeilingUSD: 2500,
  })
  assert.deepEqual(validateCursorSettings({}), {})
  for (const value of [0, -1, Number.NaN, '2500', 2_000_000]) {
    assert.throws(() => validateCursorSettings({ monthlyCeilingUSD: value }))
  }
  assert.throws(() => validateCursorSettings([]))
})

test('per-model settings, the source switch, and accepted tiers validate', () => {
  assert.deepEqual(
    validateCursorSettings({
      publishedContext: false,
      models: {
        ' deepseek-v41-flash-1017 ': {
          enabled: false,
          contextWindow: 1_000_000,
        },
      },
      acceptedTiers: {
        'claude-sonnet-5-5': { value: '200k', preference: 'max' },
      },
    }),
    {
      publishedContext: false,
      models: {
        'deepseek-v41-flash-1017': {
          enabled: false,
          contextWindow: 1_000_000,
        },
      },
      acceptedTiers: {
        'claude-sonnet-5-5': { value: '200k', preference: 'max' },
      },
    },
  )
  // Unknown fields are dropped rather than stored.
  assert.deepEqual(validateCursorSettings({ extra: 1 }), {})
  for (const invalid of [
    { publishedContext: 'on' },
    { models: [] },
    { models: { '': { enabled: true } } },
    { models: { m: { enabled: 'yes' } } },
    { models: { m: { contextWindow: 0 } } },
    { models: { m: { contextWindow: 1.5 } } },
    { acceptedTiers: { m: { value: '', preference: 'max' } } },
    { acceptedTiers: { m: { value: '200k', preference: 3 } } },
    { acceptedTiers: [] },
  ]) {
    assert.throws(
      () => validateCursorSettings(invalid),
      JSON.stringify(invalid),
    )
  }
})

test('the store round-trips and reports a corrupt file without failing', async () => {
  const { store, path } = storeAt()
  assert.equal(store.ceilingUSD(), undefined)
  await store.set({ monthlyCeilingUSD: 2500 })
  assert.equal(store.ceilingUSD(), 2500)
  assert.match(readFileSync(path, 'utf8'), /2500/)

  const reloaded = new CursorSettingsStore(path)
  assert.equal(reloaded.ceilingUSD(), 2500)

  const corruptMessages: string[] = []
  writeFileSync(path, '{not json')
  const broken = new CursorSettingsStore(path, (message) => {
    corruptMessages.push(message)
  })
  assert.equal(broken.ceilingUSD(), undefined)
  assert.equal(corruptMessages.length, 1)
  await broken.set({})
  assert.equal(broken.corruption(), undefined)
})

test('a legacy per-model tier and accepted tier still read', async () => {
  // A document written before the route dropped the tier preference: the tier
  // field is dropped, the accepted tier keeps its value, and nothing is
  // reported as corrupt.
  const legacy = validateCursorSettings({
    models: { 'claude-sonnet-5-5': { enabled: true, context: 'min' } },
    acceptedTiers: {
      'claude-sonnet-5-5': { value: '200k', preference: 'min' },
    },
  })
  assert.deepEqual(legacy.models, { 'claude-sonnet-5-5': { enabled: true } })
  assert.equal(legacy.acceptedTiers?.['claude-sonnet-5-5']?.value, '200k')
  // A record with no preference is normalized, so the next save writes a
  // document an older build can still validate.
  assert.deepEqual(
    validateCursorSettings({
      acceptedTiers: { 'claude-sonnet-5-5': { value: '200k' } },
    }).acceptedTiers,
    { 'claude-sonnet-5-5': { value: '200k', preference: 'max' } },
  )

  const { store, path } = storeAt()
  await store.set({
    models: { 'claude-sonnet-5-5': { enabled: false, context: 'min' } },
    acceptedTiers: {
      'claude-sonnet-5-5': { value: '200k', preference: 'min' },
    },
  })
  const reloaded = new CursorSettingsStore(path)
  assert.equal(reloaded.corruption(), undefined)
  assert.deepEqual(reloaded.modelSettings('claude-sonnet-5-5'), {
    enabled: false,
  })
  assert.equal(reloaded.acceptedTier('claude-sonnet-5-5'), '200k')
})

test('an unrelated save writes the compatibility field onto a legacy record', async () => {
  const { path } = storeAt()
  writeFileSync(
    path,
    JSON.stringify({
      acceptedTiers: { 'claude-sonnet-5-5': { value: '200k' } },
    }),
  )
  const loaded = new CursorSettingsStore(path)
  assert.equal(loaded.corruption(), undefined)
  assert.equal(loaded.acceptedTier('claude-sonnet-5-5'), '200k')
  await loaded.setCeiling(25)
  const written = JSON.parse(readFileSync(path, 'utf8')) as {
    acceptedTiers?: Record<string, { value: string; preference?: string }>
  }
  assert.deepEqual(written.acceptedTiers, {
    'claude-sonnet-5-5': { value: '200k', preference: 'max' },
  })
})

test('a remembered tier is read without a preference and written with the rollback field', async () => {
  const { store, path } = storeAt()
  await store.rememberAcceptedTier('claude-sonnet-5-5', '200k')
  assert.equal(store.acceptedTier('claude-sonnet-5-5'), '200k')
  // The constant keeps an older build able to read the document after a
  // rollback; nothing in this build reads it.
  assert.match(readFileSync(path, 'utf8'), /"preference": "max"/)
  await store.forgetAcceptedTier('claude-sonnet-5-5')
  assert.equal(store.acceptedTier('claude-sonnet-5-5'), undefined)
  const reloaded = new CursorSettingsStore(path)
  assert.equal(reloaded.acceptedTier('claude-sonnet-5-5'), undefined)
})

test('the ceiling update keeps the rest of the document', async () => {
  const { store } = storeAt()
  await store.set({
    publishedContext: false,
    models: { 'claude-sonnet-5-5': { contextWindow: 200_000 } },
    acceptedTiers: {
      'claude-sonnet-5-5': { value: '200k', preference: 'max' },
    },
  })
  await store.setCeiling(2500)
  const settings = store.get()
  assert.equal(settings.monthlyCeilingUSD, 2500)
  assert.equal(settings.publishedContext, false)
  assert.equal(settings.models?.['claude-sonnet-5-5']?.contextWindow, 200_000)
  assert.equal(settings.acceptedTiers?.['claude-sonnet-5-5']?.value, '200k')
  await store.setCeiling(undefined)
  assert.equal(store.get().monthlyCeilingUSD, undefined)
  assert.equal(
    store.get().models?.['claude-sonnet-5-5']?.contextWindow,
    200_000,
  )
})

test('serialized writes keep both per-model updates', async () => {
  const { store } = storeAt()
  await Promise.all([
    store.rememberAcceptedTier('a', '200k'),
    store.rememberAcceptedTier('b', '1m'),
  ])
  const reloaded = new CursorSettingsStore(store.path)
  assert.equal(reloaded.acceptedTier('a'), '200k')
  assert.equal(reloaded.acceptedTier('b'), '1m')
})

test('a settings write is visible before its disk write settles', () => {
  const { store } = storeAt()
  const pending = store.rememberAcceptedTier('claude-sonnet-5-5', '200k')
  // The runtime reports success after the same turn; resolution must see it.
  assert.equal(store.acceptedTier('claude-sonnet-5-5'), '200k')
  return pending
})

test('a merge preserves concurrent ceiling, tier, and model writes', async () => {
  const { store, path } = storeAt()
  await Promise.all([
    store.setCeiling(2500),
    store.merge({ models: { 'composer-2': { contextWindow: 200_000 } } }),
    store.rememberAcceptedTier('claude-sonnet-5-5', '200k'),
    store.merge({ publishedContext: false }),
  ])
  const settings = store.get()
  assert.equal(settings.monthlyCeilingUSD, 2500)
  assert.equal(settings.models?.['composer-2']?.contextWindow, 200_000)
  assert.equal(settings.acceptedTiers?.['claude-sonnet-5-5']?.value, '200k')
  assert.equal(settings.publishedContext, false)
  // The same document is what a fresh read sees.
  const reloaded = new CursorSettingsStore(path)
  assert.equal(reloaded.ceilingUSD(), 2500)
  assert.equal(reloaded.publishedContext(), false)
  assert.equal(reloaded.modelSettings('composer-2')?.contextWindow, 200_000)
  assert.equal(reloaded.acceptedTier('claude-sonnet-5-5'), '200k')
})

test('a guarded removal keeps a newer record', async () => {
  const { store } = storeAt()
  await store.rememberAcceptedTier('claude-sonnet-5-5', '1m')
  // A removal naming a record this one replaced must not delete it.
  await store.forgetAcceptedTierIf('claude-sonnet-5-5', { value: '200k' })
  assert.equal(store.acceptedTier('claude-sonnet-5-5'), '1m')
  await store.forgetAcceptedTierIf('claude-sonnet-5-5', { value: '1m' })
  assert.equal(store.acceptedTier('claude-sonnet-5-5'), undefined)
})

test('a removal queued behind a newer record keeps it', async () => {
  const { store } = storeAt()
  await store.rememberAcceptedTier('claude-sonnet-5-5', '200k')
  const stale = store.forgetAcceptedTierIf('claude-sonnet-5-5', {
    value: '200k',
  })
  const newer = store.rememberAcceptedTier('claude-sonnet-5-5', '1m')
  await Promise.all([stale, newer])
  assert.equal(store.acceptedTier('claude-sonnet-5-5'), '1m')
})

test('an invalid merge rejects without changing the document', async () => {
  const { store } = storeAt()
  await assert.rejects(
    store.merge({
      models: { m: { contextWindow: 0 } },
    }),
  )
  assert.deepEqual(store.get(), {})
})

test('a failed save changes nothing and cannot leak into a later save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-settings-'))
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const path = join(blocker, 'settings.json')
  const store = new CursorSettingsStore(path)
  await assert.rejects(store.merge({ publishedContext: false }))
  // A rejected save must not change what the running route reads.
  assert.equal(store.publishedContext(), undefined)
  // Repair the path and save something unrelated.
  rmSync(blocker)
  mkdirSync(blocker)
  await store.setCeiling(100)
  assert.equal(store.ceilingUSD(), 100)
  // The failed edit was neither active nor persisted by the later save.
  assert.equal(store.publishedContext(), undefined)
  assert.equal(new CursorSettingsStore(path).publishedContext(), undefined)
})

test('a learned tier is visible at once but a failed write stays memory-only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-settings-'))
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const path = join(blocker, 'settings.json')
  const store = new CursorSettingsStore(path)
  const write = store.rememberAcceptedTier('claude-sonnet-5-5', '200k')
  // The turn that learned it must see it without awaiting the disk.
  assert.equal(store.acceptedTier('claude-sonnet-5-5'), '200k')
  await assert.rejects(write)
  rmSync(blocker)
  mkdirSync(blocker)
  await store.setCeiling(10)
  // Still visible in memory, never written, so a restart does not resurrect it.
  assert.equal(store.acceptedTier('claude-sonnet-5-5'), '200k')
  const reloaded = new CursorSettingsStore(path)
  assert.equal(reloaded.acceptedTier('claude-sonnet-5-5'), undefined)
  assert.equal(reloaded.ceilingUSD(), 10)
})
