import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCursorModelRows } from '../src/providers/cursor/model-rows.js'

const tiered = {
  id: 'claude-sonnet-5-5',
  displayName: 'Claude Sonnet 5.5',
  parameters: [{ id: 'context', values: [{ value: '200k' }, { value: '1m' }] }],
}
const described = {
  id: 'deepseek-v41-flash-1017',
  displayName: 'DeepSeek V4.1 Flash 1017',
  parameters: [{ id: 'reasoning_effort', values: [{ value: 'high' }] }],
}
const bare = { id: 'composer-2' }

test('rows carry the resolved window, its source, and the override state', () => {
  const rows = buildCursorModelRows({
    models: [described],
    settings: {},
    config: undefined,
    publishedWindow: (id) =>
      id === 'deepseek-v41-flash-1017' ? 1_048_576 : undefined,
  })
  assert.deepEqual(rows[0]?.window, {
    tokens: 1_048_576,
    source: 'published',
  })
  assert.equal(rows[0]?.name, 'DeepSeek V4.1 Flash 1017')
  assert.equal(rows[0]?.publishedWindow, 1_048_576)
  // The published value can be corrected, so the row offers the override.
  assert.equal(rows[0]?.overridable, true)
})

test('a tiered model offers no override because the tier decides', () => {
  const rows = buildCursorModelRows({
    models: [tiered],
    settings: {},
    config: undefined,
    publishedWindow: () => 400_000,
  })
  assert.deepEqual(rows[0]?.window, {
    tokens: 1_000_000,
    source: 'tier',
    tier: '1m',
  })
  assert.equal(rows[0]?.overridable, false)
  assert.equal(rows[0]?.described, true)
})

test('settings win on enablement and the stored window stays with the page', () => {
  const rows = buildCursorModelRows({
    models: [described, bare],
    settings: {
      models: {
        'deepseek-v41-flash-1017': { enabled: false, contextWindow: 300_000 },
        'composer-2': { contextWindow: 200_000 },
      },
    },
    config: { models: { 'deepseek-v41-flash-1017': { enabled: true } } },
    publishedWindow: () => undefined,
  })
  const deepseek = rows.find((row) => row.id === 'deepseek-v41-flash-1017')
  assert.equal(deepseek?.enabled, false)
  // The page owns the stored overrides, so a row states the window that
  // survives when the page clears one: here, the generic default.
  assert.deepEqual(deepseek?.window, { tokens: 200_000, source: 'default' })
  assert.equal(deepseek?.overridable, true)
  const composer = rows.find((row) => row.id === 'composer-2')
  assert.equal(composer?.described, false)
  assert.deepEqual(composer?.window, { tokens: 200_000, source: 'default' })
})

test('a remembered tier is what the row reports after a rejection', () => {
  const rows = buildCursorModelRows({
    models: [tiered],
    settings: {
      acceptedTiers: { 'claude-sonnet-5-5': { value: '200k' } },
    },
    config: undefined,
    publishedWindow: () => undefined,
  })
  assert.deepEqual(rows[0]?.window, {
    tokens: 200_000,
    source: 'tier',
    tier: '200k',
  })
})

test('the configured baseline is the window a row falls back to', () => {
  const rows = buildCursorModelRows({
    models: [described],
    settings: {},
    config: { contextWindows: { 'deepseek-v41-flash-1017': 900_000 } },
    publishedWindow: () => 1_048_576,
  })
  // A profile's baseline outranks the published capacity, and the page stores
  // its overrides on top of it.
  assert.deepEqual(rows[0]?.window, { tokens: 900_000, source: 'manual' })
  assert.equal(rows[0]?.publishedWindow, 1_048_576)
})

test('an invalid configured entry is ignored rather than stored', () => {
  const rows = buildCursorModelRows({
    models: [described],
    settings: {},
    config: { contextWindows: { 'deepseek-v41-flash-1017': 0 } },
    publishedWindow: () => 1_048_576,
  })
  assert.deepEqual(rows[0]?.window, {
    tokens: 1_048_576,
    source: 'published',
  })
})
