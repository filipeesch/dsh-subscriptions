import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_CONTEXT_WINDOW,
  contextWindowFor,
  resolveContextWindow,
} from '../src/providers/cursor/context-window.js'

const tiered = {
  id: 'claude-sonnet-5-5',
  parameters: [
    {
      id: 'context',
      values: [{ value: '50k' }, { value: '200k' }, { value: '1m' }],
    },
  ],
}

const described = { id: 'deepseek-v41-flash-1017', parameters: [] }
const deepseekPublished = 1_048_576

test('the tier the request carries decides the window first', () => {
  assert.deepEqual(
    resolveContextWindow({
      model: tiered,
      tier: '200k',
      publishedWindow: deepseekPublished,
      manualWindow: 900_000,
    }),
    { tokens: 200_000, source: 'tier', tier: '200k' },
  )
  // A tier the catalog no longer offers does not speak for the model.
  assert.deepEqual(
    resolveContextWindow({
      model: tiered,
      tier: '500k',
      manualWindow: 300_000,
    }),
    { tokens: 300_000, source: 'manual' },
  )
})

test('a manual value outranks the published capacity', () => {
  // The published number is a third-party estimate; a value the reader typed is
  // a correction of it, so the estimate must not outrank the correction.
  assert.deepEqual(
    resolveContextWindow({
      model: described,
      publishedWindow: deepseekPublished,
      manualWindow: 900_000,
    }),
    { tokens: 900_000, source: 'manual' },
  )
})

test('the published capacity decides when no tier and no manual value apply', () => {
  assert.deepEqual(
    resolveContextWindow({
      model: described,
      publishedWindow: deepseekPublished,
    }),
    { tokens: deepseekPublished, source: 'published' },
  )
  assert.deepEqual(
    resolveContextWindow({ model: described, publishedWindow: undefined }),
    { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' },
  )
})

test('a manual value applies only when no tier applies', () => {
  assert.deepEqual(
    resolveContextWindow({ model: described, manualWindow: 300_000 }),
    { tokens: 300_000, source: 'manual' },
  )
  assert.deepEqual(resolveContextWindow({ model: described }), {
    tokens: DEFAULT_CONTEXT_WINDOW,
    source: 'default',
  })
  // Zero, negative, and non-finite values are ignored, not advertised.
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      resolveContextWindow({ model: described, manualWindow: value }),
      { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' },
    )
  }
})

test('the advertised window follows the largest offered tier', () => {
  assert.equal(contextWindowFor(tiered), 1_000_000)
  // The tier Cursor accepted after a rejection wins while it is offered.
  assert.equal(contextWindowFor(tiered, '200k'), 200_000)
  // A withdrawn accepted tier falls back to the largest.
  assert.equal(contextWindowFor(tiered, '500k'), 1_000_000)
  assert.equal(
    contextWindowFor({
      parameters: [{ id: 'reasoning_effort', values: ['high'] }],
    }),
    DEFAULT_CONTEXT_WINDOW,
  )
})

test('an invalid manual value is not advertised', () => {
  assert.deepEqual(resolveContextWindow({ manualWindow: 1_000_000.5 }), {
    tokens: DEFAULT_CONTEXT_WINDOW,
    source: 'default',
  })
  assert.deepEqual(resolveContextWindow({ manualWindow: 0 }), {
    tokens: DEFAULT_CONTEXT_WINDOW,
    source: 'default',
  })
  assert.deepEqual(resolveContextWindow({ publishedWindow: Number.NaN }), {
    tokens: DEFAULT_CONTEXT_WINDOW,
    source: 'default',
  })
})
