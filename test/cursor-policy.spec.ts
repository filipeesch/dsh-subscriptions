import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  enabledFor,
  manualWindowFor,
  publishedContextEnabled,
} from '../src/providers/cursor/policy.js'
import type { CursorSettings } from '../src/providers/cursor-settings.js'
import { Config } from '../src/index.js'

test('the stored setting wins over the configured baseline', () => {
  const settings = {
    models: { m: { enabled: false, contextWindow: 300_000 } },
  }
  const config = {
    models: { m: { enabled: true } },
    contextWindows: { m: 400_000 },
  }
  assert.equal(manualWindowFor(settings, config, 'm'), 300_000)
  assert.equal(enabledFor(settings, config, 'm'), false)
})

test('the configured baseline applies when the setting is absent', () => {
  const settings = { models: {} }
  const config = {
    models: { m: { enabled: false } },
    contextWindows: { m: 400_000 },
  }
  assert.equal(manualWindowFor(settings, config, 'm'), 400_000)
  assert.equal(enabledFor(settings, config, 'm'), false)
  // A model named nowhere stays enabled and has no manual window.
  assert.equal(manualWindowFor(settings, config, 'other'), undefined)
  assert.equal(enabledFor(settings, config, 'other'), true)
})

test('the route default is the last resort', () => {
  assert.equal(manualWindowFor({}, undefined, 'm'), undefined)
  assert.equal(enabledFor({}, undefined, 'm'), true)
  assert.equal(publishedContextEnabled({}, undefined), true)
  assert.equal(
    publishedContextEnabled(
      { publishedContext: false },
      { publishedContext: true },
    ),
    false,
  )
  assert.equal(publishedContextEnabled({}, { publishedContext: false }), false)
})

test('an individual invalid manual entry is ignored, not rounded', () => {
  const settings: CursorSettings = {}
  assert.equal(
    manualWindowFor(settings, { contextWindows: { m: 300_000.5 } }, 'm'),
    undefined,
  )
  assert.equal(
    manualWindowFor(settings, { contextWindows: { m: 0 } }, 'm'),
    undefined,
  )
  assert.equal(
    manualWindowFor(settings, { contextWindows: { m: 300_000 } }, 'm'),
    300_000,
  )
})

test('invalid YAML window entries are kept and ignored next to a valid sibling', () => {
  const parsed = Config({
    cursor: {
      contextWindows: {
        text: '300k',
        flag: true,
        list: [],
        object: {},
        negative: -1,
        fraction: 1.5,
        good: 300_000,
      },
    },
  })
  const config = parsed.cursor
  assert.deepEqual(config?.contextWindows, {
    text: '300k',
    flag: true,
    list: [],
    object: {},
    negative: -1,
    fraction: 1.5,
    good: 300_000,
  })
  for (const id of ['text', 'flag', 'list', 'object', 'negative', 'fraction']) {
    assert.equal(manualWindowFor({}, config, id), undefined, id)
  }
  assert.equal(manualWindowFor({}, config, 'good'), 300_000)
})
