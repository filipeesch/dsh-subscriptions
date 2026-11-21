import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CursorAdapter } from '../src/providers/cursor/adapter.js'
import type {
  CursorAgent,
  CursorAgentOptions,
  CursorEvent,
  CursorGateway,
  CursorRun,
} from '../src/providers/cursor/runtime.js'

const CATALOG = [
  {
    id: 'claude-sonnet-5-5',
    displayName: 'Claude Sonnet 5.5',
    parameters: [
      { id: 'context', values: [{ value: '200k' }, { value: '1m' }] },
    ],
  },
]

type Chunk = Record<string, unknown>

function request(
  messages: unknown[],
  extra: Partial<GenerateOptions> = {},
): GenerateOptions {
  return {
    provider: 'cursor',
    model: 'claude-sonnet-5-5',
    messages: messages as GenerateOptions['messages'],
    ...extra,
  }
}

function adapterOf(gateway: CursorGateway): CursorAdapter {
  return new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    prewarm: false,
  })
}

async function collect(
  adapter: CursorAdapter,
  options: GenerateOptions,
): Promise<Chunk[]> {
  const chunks: Chunk[] = []
  for await (const chunk of adapter.stream(options)) {
    chunks.push(chunk as unknown as Chunk)
  }
  return chunks
}

/** A run that stays open until the test releases it. */
function gatedRun(events: CursorEvent[]): {
  run: CursorRun
  release: () => void
  cancelled: () => boolean
} {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let cancelled = false
  const run: CursorRun = {
    async *stream() {
      yield* events
      await gate
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }
    },
    async wait() {
      await gate
      return { status: cancelled ? 'cancelled' : 'finished' }
    },
    async cancel() {
      cancelled = true
      release()
    },
  }
  return { run, release, cancelled: () => cancelled }
}

function gatewayWith(agentOf: (options?: CursorAgentOptions) => CursorAgent): {
  gateway: CursorGateway
  agents: CursorAgent[]
} {
  const agents: CursorAgent[] = []
  return {
    gateway: {
      async createAgent(options) {
        const agent = agentOf(options)
        agents.push(agent)
        return agent
      },
      async deleteAgent() {},
      async listModels() {
        return CATALOG
      },
    },
    agents,
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await delay(5)
  }
}

test('the first delta arrives while the run is still open', async () => {
  const { run, release } = gatedRun([
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'live' }] },
    },
  ])
  const { gateway } = gatewayWith(() => ({
    async send() {
      return run
    },
    close() {},
  }))
  const adapter = adapterOf(gateway)
  const chunks: Chunk[] = []
  const stream = (async () => {
    for await (const chunk of adapter.stream(
      request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
    )) {
      chunks.push(chunk as unknown as Chunk)
    }
  })()
  await waitFor(() => chunks.some((chunk) => chunk.type === 'text-delta'))
  release()
  await stream
  assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
})

test('a tool round trip runs on the same live agent', async () => {
  const { run, release } = gatedRun([
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'calling' }] },
    },
  ])
  let execution: Promise<unknown> | undefined
  let sentCount = 0
  let createOptions: CursorAgentOptions | undefined
  const agent: CursorAgent = {
    async send(_message) {
      sentCount++
      const tools = (
        createOptions as
          | {
              local?: {
                customTools?: Record<
                  string,
                  {
                    execute: (args: unknown, ctx: unknown) => Promise<unknown>
                  }
                >
              }
            }
          | undefined
      )?.local?.customTools
      for (const tool of Object.values(tools ?? {})) {
        execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
        void execution.then(() => release())
      }
      return run
    },
    close() {},
  }
  const { gateway, agents } = gatewayWith((options) => {
    createOptions = options
    return agent
  })
  const adapter = adapterOf(gateway)
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const first = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'use the tool' }],
    },
  ]
  const firstChunks = await collect(
    adapter,
    request(first, { sessionId: 'session-tool' as never, tools }),
  )
  assert.deepEqual(firstChunks.find((c) => c.type === 'finish')?.reason, {
    kind: 'tool-calls',
  })

  const second = [
    ...first,
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'calling' },
        {
          type: 'tool-call' as const,
          id: 'c1',
          name: 'tool',
          arguments: { q: 'tool' },
        },
      ],
    },
    {
      role: 'tool' as const,
      toolCallId: 'c1',
      content: [{ type: 'text' as const, text: 'the result' }],
    },
  ]
  const secondChunks = await collect(
    adapter,
    request(second, { sessionId: 'session-tool' as never, tools }),
  )
  assert.deepEqual(await execution, {
    content: [{ type: 'text', text: 'the result' }],
    isError: false,
  })
  assert.ok(
    secondChunks.some(
      (chunk) =>
        chunk.type === 'text-delta' && JSON.stringify(chunk).includes('done'),
    ),
  )
  // The result was delivered to the live run, not sent as a new prompt.
  assert.equal(agents.length, 1)
  assert.equal(sentCount, 1)
})

test('an already-aborted request creates no agent', async () => {
  const { gateway, agents } = gatewayWith(() => ({
    async send() {
      throw new Error('must not send')
    },
    close() {},
  }))
  const adapter = adapterOf(gateway)
  const controller = new AbortController()
  controller.abort()
  const chunks = await collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], {
      signal: controller.signal,
    }),
  )
  assert.equal(agents.length, 0)
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
})

test('aborting mid-run cancels the Cursor run and ends aborted', async () => {
  const { run, cancelled } = gatedRun([
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'working' }] },
    },
  ])
  const { gateway } = gatewayWith(() => ({
    async send() {
      return run
    },
    close() {},
  }))
  const adapter = adapterOf(gateway)
  const controller = new AbortController()
  const chunks: Chunk[] = []
  const stream = (async () => {
    for await (const chunk of adapter.stream(
      request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], {
        signal: controller.signal,
      }),
    )) {
      chunks.push(chunk as unknown as Chunk)
    }
  })()
  await waitFor(() => chunks.some((chunk) => chunk.type === 'text-delta'))
  controller.abort()
  await stream
  assert.equal(cancelled(), true)
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
})

test('disposing while the agent is being created closes the late agent', async () => {
  let resolveAgent!: (agent: CursorAgent) => void
  let closed = false
  const agent: CursorAgent = {
    async send() {
      return gatedRun([]).run
    },
    close() {
      closed = true
    },
  }
  const { gateway } = gatewayWith(() => agent)
  gateway.createAgent = () =>
    new Promise<CursorAgent>((resolve) => {
      resolveAgent = resolve
    })
  const adapter = adapterOf(gateway)
  const chunks: Chunk[] = []
  const stream = (async () => {
    for await (const chunk of adapter.stream(
      request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
    )) {
      chunks.push(chunk as unknown as Chunk)
    }
  })()
  await delay(20)
  adapter.dispose()
  resolveAgent(agent)
  await stream
  assert.equal(closed, true)
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'error',
  )
})
