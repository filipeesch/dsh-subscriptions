import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { mediaArguments } from '../src/client/media-arguments.js'

function incremental(values: Record<string, unknown>): ToolCallBlock {
  return {
    args: {
      textPrefix(key: string, maxLength: number) {
        const value = values[key]
        return typeof value === 'string' ? value.slice(0, maxLength) : undefined
      },
      value(key: string) {
        return values[key]
      },
      keys() {
        return Object.keys(values)
      },
    },
  } as unknown as ToolCallBlock
}

test('incremental args supply the prompt and image reference count', () => {
  assert.deepEqual(
    mediaArguments(
      incremental({ prompt: 'draw a lighthouse', referenceImages: [{}, {}] }),
    ),
    { prompt: 'draw a lighthouse', references: 2 },
  )
})

test('incremental args fall back to the first non-empty string field', () => {
  assert.deepEqual(
    mediaArguments(
      incremental({ prompt: '', description: 'first description' }),
    ),
    { prompt: 'first description', references: 0 },
  )
})

test('legacy raw JSON keeps prompt fallback and reference counting', () => {
  const block = {
    phase: 'start',
    argsRaw: JSON.stringify({
      prompt: 'raw prompt',
      referenceImages: [{ id: 'one' }],
    }),
  } as unknown as ToolCallBlock
  assert.deepEqual(mediaArguments(block), {
    prompt: 'raw prompt',
    references: 1,
  })
})

test('settled raw JSON and malformed raw text retain their existing behavior', () => {
  const settled = {
    kind: 'result',
    call: { argsRaw: JSON.stringify({ description: 'settled description' }) },
  } as unknown as ToolCallBlock
  assert.deepEqual(mediaArguments(settled), {
    prompt: 'settled description',
    references: 0,
  })
  const malformed = {
    phase: 'start',
    argsRaw: `${'x'.repeat(70)}\nsecond line`,
  } as unknown as ToolCallBlock
  assert.deepEqual(mediaArguments(malformed), {
    prompt: `${'x'.repeat(60)}…`,
    references: 0,
  })
})

test('missing arguments produce an empty title instead of inventing data', () => {
  assert.deepEqual(mediaArguments({ phase: 'preparing' } as ToolCallBlock), {
    prompt: '',
    references: 0,
  })
})
