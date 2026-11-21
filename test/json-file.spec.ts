import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  loadJsonFile,
  loadJsonFileSync,
  renameWithRetry,
  serializeWrites,
  writeJsonFile,
} from '../src/json-file.js'

function temporaryPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'json-file-')), name)
}

test('a written document reads back, including one with a byte order mark', async () => {
  const path = temporaryPath('store.json')
  assert.deepEqual(await loadJsonFile(path), { kind: 'missing' })
  await writeJsonFile(path, { value: 1 })
  assert.deepEqual(await loadJsonFile(path), {
    kind: 'value',
    value: { value: 1 },
  })
  assert.deepEqual(loadJsonFileSync(path), {
    kind: 'value',
    value: { value: 1 },
  })
  await writeJsonFile(path, { value: 2 })
  assert.match(readFileSync(path, 'utf8'), /"value": 2/)
  // Hand-edited files may carry a BOM; parsing must not treat it as an error.
  writeFileSync(path, '\ufeff{"value":3}')
  assert.deepEqual(loadJsonFileSync(path), {
    kind: 'value',
    value: { value: 3 },
  })
  // A parse failure is distinguishable from a missing file.
  writeFileSync(path, '{not json')
  assert.equal((await loadJsonFile(path)).kind, 'invalid')
  assert.equal(loadJsonFileSync(path).kind, 'invalid')
})

test('writes to one path run in call order', async () => {
  const path = temporaryPath('ordered.json')
  const order: number[] = []
  const first = serializeWrites(path, async () => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    order.push(1)
  })
  const second = serializeWrites(path, async () => {
    order.push(2)
  })
  await Promise.all([first, second])
  assert.deepEqual(order, [1, 2])
  // A failing mutation rejects its caller but does not block the next one.
  await assert.rejects(
    serializeWrites(path, async () => {
      throw new Error('boom')
    }),
  )
  await serializeWrites(path, async () => {
    order.push(3)
  })
  assert.deepEqual(order, [1, 2, 3])
})

test('the Windows rename retry survives share-mode conflicts', async () => {
  let attempts = 0
  await renameWithRetry('from', 'to', {
    platform: 'win32',
    delayMs: 0,
    attemptRename: async () => {
      attempts += 1
      if (attempts < 3) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
    },
  })
  assert.equal(attempts, 3)

  // POSIX and unknown codes fail at once: they are not share-mode conflicts.
  attempts = 0
  await assert.rejects(
    renameWithRetry('from', 'to', {
      platform: 'darwin',
      delayMs: 0,
      attemptRename: async () => {
        attempts += 1
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      },
    }),
  )
  assert.equal(attempts, 1)

  attempts = 0
  await assert.rejects(
    renameWithRetry('from', 'to', {
      platform: 'win32',
      delayMs: 0,
      attemptRename: async () => {
        attempts += 1
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
    }),
  )
  assert.equal(attempts, 1)

  // The retry budget is bounded.
  attempts = 0
  await assert.rejects(
    renameWithRetry('from', 'to', {
      platform: 'win32',
      delayMs: 0,
      attemptRename: async () => {
        attempts += 1
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      },
    }),
  )
  assert.equal(attempts, 6)
})
