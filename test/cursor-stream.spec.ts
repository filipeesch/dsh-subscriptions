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
      { id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] },
      { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] },
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

test('a fallback agent survives the tool handoff and delivers the result', async () => {
  let createOptions: CursorAgentOptions | undefined
  const releases: (() => void)[] = []
  let sends = 0
  const executions: Promise<unknown>[] = []
  const firstAgent: CursorAgent = {
    async send() {
      sends += 1
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
  const secondAgent: CursorAgent = {
    async send() {
      sends += 1
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      releases.push(release)
      const tools = (
        createOptions as
          | {
              local?: {
                customTools?: Record<
                  string,
                  { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
                >
              }
            }
          | undefined
      )?.local?.customTools
      for (const tool of Object.values(tools ?? {})) {
        const execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
        executions.push(execution)
        // The run continues only after the host delivers the result.
        void execution.then(() => release())
      }
      return {
        async *stream() {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'calling' }] },
          }
          await gate
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'done' }] },
          }
        },
        async wait() {
          await gate
          return { status: 'finished' }
        },
        async cancel() {
          release()
        },
      }
    },
    close() {},
  }
  const { gateway } = gatewayWith((options) => {
    const context = (
      options?.model as { params?: { id: string; value: string }[] } | undefined
    )?.params?.find((param) => param.id === 'context')?.value
    if (context === '1m') return firstAgent
    createOptions = options
    return secondAgent
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
    request(first, { sessionId: 'fallback-tool' as never, tools }),
  )
  assert.deepEqual(firstChunks.find((c) => c.type === 'finish')?.reason, {
    kind: 'tool-calls',
  })
  assert.equal(executions.length, 1)

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
    request(second, { sessionId: 'fallback-tool' as never, tools }),
  )
  assert.equal(sends, 2, 'one rejected first send and one fallback send')
  assert.deepEqual(await executions[0], {
    content: [{ type: 'text', text: 'the result' }],
    isError: false,
  })
  assert.equal(
    (secondChunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'stop',
  )
})

test('an abort during a pending send finishes without waiting and cancels the late run', async () => {
  let resolveSend!: (run: CursorRun) => void
  let cancelled = 0
  const agent: CursorAgent = {
    async send() {
      return await new Promise<CursorRun>((resolve) => {
        resolveSend = resolve
      })
    },
    close() {},
  }
  const { gateway } = gatewayWith(() => agent)
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
  await stream
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
  resolveSend({
    async *stream() {},
    async wait() {
      return { status: 'finished' }
    },
    async cancel() {
      cancelled += 1
    },
  })
  await delay(20)
  assert.equal(cancelled, 1, 'a run that arrives after the abort is cancelled')
})

test('a model switch does not reuse the previous model agent', async () => {
  const created: string[] = []
  const sends: string[] = []
  const agentFor = (model: string): CursorAgent => ({
    async send() {
      sends.push(model)
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
  })
  const { gateway } = gatewayWith((options) => {
    const model = (options?.model as { id?: string } | undefined)?.id ?? '?'
    created.push(model)
    return agentFor(model)
  })
  const adapter = adapterOf(gateway)
  await collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'one' }] }], {
      model: 'claude-sonnet-5-5',
      sessionId: 'switch' as never,
    }),
  )
  await collect(
    adapter,
    request(
      [
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'two' }] },
      ],
      { model: 'gpt-5.6-sol', sessionId: 'switch' as never },
    ),
  )
  assert.deepEqual(created, ['claude-sonnet-5-5', 'gpt-5.6-sol'])
  assert.deepEqual(sends, ['claude-sonnet-5-5', 'gpt-5.6-sol'])
})

test('a rotated credential opens a new agent', async () => {
  const created: string[] = []
  let key = 'key-one'
  const agent = (): CursorAgent => ({
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
  })
  const { gateway } = gatewayWith(() => {
    created.push(key)
    return agent()
  })
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => key,
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    prewarm: false,
  })
  const base = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'one' }],
    },
  ]
  await collect(adapter, request(base, { sessionId: 'rotate' as never }))
  key = 'key-two'
  await collect(
    adapter,
    request(
      [
        ...base,
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'ok' }],
        },
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'two' }],
        },
      ],
      { sessionId: 'rotate' as never },
    ),
  )
  assert.deepEqual(created, ['key-one', 'key-two'])
})

test('a reasoning change opens a new agent', async () => {
  let creates = 0
  const agent = (): CursorAgent => ({
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
  })
  const { gateway } = gatewayWith(() => {
    creates += 1
    return agent()
  })
  const adapter = adapterOf(gateway)
  const base = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'one' }],
    },
  ]
  await collect(
    adapter,
    request(base, {
      sessionId: 'effort' as never,
      reasoningEffort: 'off' as never,
    }),
  )
  await collect(
    adapter,
    request(
      [
        ...base,
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'ok' }],
        },
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'two' }],
        },
      ],
      { sessionId: 'effort' as never, reasoningEffort: 'high' as never },
    ),
  )
  assert.equal(creates, 2)
})

