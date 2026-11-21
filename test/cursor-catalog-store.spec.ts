import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  cursorCatalogStore,
  loadCursorCatalog,
  parseCursorCatalogDocument,
  saveCursorCatalog,
} from '../src/providers/cursor/catalog-store.js'

const catalogModel = {
  id: 'deepseek-v41-flash-1017',
  displayName: 'DeepSeek V4.1 Flash 1017',
  parameters: [{ id: 'reasoning_effort', values: [{ value: 'high' }, 'low'] }],
}

function pathOf(): string {
  return join(mkdtempSync(join(tmpdir(), 'cursor-catalog-')), 'catalog.json')
}

test('the catalog document round-trips through its store', async () => {
  const path = pathOf()
  assert.equal(await loadCursorCatalog(path), undefined)
  const at = 1_700_000_000_000
  await saveCursorCatalog({ at, models: [catalogModel] }, path)
  assert.deepEqual(await loadCursorCatalog(path), {
    version: 1,
    at,
    models: [catalogModel],
  })
  const persistence = cursorCatalogStore(path)
  assert.deepEqual(await persistence.load(), { at, models: [catalogModel] })
  await persistence.clear()
  assert.equal(await persistence.load(), undefined)
})

test('an unusable catalog document is discarded wholesale', async () => {
  const valid = { version: 1, at: 1, models: [catalogModel] }
  for (const invalid of [
    { ...valid, version: 2 },
    { ...valid, at: 'now' },
    { ...valid, models: [] },
    { ...valid, models: [catalogModel, catalogModel] },
    { ...valid, models: [{ id: '' }] },
    { ...valid, models: [{ id: 'x', displayName: 3 }] },
    { ...valid, models: [{ id: 'x', parameters: 'thinking' }] },
    { ...valid, models: [{ id: 'x', parameters: [{ values: ['a'] }] }] },
    { ...valid, models: [{ id: 'x', parameters: [{ id: 'p', values: [1] }] }] },
    [],
    null,
  ]) {
    assert.equal(parseCursorCatalogDocument(invalid), undefined)
  }
  // Versions and unparsable text also read as absent from disk.
  const path = pathOf()
  writeFileSync(path, JSON.stringify({ ...valid, version: 2 }))
  assert.equal(await loadCursorCatalog(path), undefined)
  writeFileSync(path, '{not json')
  assert.equal(await loadCursorCatalog(path), undefined)
})
