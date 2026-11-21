import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CursorAdapter } from '../src/providers/cursor/adapter.js'
import { CursorRuntime } from '../src/providers/cursor/runtime.js'
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
  models: () => number
} {
  const agents: CursorAgent[] = []
  let models = 0
  return {
    gateway: {
      async createAgent(options) {
        const agent = agentOf(options)
        agents.push(agent)
        return agent
      },
      async deleteAgent() {},
      async listModels() {
        models += 1
        return CATALOG
      },
    },
    agents,
    models: () => models,
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

test('an already-aborted request creates no agent and reads no catalog', async () => {
  const { gateway, agents, models } = gatewayWith(() => ({
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
  assert.equal(models(), 0, 'a cancelled request must not read the catalog')
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

test('aborting while the agent is created sends nothing and closes it', async () => {
  let resolveAgent!: (agent: CursorAgent) => void
  let closed = 0
  let sent = 0
  const agent: CursorAgent = {
    async send() {
      sent += 1
      return gatedRun([]).run
    },
    close() {
      closed += 1
    },
  }
  const { gateway } = gatewayWith(() => agent)
  gateway.createAgent = () =>
    new Promise<CursorAgent>((resolve) => {
      resolveAgent = resolve
    })
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
  await delay(20)
  controller.abort()
  resolveAgent(agent)
  await stream
  assert.equal(sent, 0)
  assert.equal(closed, 1)
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
})

test('prewarm closes its agent when disposal lands before the send', async () => {
  let resolveAgent!: (agent: CursorAgent) => void
  let closed = 0
  let sent = 0
  const runtime = new CursorRuntime({
    gateway: {
      async createAgent() {
        return new Promise<CursorAgent>((resolve) => {
          resolveAgent = resolve
        })
      },
      async deleteAgent() {},
      async listModels() {
        return CATALOG
      },
    },
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    contextPreference: () => 'max',
    keyRef: 'CURSOR_API_KEY',
  })
  runtime.prewarm('crsr_test', 'claude-sonnet-5-5')
  await delay(10)
  runtime.dispose()
  resolveAgent({
    async send() {
      sent += 1
      return gatedRun([]).run
    },
    close() {
      closed += 1
    },
    agentId: 'warm-agent',
  })
  await delay(50)
  assert.equal(sent, 0)
  assert.equal(closed, 1)
})

function retryAgent(): CursorAgent {
  return {
    async send() {
      return {
        async *stream() {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
          }
        },
        async wait() {
          return { status: 'finished' }
        },
        async cancel() {},
      }
    },
    close() {},
  }
}

function retryGateway(attempts: (string | undefined)[], reject: string[]) {
  return gatewayWith((options) => {
    const context = (
      options?.model as { params?: { id: string; value: string }[] } | undefined
    )?.params?.find((param) => param.id === 'context')?.value
    attempts.push(context)
    if (context !== undefined && reject.includes(context)) {
      throw new Error('invalid parameters for registry model claude')
    }
    return retryAgent()
  }).gateway
}

const retryRequest = (sessionId: string) =>
  request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], {
    sessionId: sessionId as never,
  })

test('a successful fallback tier is remembered for later conversations', async () => {
  const attempts: (string | undefined)[] = []
  const adapter = adapterOf(retryGateway(attempts, ['1m']))
  await collect(adapter, retryRequest('retry-one'))
  await collect(adapter, retryRequest('retry-two'))
  assert.deepEqual(attempts, ['1m', '200k', '200k'])
})

test('a failed fallback is not remembered', async () => {
  const attempts: (string | undefined)[] = []
  const adapter = adapterOf(retryGateway(attempts, ['1m', '200k']))
  const first = await collect(adapter, retryRequest('fail-one'))
  assert.equal(
    (first.find((c) => c.type === 'finish')?.reason as { kind?: string })?.kind,
    'error',
  )
  await collect(adapter, retryRequest('fail-two'))
  assert.deepEqual(attempts, ['1m', '200k', '1m', '200k'])
})

test('cancelling while the catalog loads ends the request without an agent', async () => {
  let resolveModels!: (models: unknown) => void
  const { gateway, agents } = gatewayWith(() => ({
    async send() {
      throw new Error('must not send')
    },
    close() {},
  }))
  const adapter = adapterOf(gateway)
  gateway.listModels = () =>
    new Promise((resolve) => {
      resolveModels = resolve as never
    })
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
  await delay(20)
  controller.abort()
  await stream
  assert.equal(agents.length, 0)
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
  resolveModels(CATALOG)
})

test('cancelling during a fallback create sends nothing', async () => {
  const firstSend = { count: 0 }
  let resolveSecond!: (agent: CursorAgent) => void
  let secondClosed = 0
  const secondAgent: CursorAgent = {
    async send() {
      throw new Error('must not send after abort')
    },
    close() {
      secondClosed += 1
    },
  }
  const firstAgent: CursorAgent = {
    async send() {
      firstSend.count += 1
      return {
        async *stream() {},
        async wait() {
          return {
            status: 'error',
            error: { message: 'invalid parameters for registry model claude' },
          }
        },
        async cancel() {},
      }
    },
    close() {},
  }
  const { gateway } = gatewayWith((options) => {
    const context = (
      options?.model as { params?: { id: string; value: string }[] } | undefined
    )?.params?.find((param) => param.id === 'context')?.value
    if (context === '1m') return firstAgent
    return new Promise<CursorAgent>((resolve) => {
      resolveSecond = resolve
    }) as never
  })
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
  await waitFor(() => chunks.length > 0 || firstSend.count > 0)
  await delay(20)
  controller.abort()
  resolveSecond(secondAgent)
  await stream
  assert.equal(firstSend.count, 1)
  assert.equal(secondClosed, 1)
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
})

test('a failed prewarm send closes its agent once', async () => {
  let closed = 0
  const runtime = new CursorRuntime({
    gateway: {
      async createAgent() {
        return {
          async send() {
            throw new Error('send failed')
          },
          close() {
            closed += 1
          },
        }
      },
      async deleteAgent() {},
      async listModels() {
        return CATALOG
      },
    },
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    contextPreference: () => 'max',
    keyRef: 'CURSOR_API_KEY',
  })
  runtime.prewarm('crsr_test', 'claude-sonnet-5-5')
  await delay(50)
  assert.equal(closed, 1)
})

test('disposal during a pending prewarm send closes its agent once', async () => {
  let closed = 0
  let rejectSend!: (error: Error) => void
  const runtime = new CursorRuntime({
    gateway: {
      async createAgent() {
        return {
          async send() {
            return await new Promise((_, reject) => {
              rejectSend = reject
            })
          },
          close() {
            closed += 1
          },
        }
      },
      async deleteAgent() {},
      async listModels() {
        return CATALOG
      },
    },
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    contextPreference: () => 'max',
    keyRef: 'CURSOR_API_KEY',
  })
  runtime.prewarm('crsr_test', 'claude-sonnet-5-5')
  await delay(20)
  runtime.dispose()
  await delay(10)
  rejectSend(new Error('send failed after dispose'))
  await delay(50)
  assert.equal(closed, 1)
})
