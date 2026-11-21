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

test('rows carry the resolved window, its source, and the offered tiers', () => {
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
  // A published value outranks the manual field, so that field is a chip.
  assert.equal(rows[0]?.manualWindow.editable, false)
})

test('a tiered model is not manually editable and follows the preference', () => {
  const rows = buildCursorModelRows({
    models: [tiered],
    settings: {},
    config: { context: '200k' },
    publishedWindow: () => 400_000,
  })
  assert.deepEqual(rows[0]?.window, {
    tokens: 200_000,
    source: 'tier',
    tier: '200k',
  })
  assert.deepEqual(rows[0]?.tierOptions, ['200k', '1m'])
  assert.equal(rows[0]?.manualWindow.editable, false)
  assert.equal(rows[0]?.described, true)
})

test('settings win per field and the manual field edits the rest', () => {
  const rows = buildCursorModelRows({
    models: [described, bare],
    settings: {
      models: {
        'deepseek-v41-flash-1017': {
          enabled: false,
          context: 'max',
          contextWindow: 300_000,
        },
        'composer-2': { contextWindow: 200_000 },
      },
    },
    config: { models: { 'deepseek-v41-flash-1017': { enabled: true } } },
    publishedWindow: () => undefined,
  })
  const deepseek = rows.find((row) => row.id === 'deepseek-v41-flash-1017')
  assert.equal(deepseek?.enabled, false)
  assert.equal(deepseek?.tierOverride, 'max')
  assert.deepEqual(deepseek?.window, { tokens: 300_000, source: 'manual' })
  assert.deepEqual(deepseek?.manualWindow, { editable: true, value: 300_000 })
  const composer = rows.find((row) => row.id === 'composer-2')
  assert.equal(composer?.described, false)
  assert.deepEqual(composer?.window, { tokens: 200_000, source: 'manual' })
})

test('a remembered tier is what the row reports after a rejection', () => {
  const rows = buildCursorModelRows({
    models: [tiered],
    settings: {
      acceptedTiers: {
        'claude-sonnet-5-5': { value: '200k', preference: 'max' },
      },
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
