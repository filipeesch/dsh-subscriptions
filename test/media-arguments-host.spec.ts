import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { mediaArguments } from '../src/client/media-arguments.js'

interface ArgumentsView {
  append(fragment: string): void
  refresh(): boolean
  textPrefix(key: string, maxLength: number): string | undefined
  value(key: string): unknown
  keys(): Iterable<string>
}
interface ArgumentsClass {
  new (): ArgumentsView
  fromText(text: string): ArgumentsView
}

async function loadPartialArguments(): Promise<ArgumentsClass | undefined> {
  const require = createRequire(import.meta.url)
  try {
    const hostRequire = createRequire(
      require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'),
    )
    const modulePath = hostRequire.resolve('@deepseek-ai/dsh-util-values')
    const module = (await import(pathToFileURL(modulePath).href)) as {
      PartialArguments?: ArgumentsClass
    }
    return module.PartialArguments
  } catch {
    return undefined
  }
}

test('real host PartialArguments keeps preparing, settled, truncation and fallback reads live', async (t) => {
  const PartialArguments = await loadPartialArguments()
  if (PartialArguments === undefined) {
    t.skip('This host does not ship the incremental argument reader')
    return
  }
  const args = new PartialArguments()
  args.append('{"prompt":"draw a ')
  const preparing = { args } as unknown as ToolCallBlock
  assert.deepEqual(mediaArguments(preparing), {
    prompt: 'draw a ',
    references: 0,
  })
  args.append('lighthouse","referenceImages":[{},{}]}')
  assert.equal(args.refresh(), true)
  assert.deepEqual(mediaArguments(preparing), {
    prompt: 'draw a lighthouse',
    references: 2,
  })

  const longPrompt = `${'x'.repeat(70)}\nsecond line`
  const settled = PartialArguments.fromText(
    JSON.stringify({ prompt: longPrompt }),
  )
  assert.deepEqual(
    mediaArguments({ args: settled } as unknown as ToolCallBlock),
    {
      prompt: `${'x'.repeat(60)}…`,
      references: 0,
    },
  )
  const fallback = PartialArguments.fromText(
    JSON.stringify({ description: 'first description' }),
  )
  assert.deepEqual(
    mediaArguments({ args: fallback } as unknown as ToolCallBlock),
    {
      prompt: 'first description',
      references: 0,
    },
  )
})
