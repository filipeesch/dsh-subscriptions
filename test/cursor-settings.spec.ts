import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CursorSettingsStore,
  validateCursorSettings,
} from '../src/providers/cursor-settings.js'

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

test('the store round-trips and reports a corrupt file without failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-settings-'))
  const path = join(dir, 'cursor-settings.json')
  const corruptMessages: string[] = []
  const store = new CursorSettingsStore(path, (message) => {
    corruptMessages.push(message)
  })
  assert.equal(store.ceilingUSD(), undefined)
  await store.set({ monthlyCeilingUSD: 2500 })
  assert.equal(store.ceilingUSD(), 2500)
  assert.match(readFileSync(path, 'utf8'), /2500/)

  const reloaded = new CursorSettingsStore(path)
  assert.equal(reloaded.ceilingUSD(), 2500)

  writeFileSync(path, '{not json')
  const broken = new CursorSettingsStore(path, (message) => {
    corruptMessages.push(message)
  })
  assert.equal(broken.ceilingUSD(), undefined)
  assert.equal(corruptMessages.length, 1)
  await broken.set({})
  assert.equal(broken.corruption(), undefined)
})