test('a fallback learned during a handoff applies to the next conversation', async () => {
  const contexts: (string | undefined)[] = []
  const agentFor = (): CursorAgent => ({
    async send(message: unknown) {
      void message
      return {
        async *stream() {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
          }
          yield {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'continued' },
                { type: 'toolCall', id: 'c1', name: 'tool', arguments: {} },
              ],
            },
          }
        },
        async wait() {
          return { status: 'finished' }
        },
        async cancel() {},
      }
    },
    close() {},
  })
  const { gateway } = gatewayWith((options) => {
    contexts.push(
      (
        options?.model as
          { params?: { id: string; value: string }[] } | undefined
      )?.params?.find((param) => param.id === 'context')?.value,
    )
    const context = contexts[contexts.length - 1]
    if (context === '1m') {
      return {
        async send() {
          return {
            async *stream() {},
            async wait() {
              return {
                status: 'error',
                error: {
                  message: 'invalid parameters for registry model claude',
                },
              }
            },
            async cancel() {},
          }
        },
        close() {},
      }
    }
    return agentFor()
  })
  const adapter = adapterOf(gateway)
  await collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'one' }] }], {
      sessionId: 'learn' as never,
    }),
  )
  await collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'two' }] }], {
      sessionId: 'learn-two' as never,
    }),
  )
  assert.deepEqual(contexts, ['1m', '200k', '200k'])
})

test('cancelling a tool-change continuation sends no new prompt', async () => {
  let sends = 0
  let releaseWait!: () => void
  let createOptions: CursorAgentOptions | undefined
  const agent: CursorAgent = {
    async send(_message) {
      sends += 1
      const tools = (
        createOptions as
          | {
              local?: {
                customTools?: Record<
                  string,
                  { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
                >
              }
            }
          | undefined
      )?.local?.customTools
      for (const tool of Object.values(tools ?? {})) {
        void tool.execute({}, { toolCallId: 'c1' })
      }
      return {
        async *stream() {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'calling' }] },
          }
          await new Promise<void>((resolve) => {
            releaseWait = resolve
          })
        },
        async wait() {
          return { status: 'finished' }
        },
        async cancel() {},
      }
    },
    close() {},
  }
  const { gateway } = gatewayWith((options) => {
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
  const base = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'use it' }],
    },
  ]
  await collect(adapter, request(base, { sessionId: 'cont' as never, tools }))
  assert.equal(sends, 1)

  const addedTools = [
    ...tools,
    {
      name: 'tool2',
      description: 'Another',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const controller = new AbortController()
  const chunks: Chunk[] = []
  const stream = (async () => {
    for await (const chunk of adapter.stream(
      request(
        [
          ...base,
          {
            role: 'assistant' as const,
            content: [
              { type: 'text' as const, text: 'calling' },
              {
                type: 'tool-call' as const,
                id: 'c1',
                name: 'tool',
                arguments: {},
              },
            ],
          },
          {
            role: 'tool' as const,
            toolCallId: 'c1',
            content: [{ type: 'text' as const, text: 'r' }],
          },
        ],
        {
          sessionId: 'cont' as never,
          tools: addedTools,
          signal: controller.signal,
        },
      ),
    )) {
      chunks.push(chunk as unknown as Chunk)
    }
  })()
  await delay(20)
  controller.abort()
  releaseWait()
  await stream
  assert.equal(sends, 1, 'the cancelled continuation must not resend')
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
})

test('a cancelled create never closes the agent that replaced it', async () => {
  let created = 0
  const pending: ((agent: CursorAgent) => void)[] = []
  const closed: string[] = []
  const makeAgent = (name: string): CursorAgent => ({
    async send() {
      return {
        async *stream() {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: name }] },
          }
        },
        async wait() {
          return { status: 'finished' }
        },
        async cancel() {},
      }
    },
    close() {
      closed.push(name)
    },
  })
  const { gateway } = gatewayWith(() => makeAgent('unused'))
  gateway.createAgent = () => {
    created += 1
    const index = created
    return new Promise<CursorAgent>((resolve) => {
      pending.push((agent) => resolve(agent))
      void index
    })
  }
  const adapter = adapterOf(gateway)
  const controller = new AbortController()
  const first = collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'A' }] }], {
      sessionId: 'race' as never,
      signal: controller.signal,
    }),
  )
  const second = collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'B' }] }], {
      sessionId: 'race' as never,
    }),
  )
  await delay(20)
  assert.equal(created, 2)
  pending[1]!(makeAgent('B'))
  await second
  controller.abort()
  pending[0]!(makeAgent('A'))
  await first
  assert.deepEqual(closed, ['A'])
  // B stays open and serves the next turn.
  await collect(
    adapter,
    request(
      [
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'B' }],
        },
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'B' }],
        },
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'C' }],
        },
      ],
      { sessionId: 'race' as never },
    ),
  )
  assert.deepEqual(closed, ['A'])
})
