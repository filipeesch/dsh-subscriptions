import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CursorAdapter } from '../src/providers/cursor/adapter.js'
import { memoryCatalogStore, memoryTierStore } from './cursor-test-helpers.js'
import { CursorRuntime } from '../src/providers/cursor/runtime.js'
import { CursorSettingsStore } from '../src/providers/cursor-settings.js'
import { ChunkQueue, Reply } from '../src/providers/cursor/reply.js'
import { CursorSession } from '../src/providers/cursor/session.js'
import type {
  CursorRun,
  CursorRunStatus,
} from '../src/providers/cursor/session.js'
import type {
  CursorAgent,
  CursorAgentOptions,
  CursorEvent,
  CursorGateway,
  CursorRunResult,
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

function adapterOf(
  gateway: CursorGateway,
  overrides: Partial<ConstructorParameters<typeof CursorAdapter>[0]> = {},
): CursorAdapter {
  return new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
    ...memoryTierStore(),
    ...overrides,
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
    'aborted',
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
    catalogPersistence: memoryCatalogStore(),
    ...memoryTierStore(),
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
  const gate = new Promise<void>((resolve) => {
    releaseWait = resolve
  })
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
          await gate
        },
        // The run is suspended on a tool result, so it is not finished until the
        // test releases it: a finished run could not accept a tool result.
        async wait() {
          await gate
          return { status: 'finished' as const }
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

test('a superseded turn creates no agent and leaves the newer one open', async () => {
  let created = 0
  const closed: string[] = []
  const sends: string[] = []
  const makeAgent = (name: string): CursorAgent => ({
    async send() {
      sends.push(name)
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
    close() {
      closed.push(name)
    },
  })
  const { gateway } = gatewayWith(() => makeAgent('unused'))
  gateway.createAgent = async () => {
    created += 1
    return makeAgent(created === 1 ? 'A' : 'B')
  }
  const adapter = adapterOf(gateway)
  const first = collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'A' }] }], {
      sessionId: 'order' as never,
    }),
  )
  const second = collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'B' }] }], {
      sessionId: 'order' as never,
    }),
  )
  const [firstChunks] = await Promise.all([first, second])
  assert.equal(
    (firstChunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
  // The newer turn is the only one that created, and it stays open.
  assert.equal(created, 1)
  assert.deepEqual(closed, [])
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
          content: [{ type: 'text' as const, text: 'ok' }],
        },
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'C' }],
        },
      ],
      { sessionId: 'order' as never },
    ),
  )
  assert.equal(created, 1, 'the next turn reuses the newer agent')
  assert.equal(sends.length, 2)
})
test('an unload finishes an active turn without the SDK stream ending', async () => {
  const { gateway } = gatewayWith(() => ({
    async send() {
      return {
        async *stream() {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'working' }] },
          }
          await new Promise<void>(() => {
            /* never ends until the SDK cooperates */
          })
        },
        async wait() {
          return { status: 'finished' }
        },
        async cancel() {},
      }
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
  await waitFor(() => chunks.some((c) => c.type === 'text-delta'))
  adapter.dispose()
  await stream
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
})

test('an abort during a blocked create finishes before the create resolves', async () => {
  let resolveAgent!: (agent: CursorAgent) => void
  let closed = 0
  const { gateway } = gatewayWith(() => ({
    async send() {
      throw new Error('must not send')
    },
    close() {},
  }))
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
  await stream
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
    'the stream must end before the create resolves',
  )
  resolveAgent({
    async send() {
      throw new Error('must not send')
    },
    close() {
      closed += 1
    },
  })
  await delay(20)
  assert.equal(closed, 1)
})

test('a catalog refresh withdraws a learned tier from reuse', async () => {
  const contexts: (string | undefined)[] = []
  let sends = 0
  const agent = (): CursorAgent => ({
    async send() {
      sends += 1
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
  const gateway: CursorGateway = {
    async createAgent(options) {
      const context = (
        options.model as
          { params?: readonly { id: string; value: string }[] } | undefined
      )?.params?.find((param) => param.id === 'context')?.value
      contexts.push(context)
      if (context === '1m') {
        throw new Error('invalid parameters for registry model claude')
      }
      return agent()
    },
    async deleteAgent() {},
    async listModels() {
      return []
    },
  }
  const runtime = new CursorRuntime({
    gateway,
    apiKey: async () => 'crsr_key',
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    ...memoryTierStore(),
  })
  const catalog = (values: string[]) => ({
    id: 'claude-sonnet-5-5',
    displayName: 'Claude',
    parameters: [{ id: 'context', values: values.map((value) => ({ value })) }],
  })
  const drive = async (
    model: ReturnType<typeof catalog>,
    text: string,
    sessionId: string,
  ) => {
    const queue = new ChunkQueue()
    const reply = new Reply(queue)
    void runtime.runTurn({
      model,
      transcript: {
        systemPrompt: '',
        tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      },
      reply,
      sessionId,
    } as never)
    for await (const _chunk of queue) {
      // drain
    }
  }
  await drive(catalog(['1m', '200k']), 'one', 'catalog')
  await drive(catalog(['1m']), 'two', 'catalog')
  assert.deepEqual(contexts, ['1m', '200k', '1m'])
  assert.equal(sends, 1, 'the retired-tier agent is not reused')
})

test('an unload during a blocked create finishes aborted before it resolves', async () => {
  let resolveAgent!: (agent: CursorAgent) => void
  let closed = 0
  const { gateway } = gatewayWith(() => ({
    async send() {
      throw new Error('must not send')
    },
    close() {},
  }))
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
  await stream
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
    'unload must finish before the create resolves',
  )
  resolveAgent({
    async send() {
      throw new Error('must not send')
    },
    close() {
      closed += 1
    },
  })
  await delay(20)
  assert.equal(closed, 1)
})

test('an unload during a blocked send finishes aborted and cancels the late run', async () => {
  let resolveSend!: (run: CursorRun) => void
  let cancelled = 0
  const { gateway } = gatewayWith(() => ({
    async send() {
      return await new Promise<CursorRun>((resolve) => {
        resolveSend = resolve
      })
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
  await delay(20)
  adapter.dispose()
  await stream
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
    'unload must finish before the send resolves',
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
  assert.equal(cancelled, 1)
})

test('an older turn whose credentials resolve late cannot take over', async () => {
  let releaseKey!: (value: string) => void
  let keyCalls = 0
  let bSends = 0
  const bAgent: CursorAgent = {
    async send() {
      bSends += 1
      return {
        async *stream() {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'B' }] },
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
  const { gateway } = gatewayWith(() => bAgent)
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => {
      keyCalls += 1
      if (keyCalls === 1) return 'key-one'
      if (keyCalls === 2) {
        return await new Promise<string>((resolve) => {
          releaseKey = resolve
        })
      }
      return 'key-two'
    },
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
    ...memoryTierStore(),
  })
  // Warm the catalog with the immediate key so only turn credentials gate.
  await adapter.listModels('cursor')
  const first = collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'A' }] }], {
      sessionId: 'creds' as never,
    }),
  )
  const second = collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'B' }] }], {
      sessionId: 'creds' as never,
    }),
  )
  await delay(20)
  await second
  releaseKey('key-one')
  const firstChunks = await first
  assert.equal(
    (firstChunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
  assert.equal(bSends, 1)
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
      { sessionId: 'creds' as never },
    ),
  )
  assert.equal(bSends, 2)
})

test('an unload during catalog setup finishes aborted and dispatches nothing', async () => {
  let releaseKey!: (value: string) => void
  let modelsCalls = 0
  const { gateway } = gatewayWith(() => ({
    async send() {
      throw new Error('must not send')
    },
    close() {},
  }))
  gateway.listModels = async () => {
    modelsCalls += 1
    return CATALOG
  }
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () =>
      await new Promise<string>((resolve) => {
        releaseKey = resolve
      }),
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
    ...memoryTierStore(),
  })
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
  await stream
  assert.equal(
    (chunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
  releaseKey('key-one')
  await delay(20)
  assert.equal(modelsCalls, 0, 'no catalog request after disposal')
})

test('a newer turn interrupts an older dispatched send', async () => {
  let releaseSend!: (run: CursorRun) => void
  let cancelled = 0
  let streamed = 0
  let sends = 0
  const agent: CursorAgent = {
    async send() {
      sends += 1
      if (sends === 1) {
        return await new Promise<CursorRun>((resolve) => {
          releaseSend = resolve
        })
      }
      return {
        async *stream() {
          streamed += 1
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'B' }] },
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
  const { gateway } = gatewayWith(() => agent)
  const adapter = adapterOf(gateway)
  const first = collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'A' }] }], {
      sessionId: 'supersede-send' as never,
    }),
  )
  await delay(20)
  const second = collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'B' }] }], {
      sessionId: 'supersede-send' as never,
    }),
  )
  const firstChunks = await first
  await second
  assert.equal(
    (firstChunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
    'the older turn finishes before its send resolves',
  )
  releaseSend({
    async *stream() {
      streamed += 1
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'late' }] },
      }
    },
    async wait() {
      return { status: 'finished' }
    },
    async cancel() {
      cancelled += 1
    },
  })
  await delay(20)
  assert.equal(cancelled, 1, 'the late run is cancelled')
  assert.equal(streamed, 1, 'only the newer run was consumed')
})

test('a newer turn interrupts an older blocked create', async () => {
  let releaseCreate!: (agent: CursorAgent) => void
  let closed = 0
  let created = 0
  const { gateway } = gatewayWith(() => ({
    async send() {
      return {
        async *stream() {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'B' }] },
          }
        },
        async wait() {
          return { status: 'finished' }
        },
        async cancel() {},
      }
    },
    close() {},
  }))
  gateway.createAgent = async () => {
    created += 1
    if (created === 1) {
      return await new Promise<CursorAgent>((resolve) => {
        releaseCreate = resolve
      })
    }
    return {
      async send() {
        return {
          async *stream() {
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'B' }] },
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
  const adapter = adapterOf(gateway)
  const first = collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'A' }] }], {
      sessionId: 'supersede-create' as never,
    }),
  )
  await delay(20)
  const second = collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'B' }] }], {
      sessionId: 'supersede-create' as never,
    }),
  )
  const firstChunks = await first
  await second
  assert.equal(
    (firstChunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'aborted',
  )
  releaseCreate({
    async send() {
      throw new Error('must not send')
    },
    close() {
      closed += 1
    },
  })
  await delay(20)
  assert.equal(closed, 1)
})

test('closing the iterator during setup aborts before discovery is released', async () => {
  let releaseModels!: (models: unknown) => void
  let created = 0
  const { gateway } = gatewayWith(() => {
    created += 1
    return {
      async send() {
        throw new Error('must not send')
      },
      close() {},
    }
  })
  gateway.listModels = () =>
    new Promise((resolve) => {
      releaseModels = resolve as never
    })
  const adapter = adapterOf(gateway)
  const iterable = adapter.stream(
    request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
  )
  const iterator = iterable[Symbol.asyncIterator]()
  const first = iterator.next()
  await delay(20)
  const closed = await Promise.race([
    iterator.return?.() ?? Promise.resolve(),
    delay(200).then(() => 'timeout' as const),
  ])
  assert.notEqual(closed, 'timeout', 'return() must settle before discovery')
  releaseModels(CATALOG)
  await first
  assert.equal(created, 0)
})

test('a caller that joined discovery still receives it after the initiator aborts', async () => {
  let releaseModels!: (models: unknown) => void
  let calls = 0
  let created = 0
  const { gateway } = gatewayWith(() => {
    created += 1
    return {
      async send() {
        throw new Error('must not send')
      },
      close() {},
    }
  })
  gateway.listModels = async () => {
    calls += 1
    return await new Promise((resolve) => {
      releaseModels = resolve as never
    })
  }
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
  // The picker joins the in-flight discovery before the stream aborts.
  const picker = adapter.listModels('cursor')
  controller.abort()
  await stream
  releaseModels([{ id: 'a', displayName: 'A' }])
  const models = await picker
  assert.deepEqual(
    models.map((model) => model.id),
    ['a'],
    "a live joiner must not receive the aborted initiator's empty catalog",
  )
  assert.equal(calls, 1)
  assert.equal(created, 0)
})

test('an older reserved stream cannot run after a newer one finished', async () => {
  let created = 0
  const sends: string[] = []
  const { gateway } = gatewayWith(() => {
    created += 1
    const name = `agent-${created}`
    return {
      async send() {
        sends.push(name)
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
  })
  const adapter = adapterOf(gateway)
  // Both streams are reserved in call order, then consumed out of order.
  const first = adapter.stream(
    request([{ role: 'user', content: [{ type: 'text', text: 'A' }] }], {
      sessionId: 'reserved' as never,
    }),
  )
  const second = adapter.stream(
    request([{ role: 'user', content: [{ type: 'text', text: 'B' }] }], {
      sessionId: 'reserved' as never,
    }),
  )
  const drain = async (iterable: AsyncIterable<Chunk>) => {
    for await (const _chunk of iterable as AsyncIterable<Chunk>) {
      // drain
    }
  }
  await drain(second)
  await drain(first)
  assert.equal(created, 1, 'the older stream must not create an agent')
  assert.equal(sends.length, 1)
  await drain(
    adapter.stream(
      request(
        [
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'B' }],
          },
          {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: 'ok' }],
          },
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'C' }],
          },
        ],
        { sessionId: 'reserved' as never },
      ),
    ),
  )
  assert.equal(created, 1, 'the third turn reuses the newer agent')
  assert.equal(sends.length, 2)
})

test('early exits release their cancellation state', async () => {
  const { gateway } = gatewayWith(() => ({
    async send() {
      throw new Error('must not send')
    },
    close() {},
  }))
  // No credential: every turn returns before any provider work.
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => undefined,
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
    ...memoryTierStore(),
  })
  for (const session of ['a', 'b', 'c', 'd']) {
    await collect(
      adapter,
      request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], {
        sessionId: session as never,
      }),
    )
  }
  const runtime = (
    adapter as unknown as {
      runtime: { turnState(): { controllers: number; generations: number } }
    }
  ).runtime
  assert.equal(runtime.turnState().controllers, 0)
  adapter.dispose()
  assert.equal(runtime.turnState().generations, 0)
})

test('a standalone catalog read stops waiting when the adapter is disposed', async () => {
  let releaseModels!: (models: unknown) => void
  let keyCalls = 0
  const { gateway } = gatewayWith(() => ({
    async send() {
      throw new Error('must not send')
    },
    close() {},
  }))
  gateway.listModels = () =>
    new Promise((resolve) => {
      releaseModels = resolve as never
    })
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => {
      keyCalls += 1
      return 'crsr_test'
    },
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
    ...memoryTierStore(),
  })
  const picker = adapter.listModels('cursor')
  await delay(20)
  adapter.dispose()
  const settled = await Promise.race([
    picker,
    delay(300).then(() => 'timeout' as const),
  ])
  assert.notEqual(settled, 'timeout', 'disposal must settle the picker wait')
  releaseModels(CATALOG)
  await delay(20)
  const callsAfterDispose = keyCalls
  const after = await adapter.listModels('cursor')
  assert.deepEqual(after, [])
  assert.equal(keyCalls, callsAfterDispose, 'no credential read after disposal')
})

test('reservations are released for streams that never reach the runtime', async () => {
  const { gateway } = gatewayWith(() => ({
    async send() {
      throw new Error('must not send')
    },
    close() {},
  }))
  const adapter = adapterOf(gateway)
  const runtime = (
    adapter as unknown as {
      runtime: { turnState(): { reservations: number } }
    }
  ).runtime
  // Created and never iterated: closing it releases the reservation.
  const unopened = adapter.stream(
    request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], {
      sessionId: 'unopened' as never,
    }),
  )
  assert.equal(runtime.turnState().reservations, 1)
  await unopened[Symbol.asyncIterator]().return?.()
  assert.equal(runtime.turnState().reservations, 0)

  // A pre-aborted request releases it through the aborted finish.
  const controller = new AbortController()
  controller.abort()
  const aborted = adapter.stream(
    request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], {
      sessionId: 'aborted-stream' as never,
      signal: controller.signal,
    }),
  )
  for await (const _chunk of aborted) {
    // drain
  }
  assert.equal(runtime.turnState().reservations, 0)

  // An unsupported option throws out of the iterator and releases it too.
  const stopped = adapter.stream(
    request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], {
      sessionId: 'stopped-stream' as never,
      stop: ['END'],
    }),
  )
  await assert.rejects(async () => {
    for await (const _chunk of stopped) {
      // drain
    }
  })
  assert.equal(runtime.turnState().reservations, 0)
})

test('an abandoned reservation expires and cannot take ownership', async () => {
  const { gateway } = gatewayWith(() => ({
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
  }))
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
    ...memoryTierStore(),
    reservationTtlMs: 10,
  })
  const runtime = (
    adapter as unknown as {
      runtime: { turnState(): { reservations: number } }
    }
  ).runtime
  // Reserved and never opened: it must expire rather than take the session.
  adapter.stream(
    request([{ role: 'user', content: [{ type: 'text', text: 'old' }] }], {
      sessionId: 'expire' as never,
    }),
  )
  await delay(30)
  await collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'new' }] }], {
      sessionId: 'expire' as never,
    }),
  )
  assert.equal(runtime.turnState().reservations, 0)
})

test("expiry never takes an admitted turn's ownership", async () => {
  let releaseSlow!: () => void
  let created = 0
  const { gateway } = gatewayWith(() => {
    created += 1
    if (created === 1) {
      return {
        async send() {
          return {
            async *stream() {
              yield {
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'slow' }] },
              }
              await new Promise<void>((resolve) => {
                releaseSlow = resolve
              })
              yield {
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'done' }] },
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
    return {
      async send() {
        return {
          async *stream() {
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'fast' }] },
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
  })
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
    ...memoryTierStore(),
    reservationTtlMs: 10,
  })
  const slow = collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'slow' }] }], {
      sessionId: 'slow-session' as never,
    }),
  )
  await delay(30)
  // A turn in another session triggers the expiry sweep while slow is running.
  await collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'fast' }] }], {
      sessionId: 'other-session' as never,
    }),
  )
  releaseSlow()
  const slowChunks = await slow
  assert.equal(
    (slowChunks.find((c) => c.type === 'finish')?.reason as { kind?: string })
      ?.kind,
    'stop',
    'an admitted turn keeps its ownership past the reservation TTL',
  )
})

test('concurrent catalog callers share one discovery', async () => {
  let releaseModels!: (models: unknown) => void
  let calls = 0
  const { gateway } = gatewayWith(() => ({
    async send() {
      throw new Error('must not send')
    },
    close() {},
  }))
  gateway.listModels = async () => {
    calls += 1
    return await new Promise((resolve) => {
      releaseModels = resolve as never
    })
  }
  const adapter = adapterOf(gateway)
  const waiters = Array.from({ length: 4 }, () => adapter.listModels('cursor'))
  await delay(20)
  releaseModels([{ id: 'a', displayName: 'A' }])
  const results = await Promise.all(waiters)
  assert.equal(calls, 1)
  for (const models of results) {
    assert.deepEqual(
      models.map((model) => model.id),
      ['a'],
    )
  }
})

test('the catalog is read once inside its TTL and disposal stops further reads', async () => {
  const { gateway } = gatewayWith(() => ({
    async send() {
      throw new Error('must not send')
    },
    close() {},
  }))
  let calls = 0
  gateway.listModels = async () => {
    calls += 1
    return [{ id: 'a', displayName: 'A' }]
  }
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
    ...memoryTierStore(),
    catalogTtlMs: 60_000,
  })
  for (let index = 0; index < 5; index++) {
    const models = await adapter.listModels('cursor')
    assert.deepEqual(
      models.map((model) => model.id),
      ['a'],
      `refresh ${index} served the catalog`,
    )
  }
  assert.equal(calls, 1, 'a fresh catalog is not re-read')
  const before = calls
  adapter.dispose()
  // A disposed adapter keeps the last known catalog but never calls the SDK again.
  assert.deepEqual(
    (await adapter.listModels('cursor')).map((model) => model.id),
    ['a'],
  )
  assert.equal(calls, before)
})

test('the accepted tier is announced after a rejection and after a restart', async () => {
  const attempts: (string | undefined)[] = []
  const tiers = memoryTierStore()
  const adapter = adapterOf(retryGateway(attempts, ['1m']), tiers)
  assert.deepEqual(
    (await adapter.resolveModel('cursor', 'claude-sonnet-5-5')).context,
    { contextWindow: 1_000_000 },
  )
  await collect(adapter, retryRequest('announce-one'))
  assert.deepEqual(
    (await adapter.resolveModel('cursor', 'claude-sonnet-5-5')).context,
    { contextWindow: 200_000 },
    'the tier Cursor accepted is the one the host must meter',
  )
  // A restart reads the remembered tier from the same store.
  const restarted = adapterOf(retryGateway([], ['1m']), tiers)
  assert.deepEqual(
    (await restarted.resolveModel('cursor', 'claude-sonnet-5-5')).context,
    { contextWindow: 200_000 },
  )
})

test('a learned tier is visible immediately and survives a restart on disk', async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'cursor-tier-settings-')),
    'settings.json',
  )
  const store = new CursorSettingsStore(path)
  let writing: Promise<void> = Promise.resolve()
  const wiring = {
    acceptedTier: (modelId: string) => store.acceptedTier(modelId),
    rememberAcceptedTier: (modelId: string, value: string) => {
      writing = store.rememberAcceptedTier(modelId, value)
    },
    forgetAcceptedTier: (modelId: string) => {
      writing = store.forgetAcceptedTier(modelId)
    },
  }
  const attempts: (string | undefined)[] = []
  const adapter = adapterOf(retryGateway(attempts, ['1m']), wiring)
  await collect(adapter, retryRequest('tier-file'))
  // The same turn's end is followed by a resolution that already sees it.
  assert.deepEqual(
    (await adapter.resolveModel('cursor', 'claude-sonnet-5-5')).context,
    { contextWindow: 200_000 },
  )
  await writing
  const restarted = adapterOf(retryGateway([], ['1m']), wiring)
  assert.deepEqual(
    (await restarted.resolveModel('cursor', 'claude-sonnet-5-5')).context,
    { contextWindow: 200_000 },
    'the durable record decides the announced window after a restart',
  )
  assert.equal(
    new CursorSettingsStore(path).acceptedTier('claude-sonnet-5-5'),
    '200k',
  )
})

/* ---------------------------------------------------------------------------
 * Failure recovery, diagnostics, and the attempt budget.
 *
 * The gateway below scripts runs instead of agents, so a test can fail the
 * first attempt and answer the second, which is what the incident behind this
 * change looked like.
 * ------------------------------------------------------------------------- */

type ScriptedRun = {
  events?: CursorEvent[]
  result?: CursorRunResult
  /** Throw from send, the way a local failure before a run does. */
  sendThrows?: string
  /** Reject wait, the way a stream failure surfaces after the events. */
  waitThrows?: string
  /** Throw from the stream after its events, the way a broken transport ends. */
  streamThrows?: string
  /** Reject wait with a shaped error, the way a structured failure arrives. */
  waitThrowsError?: unknown
}

type ScriptedAgent = {
  sent: number
  closed: boolean
  messages: string[]
  options: CursorAgentOptions | undefined
}

/** Agents whose sends take the next script from one shared list. */
function scriptedGateway(scripts: ScriptedRun[]): {
  gateway: CursorGateway
  agents: ScriptedAgent[]
} {
  const agents: ScriptedAgent[] = []
  const queue = [...scripts]
  const gateway: CursorGateway = {
    async createAgent(options) {
      const record: ScriptedAgent = {
        sent: 0,
        closed: false,
        messages: [],
        options,
      }
      agents.push(record)
      return {
        async send(message) {
          record.sent += 1
          record.messages.push(
            typeof message === 'string'
              ? message
              : String((message as { text?: string }).text ?? ''),
          )
          const script = queue.shift()
          if (script === undefined) throw new Error('no scripted run left')
          if (script.sendThrows !== undefined)
            throw new Error(script.sendThrows)
          return {
            async *stream() {
              yield* script.events ?? []
              if (script.streamThrows !== undefined) {
                throw new Error(script.streamThrows)
              }
            },
            async wait() {
              if (script.waitThrowsError !== undefined) {
                throw script.waitThrowsError
              }
              if (script.waitThrows !== undefined) {
                throw new Error(script.waitThrows)
              }
              return script.result ?? { status: 'finished' }
            },
            async cancel() {},
          }
        },
        close() {
          record.closed = true
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  return { gateway, agents }
}

function finishOf(chunks: Chunk[]): { reason?: unknown } | undefined {
  return chunks.find((chunk) => chunk.type === 'finish') as
    { reason?: unknown } | undefined
}

const ASK = [
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] },
]

test('a failure before output opens a new agent and replays the turn', async () => {
  const { gateway, agents } = scriptedGateway([
    {
      result: {
        status: 'error',
        error: { message: 'local store open failed' },
      },
    },
    {
      events: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'recovered' }] },
        },
      ],
      result: { status: 'finished' },
    },
  ])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.ok(
    chunks.some(
      (chunk) =>
        chunk.type === 'text-delta' && String(chunk.text).includes('recovered'),
    ),
  )
  assert.deepEqual(finishOf(chunks)?.reason, { kind: 'stop' })
  // The failed agent is closed, and the replay sent the full history once.
  assert.equal(agents.length, 2)
  assert.equal(agents[0]!.closed, true)
  assert.equal(agents[1]!.sent, 1)
  assert.match(agents[1]!.messages[0]!, /hi/)
  // A recovered turn is not a failed turn: it logs nothing.
  assert.deepEqual(warnings, [])
})

test('a failed replay reports CURSOR_UNAVAILABLE and one warning', async () => {
  const failing: ScriptedRun = {
    result: {
      status: 'error',
      error: { message: 'local store open failed' },
    },
  }
  const { gateway, agents } = scriptedGateway([failing, failing])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_UNAVAILABLE',
    },
  })
  assert.equal(agents.length, 2)
  assert.deepEqual(warnings, [
    'Cursor failed before output (phase=run, cause=local): local store failure',
  ])
})

test('a failure after output is reported without a replay', async () => {
  const { gateway, agents } = scriptedGateway([
    {
      events: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial' }] },
        },
      ],
      result: { status: 'error', error: { message: 'run lost' } },
    },
  ])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.deepEqual(warnings, [
    'Cursor failed after output (phase=run, cause=local): agent state lost',
  ])
})

test('a rejected credential is reported once and never replayed', async () => {
  const { gateway, agents } = gatewayWith(() => ({
    async send() {
      throw new Error('401 Unauthorized')
    },
    close() {},
  }))
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.deepEqual(warnings, [
    'Cursor failed before output (phase=setup, cause=credential): credential rejected',
  ])
})

test('a resolved credential quoted in a failure never reaches the warning', async () => {
  const failing: ScriptedRun = {
    result: {
      status: 'error',
      error: { message: 'local store rejected crsr_test at /tmp' },
    },
  }
  const { gateway } = scriptedGateway([failing, failing])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  await collect(adapter, request([...ASK]))
  assert.deepEqual(warnings, [
    'Cursor failed before output (phase=run, cause=local): local store failure',
  ])
  assert.ok(!warnings[0]!.includes('crsr_test'))
})

test('a tier fallback and a replay stay within three attempts', async () => {
  const { gateway, agents } = scriptedGateway([
    {
      result: {
        status: 'error',
        error: { message: 'invalid parameters for registry model claude' },
      },
    },
    {
      result: {
        status: 'error',
        error: { message: 'local store open failed' },
      },
    },
    {
      events: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        },
      ],
      result: { status: 'finished' },
    },
  ])
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 3)
  assert.deepEqual(finishOf(chunks)?.reason, { kind: 'stop' })
})

test('a pre-output failure while continuing with new tools replays with the current tools', async () => {
  const steps: ('tool' | 'fail' | 'ok')[] = ['tool', 'fail', 'ok']
  const sent: string[] = []
  const agents: {
    sends: number
    closed: boolean
    options?: CursorAgentOptions
  }[] = []
  const toolsOf = (options: CursorAgentOptions | undefined) =>
    (
      options as
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
  let execution: Promise<unknown> | undefined
  const gateway: CursorGateway = {
    async createAgent(options) {
      const record = { sends: 0, closed: false, options }
      agents.push(record)
      return {
        async send(message) {
          record.sends += 1
          sent.push(
            typeof message === 'string'
              ? message
              : String((message as { text?: string }).text ?? ''),
          )
          const step = steps.shift()
          if (step === 'fail') throw new Error('local store open failed')
          if (step === 'tool') {
            for (const tool of Object.values(toolsOf(options) ?? {})) {
              execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
            }
            let cancelled = false
            let release!: () => void
            const gate = new Promise<void>((resolve) => {
              release = resolve
            })
            return {
              async *stream() {
                yield {
                  type: 'assistant',
                  message: { content: [{ type: 'text', text: 'calling' }] },
                }
              },
              async wait() {
                await Promise.race([execution, gate])
                return { status: cancelled ? 'cancelled' : 'finished' }
              },
              async cancel() {
                cancelled = true
                release()
              },
            }
          }
          return {
            async *stream() {
              yield {
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'continued' }] },
              }
            },
            async wait() {
              return { status: 'finished' }
            },
            async cancel() {},
          }
        },
        close() {
          record.closed = true
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
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
    request(first, { sessionId: 'session-tools-replay' as never, tools }),
  )
  assert.deepEqual(finishOf(firstChunks)?.reason, { kind: 'tool-calls' })

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
  // An added tool forces the run to restart, so the continuation send is the
  // attempt the replay has to recover.
  const moreTools = [
    ...tools,
    {
      name: 'other',
      description: 'Another tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const secondChunks = await collect(
    adapter,
    request(second, {
      sessionId: 'session-tools-replay' as never,
      tools: moreTools,
    }),
  )
  assert.ok(
    secondChunks.some(
      (chunk) =>
        chunk.type === 'text-delta' && String(chunk.text).includes('continued'),
    ),
  )
  assert.equal(agents.length, 2)
  assert.equal(agents[0]!.closed, true)
  // The continuation that failed already carried the tool result, and the
  // replay carries it once per payload. Whether Cursor's service accepted the
  // failed attempt is not observable here; the route sends, it does not confirm.
  assert.ok(sent[1]!.includes('the result'))
  const replaySend = sent[2]!
  assert.equal(replaySend.split('the result').length - 1, 1)
  // The replay registered the request's current tools, both of them.
  const replayedTools = (
    agents[1]!.options as
      { local?: { customTools?: Record<string, unknown> } } | undefined
  )?.local?.customTools
  assert.deepEqual(Object.keys(replayedTools ?? {}).sort(), ['other', 'tool'])
  assert.deepEqual(warnings, [])
})

/* ---------------------------------------------------------------------------
 * Wall-clock lifetime.
 *
 * The clock is injected, so these tests advance time instead of waiting, and
 * the periodic sweep is disabled so each case sweeps by hand.
 * ------------------------------------------------------------------------- */

async function driveTurn(
  runtime: CursorRuntime,
  sessionId: string,
  text: string,
  tools: unknown[] = [],
  history: unknown[] = [],
): Promise<Chunk[]> {
  const queue = new ChunkQueue()
  const reply = new Reply(queue)
  const messages =
    history.length > 0
      ? history
      : [{ role: 'user', content: [{ type: 'text', text }] }]
  const turn = runtime.runTurn({
    model: { id: 'claude-sonnet-5-5' },
    transcript: {
      systemPrompt: '',
      tools,
      messages,
    },
    reply,
    sessionId,
  } as never)
  const chunks: Chunk[] = []
  for await (const chunk of queue) chunks.push(chunk as unknown as Chunk)
  await turn
  return chunks
}

function answer(text: string): CursorRun {
  return {
    async *stream() {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
      }
    },
    async wait() {
      return { status: 'finished' }
    },
    async cancel() {},
  }
}

test('an agent past its budget is not reused', async () => {
  let clock = 0
  const agents: CursorAgent[] = []
  const runtime = new CursorRuntime({
    gateway: {
      async createAgent() {
        const agent: CursorAgent = {
          async send() {
            return answer('ok')
          },
          close() {},
        }
        agents.push(agent)
        return agent
      },
      async deleteAgent() {},
      async listModels() {
        return CATALOG
      },
    },
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    now: () => clock,
    sweepIntervalMs: 0,
  })
  try {
    // The conversation grows the way DSH sends it: history plus the new turn.
    const history: Record<string, unknown>[] = []
    const run = async (text: string) => {
      history.push({ role: 'user', content: [{ type: 'text', text }] })
      await driveTurn(runtime, 'session-stale', text, [], history)
      history.push({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      })
    }
    await run('one')
    assert.equal(agents.length, 1)
    // Inside the budget the agent answers the next turn.
    clock += 19 * 60_000
    await run('two')
    assert.equal(agents.length, 1)
    // Past it, the same conversation gets a new agent instead.
    clock += 21 * 60_000
    await run('three')
    assert.equal(agents.length, 2)
  } finally {
    runtime.dispose()
  }
})

test('the sweep closes an idle agent and leaves a busy one alone', async () => {
  let clock = 0
  const closed: number[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = new CursorRuntime({
    gateway: {
      async createAgent() {
        return {
          async send() {
            return {
              async *stream() {
                yield {
                  type: 'assistant',
                  message: { content: [{ type: 'text', text: 'live' }] },
                }
                await gate
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
          close() {
            closed.push(1)
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
    keyRef: 'CURSOR_API_KEY',
    now: () => clock,
    sweepIntervalMs: 0,
  })
  try {
    const queue = new ChunkQueue()
    const reply = new Reply(queue)
    const turn = runtime.runTurn({
      model: { id: 'claude-sonnet-5-5' },
      transcript: {
        systemPrompt: '',
        tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
      reply,
      sessionId: 'session-busy',
    } as never)
    const chunks: Chunk[] = []
    const draining = (async () => {
      for await (const chunk of queue) chunks.push(chunk as unknown as Chunk)
    })()
    await waitFor(() => chunks.some((chunk) => chunk.type === 'text-delta'))
    // A run longer than the budget keeps its agent.
    clock += 40 * 60_000
    runtime.sweepNow()
    assert.equal(runtime.sessionCount(), 1)
    assert.deepEqual(closed, [])
    release()
    await draining
    await turn
    // Once the turn is over the sweep may take it.
    clock += 21 * 60_000
    runtime.sweepNow()
    assert.equal(runtime.sessionCount(), 0)
    assert.equal(closed.length, 1)
  } finally {
    runtime.dispose()
  }
})

test('a pending tool call keeps the longer idle budget', async () => {
  let clock = 0
  let execution: Promise<unknown> | undefined
  let createOptions: CursorAgentOptions | undefined
  const runtime = new CursorRuntime({
    gateway: {
      async createAgent(options) {
        createOptions = options
        return {
          async send() {
            const tools = (
              createOptions as
                | {
                    local?: {
                      customTools?: Record<
                        string,
                        {
                          execute: (
                            args: unknown,
                            ctx: unknown,
                          ) => Promise<unknown>
                        }
                      >
                    }
                  }
                | undefined
            )?.local?.customTools
            for (const tool of Object.values(tools ?? {})) {
              execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
            }
            return {
              async *stream() {
                yield {
                  type: 'assistant',
                  message: { content: [{ type: 'text', text: 'calling' }] },
                }
              },
              async wait() {
                await execution
                return { status: 'finished' }
              },
              async cancel() {},
            }
          },
          close() {},
        }
      },
      async deleteAgent() {},
      async listModels() {
        return CATALOG
      },
    },
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    keyRef: 'CURSOR_API_KEY',
    now: () => clock,
    sweepIntervalMs: 0,
  })
  try {
    const tools = [
      {
        name: 'tool',
        description: 'A tool',
        parameters: { type: 'object', properties: {} },
      },
    ]
    const chunks = await driveTurn(runtime, 'session-pending', 'go', tools)
    assert.deepEqual(finishOf(chunks)?.reason, { kind: 'tool-calls' })
    // Thirty minutes is past the idle budget but inside the pending one.
    clock += 30 * 60_000
    runtime.sweepNow()
    assert.equal(runtime.sessionCount(), 1)
    // Past the pending budget the agent goes.
    clock += 31 * 60_000
    runtime.sweepNow()
    assert.equal(runtime.sessionCount(), 0)
  } finally {
    runtime.dispose()
  }
})

test('a failed prewarm is retried on the next catalog read', async () => {
  let creates = 0
  const warnings: string[] = []
  const gateway: CursorGateway = {
    async createAgent() {
      creates += 1
      if (creates === 1) throw new Error('warmup refused')
      return {
        async send() {
          return answer('.')
        },
        close() {},
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const adapter = adapterOf(gateway, {
    prewarm: true,
    onWarn: (message) => warnings.push(message),
  })
  await adapter.listModels('cursor')
  await waitFor(() => creates === 1)
  assert.match(
    warnings[0] ?? '',
    /Cursor prewarm failed: Cursor failed while trying to warm the SDK\./,
  )
  // A later live read tries the warmup again instead of leaving it off.
  await adapter.refreshCatalog()
  await waitFor(() => creates === 2)
})

test('a finished turn never carries the fallback failure sentence', async () => {
  const { gateway } = scriptedGateway([
    {
      events: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'done' }] },
        },
      ],
      result: { status: 'finished' },
    },
  ])
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
  assert.deepEqual(finishOf(chunks)?.reason, { kind: 'stop' })
  assert.ok(
    !JSON.stringify(chunks).includes('Cursor turn ended without a result'),
  )
})

/* ---------------------------------------------------------------------------
 * Findings from the first review: structured credential errors, request text in
 * the warning, the tier a replay must keep, cancellation behind the pump, and
 * setup failures that never reached the runtime.
 * ------------------------------------------------------------------------- */

test('a structured authentication error is terminal and never replayed', async () => {
  const failure = Object.assign(new Error('API key is expired.'), {
    name: 'AuthenticationError',
    code: 'unauthenticated',
    status: 401,
  })
  const { gateway, agents } = gatewayWith(() => ({
    async send() {
      throw failure
    },
    close() {},
  }))
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.deepEqual(warnings, [
    'Cursor failed before output (phase=setup, cause=credential): credential rejected (AuthenticationError, code=unauthenticated, status=401)',
  ])
})

test('a run that reports a rejected credential is terminal and never replayed', async () => {
  const { gateway, agents } = scriptedGateway([
    {
      result: {
        status: 'error',
        error: {
          message: 'API key is expired.',
          code: 'unauthenticated',
          status: 401,
        },
      },
    },
  ])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.deepEqual(warnings, [
    'Cursor failed before output (phase=run, cause=credential): credential rejected (code=unauthenticated, status=401)',
  ])
})

test('the warning never carries request text the SDK echoes', async () => {
  const marker = 'PRIVATE TEST TRANSCRIPT MARKER'
  const failing: ScriptedRun = {
    result: {
      status: 'error',
      error: { message: 'Unable to parse prompt: ' + marker },
    },
  }
  const { gateway } = scriptedGateway([failing, failing])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: marker }] }]),
  )
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_UNAVAILABLE',
    },
  })
  assert.equal(warnings.length, 1)
  assert.ok(
    !warnings[0]!.includes(marker),
    'the request text never reaches the log',
  )
  // The detail is a reviewed literal: no part of the SDK message is printed.
  assert.ok(warnings[0]!.endsWith('unclassified failure'))
})

test('a replay keeps the tier a fallback already accepted', async () => {
  const { gateway, agents } = scriptedGateway([
    {
      result: {
        status: 'error',
        error: { message: 'invalid parameters for registry model claude' },
      },
    },
    { sendThrows: 'local store open failed' },
    {
      events: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        },
      ],
      result: { status: 'finished' },
    },
  ])
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  const contextOf = (agent: ScriptedAgent) =>
    (agent.options?.model.params ?? []).find((param) => param.id === 'context')
      ?.value
  assert.equal(agents.length, 3)
  assert.equal(contextOf(agents[0]!), '1m')
  // The fallback the first attempt learned survives the replay.
  assert.equal(contextOf(agents[1]!), '200k')
  assert.equal(contextOf(agents[2]!), '200k')
  assert.deepEqual(finishOf(chunks)?.reason, { kind: 'stop' })
})

test('a run whose wait rejects with a parameter rejection still falls back', async () => {
  const { gateway, agents } = scriptedGateway([
    { waitThrows: 'invalid parameters for registry model claude' },
    {
      events: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        },
      ],
      result: { status: 'finished' },
    },
  ])
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 2)
  const contextOf = (agent: ScriptedAgent) =>
    (agent.options?.model.params ?? []).find((param) => param.id === 'context')
      ?.value
  assert.equal(contextOf(agents[1]!), '200k')
  assert.deepEqual(finishOf(chunks)?.reason, { kind: 'stop' })
})

test('a cancellation behind the pump still ends aborted and drops the agent', async () => {
  const { gateway, agents } = scriptedGateway([
    { events: [], result: { status: 'finished' } },
  ])
  const adapter = adapterOf(gateway)
  const runtime = (adapter as unknown as { runtime: CursorRuntime }).runtime
  const controller = new AbortController()
  // Land the cancel exactly where the pump's decision is already made: the
  // recheck in the runtime, not the pump, is what has to catch it.
  ;(runtime as unknown as { pumpAttempt: () => Promise<unknown> }).pumpAttempt =
    async () => {
      controller.abort()
      return { kind: 'stop', result: undefined }
    }
  const chunks = await collect(
    adapter,
    request([...ASK], { signal: controller.signal }),
  )
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'aborted',
    failure: { message: 'Cursor run cancelled', code: 'ABORTED' },
  })
  assert.equal(agents[0]!.closed, true)
  assert.equal(runtime.sessionCount(), 0)
})

test('a rejected credential resolver ends the stream with the fixed failure', async () => {
  const { gateway, agents } = scriptedGateway([])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    apiKey: async () => {
      throw new Error('keychain locked for CURSOR_API_KEY')
    },
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 0)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.deepEqual(warnings, [
    'Cursor failed before output (phase=setup, cause=local): unclassified failure',
  ])
})

test('a reasoning-only failure is not replayed', async () => {
  const { gateway, agents } = scriptedGateway([
    {
      events: [{ type: 'thinking', text: 'pondering the request' }],
      result: { status: 'error', error: { message: 'run lost' } },
    },
  ])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.deepEqual(warnings, [
    'Cursor failed after output (phase=run, cause=local): agent state lost',
  ])
})

test('Reply.finish is one-shot and settled records it', () => {
  const reply = new Reply(new ChunkQueue())
  assert.equal(reply.settled, false)
  reply.finish('stop')
  assert.equal(reply.settled, true)
  // A second finish changes nothing: that is what makes the runtime's
  // not-settled guard the only thing that can publish the fallback sentence.
  reply.finish('error', 'second finish ignored')
  assert.equal(reply.errorMessage, undefined)
})

/* ---------------------------------------------------------------------------
 * Second review pass: both error signals decide the cause, a terminal run never
 * hands dead tool work to the host, and a broken stream is never a clean stop.
 * ------------------------------------------------------------------------- */

test('a run that throws and then reports a 401 is terminal, not retried', async () => {
  const { gateway, agents } = scriptedGateway([
    {
      streamThrows: 'fetch failed',
      result: {
        status: 'error',
        error: {
          message: 'the run failed',
          code: 'unauthenticated',
          status: 401,
        },
      },
    },
  ])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.match(warnings[0]!, /cause=credential/)
})

test('a structured 401 outranks parameter wording, so no tier is tried', async () => {
  const { gateway, agents } = scriptedGateway([
    {
      result: {
        status: 'error',
        error: {
          message: 'invalid parameters for registry model claude',
          status: 401,
        },
      },
    },
  ])
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
})

test('a run that ends during the handoff debounce hands no tool call', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let execution: Promise<unknown> | undefined
  let closed = false
  const gateway: CursorGateway = {
    async createAgent(options) {
      const tools = (
        options as {
          local?: {
            customTools?: Record<
              string,
              { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
            >
          }
        }
      )?.local?.customTools
      return {
        async send() {
          for (const tool of Object.values(tools ?? {})) {
            execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
          }
          return {
            async *stream() {
              // Nothing arrives: the run ends while the host would still be
              // within the parallel-call debounce.
            },
            async wait() {
              await gate
              return { status: 'error', error: { message: 'run lost' } }
            },
            async cancel() {},
          }
        },
        close() {
          closed = true
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const stream = collect(adapter, request([...ASK], { tools }))
  await waitFor(() => execution !== undefined)
  release()
  const chunks = await stream
  // The failure is pre-output and replayable, so the replay ran and the host may
  // retry the code afterwards.
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_UNAVAILABLE',
    },
  })
  // The host never received a tool call for a run that cannot take its result.
  assert.ok(!chunks.some((chunk) => chunk.type === 'tool-call-delta'))
  assert.equal(closed, true)
  assert.deepEqual(await execution, {
    content: [
      {
        type: 'text',
        text: 'The run ended before this tool call was delivered.',
      },
    ],
    isError: true,
  })
  assert.equal(warnings.length, 1)
})

test('a stream that breaks after an empty run is a failure, not a stop', async () => {
  const broken: ScriptedRun = {
    streamThrows: 'premature close',
    result: { status: 'finished' },
  }
  const { gateway, agents } = scriptedGateway([broken, broken])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 2)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_UNAVAILABLE',
    },
  })
  assert.match(
    warnings[0]!,
    /^Cursor failed before output \(phase=run, cause=local\)/,
  )
})

test('a stream that breaks after partial output is terminal', async () => {
  const { gateway, agents } = scriptedGateway([
    {
      events: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial' }] },
        },
      ],
      streamThrows: 'premature close',
      result: { status: 'finished' },
    },
  ])
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
})

/* ---------------------------------------------------------------------------
 * Third review pass: a rejected wait keeps its terminal evidence, a terminal
 * status withholds a tool call, an unprintable error still reports safely, and a
 * late tool callback settles instead of hanging.
 * ------------------------------------------------------------------------- */

test('a rejected wait keeps the credential evidence the stream lost', async () => {
  const { gateway, agents } = scriptedGateway([
    {
      streamThrows: 'fetch failed',
      waitThrowsError: Object.assign(new Error('the run failed'), {
        code: 'unauthenticated',
        status: 401,
      }),
    },
  ])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.match(warnings[0]!, /cause=credential/)
})

test('a terminal status before the stream ends hands no tool call', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let status: CursorRunStatus = 'running'
  let notify: ((next: CursorRunStatus) => void) | undefined
  let execution: Promise<unknown> | undefined
  let closed = false
  const gateway: CursorGateway = {
    async createAgent(options) {
      const tools = (
        options as {
          local?: {
            customTools?: Record<
              string,
              { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
            >
          }
        }
      )?.local?.customTools
      return {
        async send() {
          for (const tool of Object.values(tools ?? {})) {
            execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
          }
          return {
            get status() {
              return status
            },
            onDidChangeStatus(listener: (next: CursorRunStatus) => void) {
              notify = listener
              return () => {
                notify = undefined
              }
            },
            async *stream() {
              // Open until the test releases it; nothing is yielded.
              await gate
              yield* []
            },
            async wait() {
              await gate
              return { status: 'error', error: { message: 'run lost' } }
            },
            async cancel() {
              release()
            },
          }
        },
        close() {
          closed = true
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const streaming = collect(adapter, request([...ASK], { tools }))
  await waitFor(() => execution !== undefined)
  // The SDK reports the run terminal while its stream is still open.
  status = 'error'
  notify?.('error')
  await waitFor(() => (notify === undefined ? true : false), 100).catch(
    () => undefined,
  )
  release()
  const chunks = await streaming
  assert.ok(!chunks.some((chunk) => chunk.type === 'tool-call-delta'))
  assert.equal(closed, true)
  assert.deepEqual(await execution, {
    content: [
      {
        type: 'text',
        text: 'The run ended before this tool call was delivered.',
      },
    ],
    isError: true,
  })
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_UNAVAILABLE',
    },
  })
  assert.equal(warnings.length, 1)
})

test('an unprintable setup failure still reports safely', async () => {
  const { gateway, agents } = scriptedGateway([])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    apiKey: async () => {
      throw Object.create(null)
    },
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 0)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.deepEqual(warnings, [
    'Cursor failed before output (phase=setup, cause=local): unclassified failure',
  ])
})

test('a tool callback after close settles instead of hanging', async () => {
  const session = new CursorSession('session', 'signature', undefined)
  session.close()
  const result = await session.registerCall('tool', { q: 1 }, 'call-1')
  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'Cancelled by the host.' }],
    isError: true,
  })
  assert.equal(session.pending.length, 0)
})

/* ---------------------------------------------------------------------------
 * Fourth review pass: the credential test reads structured evidence instead of
 * digits, the settled run releases its listener, a terminal failure settles
 * without a stalled drain, and the attachment fallback keeps provider text out.
 * ------------------------------------------------------------------------- */

test('a number inside a local-store failure does not disable recovery', async () => {
  const { gateway, agents } = scriptedGateway([
    {
      result: {
        status: 'error',
        error: { message: 'local store open failed for run 40315' },
      },
    },
    {
      events: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        },
      ],
      result: { status: 'finished' },
    },
  ])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  // The replay succeeded, so the failure never reached the caller and left no
  // warning behind.
  assert.equal(agents.length, 2)
  assert.deepEqual(finishOf(chunks)?.reason, { kind: 'stop' })
  assert.deepEqual(warnings, [])
})

test('an actual 403 stays terminal', async () => {
  const { gateway, agents } = scriptedGateway([
    { result: { status: 'error', error: { message: 'HTTP 403 Forbidden' } } },
  ])
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(agents.length, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
})

test('a terminal failure settles without draining a stalled stream', async () => {
  let released = false
  let cancel!: () => void
  const stalled = new Promise<void>((resolve) => {
    cancel = () => {
      released = true
      resolve()
    }
  })
  let closed = false
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          return {
            get status() {
              return 'error' as const
            },
            readonly: undefined,
            onDidChangeStatus() {
              return () => {}
            },
            get error() {
              return {
                message: 'the run failed',
                code: 'unauthenticated',
                status: 401,
              }
            },
            async *stream() {
              // Blocked until the host cleans the run up.
              await stalled
              yield* []
            },
            async wait() {
              await stalled
              return { status: 'error' as const }
            },
            async cancel() {
              cancel()
            },
          }
        },
        close() {
          closed = true
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(released, true)
  assert.equal(closed, true)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.match(
    warnings[0]!,
    /^Cursor failed before output \(phase=run, cause=credential\)/,
  )
})

test('a reused agent releases each run listener exactly once', async () => {
  let subscribed = 0
  let unsubscribed = 0
  let active = 0
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          return {
            get status() {
              return 'running' as const
            },
            onDidChangeStatus() {
              subscribed += 1
              active += 1
              return () => {
                unsubscribed += 1
                active -= 1
              }
            },
            async *stream() {
              yield {
                type: 'assistant' as const,
                message: { content: [{ type: 'text', text: 'ok' }] },
              }
            },
            async wait() {
              return { status: 'finished' as const }
            },
            async cancel() {},
          }
        },
        close() {},
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const adapter = adapterOf(gateway)
  await collect(adapter, request([...ASK]))
  await collect(adapter, request([...ASK, { role: 'user', content: 'again' }]))
  assert.equal(subscribed, 2)
  assert.equal(unsubscribed, 2)
  assert.equal(active, 0)
})

test('an unreadable attachment logs a fixed warning, not the exception', async () => {
  const { gateway } = scriptedGateway([
    {
      events: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        },
      ],
      result: { status: 'finished' },
    },
  ])
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    readImage: async () => {
      throw new Error('key crsr_secret cannot read att_1234')
    },
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(
    adapter,
    request([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'att_1234',
              mediaType: 'image/png',
              bytes: 3,
              width: 1,
              height: 1,
            },
          },
        ],
      },
    ]),
  )
  assert.deepEqual(warnings, [
    'Cursor could not read an attached image; the request continues without it.',
  ])
  assert.deepEqual(finishOf(chunks)?.reason, { kind: 'stop' })
})

/* ---------------------------------------------------------------------------
 * Fifth review pass: terminal evidence collection is independent of stream
 * drainage, an unresolved failure is never replayed, the listener release is
 * shared and idempotent, and the proposal matches the shipped vocabulary.
 * ------------------------------------------------------------------------- */

/** An agent whose run is scripted step by step, for terminal-status cases. */
function plannedGateway(plan: {
  status: () => CursorRunStatus | undefined
  error?: () => unknown
  stream?: () => Promise<void>
  wait?: () => Promise<unknown>
  subscribe?: (listener: (status: CursorRunStatus) => void) => () => void
  cancel?: () => void
  close?: () => void
  onSend?: () => void
  onTool?: (result: Promise<unknown>) => void
  /** Events the stream hands over after the gate resolves. */
  lateEvents?: CursorEvent[]
}): CursorGateway {
  return {
    async createAgent(options) {
      const tools = (
        options as {
          local?: {
            customTools?: Record<
              string,
              { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
            >
          }
        }
      )?.local?.customTools
      return {
        async send() {
          plan.onSend?.()
          for (const tool of Object.values(tools ?? {})) {
            plan.onTool?.(tool.execute({ q: 'tool' }, { toolCallId: 'c1' }))
          }
          const run: CursorRun = {
            get status() {
              return plan.status()
            },
            async *stream() {
              await (plan.stream?.() ?? Promise.resolve())
              yield* plan.lateEvents ?? []
            },
            async wait() {
              const result = await (plan.wait?.() ??
                Promise.resolve({ status: 'finished' }))
              return result as never
            },
            async cancel() {
              plan.cancel?.()
            },
          }
          if (plan.error !== undefined) {
            Object.defineProperty(run, 'error', { get: plan.error })
          }
          if (plan.subscribe !== undefined) {
            run.onDidChangeStatus = plan.subscribe
          }
          return run
        },
        close() {
          plan.close?.()
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
}

test('a rejected wait wins over an open terminal stream', async () => {
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  let sends = 0
  const gateway = plannedGateway({
    status: () => 'error',
    error: () => new Error('fetch failed'),
    stream: () => open,
    wait: () =>
      Promise.resolve({
        status: 'error',
        error: {
          message: 'the run failed',
          code: 'unauthenticated',
          status: 401,
        },
      }),
    cancel: () => release(),
    close: () => release(),
    onSend: () => {
      sends += 1
    },
  })
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(sends, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.match(warnings[0]!, /cause=credential/)
})

test('a reachable wait rejection wins over an open terminal stream', async () => {
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  let sends = 0
  const gateway = plannedGateway({
    status: () => 'error',
    stream: () => open,
    wait: () =>
      Promise.reject(
        Object.assign(new Error('the run failed'), {
          code: 'unauthenticated',
          status: 401,
        }),
      ),
    cancel: () => release(),
    close: () => release(),
    onSend: () => {
      sends += 1
    },
  })
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(sends, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
})

test('an unresolved terminal failure is not replayed', async () => {
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  let sends = 0
  const gateway = plannedGateway({
    status: () => 'error',
    stream: () => open,
    wait: () => open,
    cancel: () => release(),
    close: () => release(),
    onSend: () => {
      sends += 1
    },
  })
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  // No evidence ever arrived, so the failure stays terminal instead of
  // gambling a retry on what the missing result might have said.
  assert.equal(sends, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.match(warnings[0]!, /cause=local/)
})

test('a throwing listener release cannot block cleanup', async () => {
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  let subscribes = 0
  let unsubscribes = 0
  let closed = false
  const gateway = plannedGateway({
    status: () => 'running',
    stream: () => open,
    wait: () => open,
    subscribe: () => {
      subscribes += 1
      return () => {
        unsubscribes += 1
        throw new Error('the SDK refused to detach')
      }
    },
    cancel: () => release(),
    close: () => {
      closed = true
      release()
    },
  })
  const adapter = adapterOf(gateway)
  const runtime = (adapter as unknown as { runtime: CursorRuntime }).runtime
  const controller = new AbortController()
  const streaming = collect(
    adapter,
    request([...ASK], { signal: controller.signal }),
  )
  await waitFor(() => subscribes === 1)
  controller.abort()
  const chunks = await streaming
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'aborted',
    failure: { message: 'Cursor run cancelled', code: 'ABORTED' },
  })
  assert.equal(unsubscribes, 1)
  assert.equal(closed, true)
  assert.equal(runtime.sessionCount(), 0)
})

/* ---------------------------------------------------------------------------
 * Sixth review pass: ambiguity gates every follow-up attempt and the retryable
 * code, a terminal result withholds the call, and the evidence wait is
 * interruptible by the turn's own cancellation.
 * ------------------------------------------------------------------------- */

test('an unresolved replay is not offered to the host', async () => {
  // The replay's own stream and result never settle; the cleanup below has
  // nothing to release, which is the point.
  const stuck = new Promise<void>(() => {})
  let sends = 0
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          sends += 1
          if (sends === 1) {
            // A resolved local failure: this attempt may be replayed.
            return {
              async *stream() {
                yield* []
              },
              async wait() {
                return {
                  status: 'error' as const,
                  error: { message: 'local store open failed' },
                }
              },
              async cancel() {},
            }
          }
          // The replay never reports its result.
          return {
            get status() {
              return 'error' as const
            },
            async *stream() {
              await stuck
              yield* []
            },
            async wait() {
              await stuck
              return { status: 'error' as const }
            },
            async cancel() {},
          }
        },
        close() {},
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  // Two sends: the resolved failure was replayed. The replay's evidence never
  // arrived, so the host is offered nothing.
  assert.equal(sends, 2)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.equal(warnings.length, 1)
})

test('an unresolved parameter failure tries no smaller tier', async () => {
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  let sends = 0
  const gateway = plannedGateway({
    status: () => 'error',
    error: () => ({ message: 'invalid parameters for registry model claude' }),
    stream: () => open,
    wait: () => open,
    cancel: () => release(),
    close: () => release(),
    onSend: () => {
      sends += 1
    },
  })
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  // The wording alone would have earned a smaller tier; the missing result
  // could still have been a rejection, so no second attempt runs.
  assert.equal(sends, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the selected model parameters.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
})

test('a terminal result withholds the call without a live status', async () => {
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  let closed = false
  let execution: Promise<unknown> | undefined
  const gateway = plannedGateway({
    // No live status and no listener: only the result says the run is over.
    status: () => undefined,
    stream: () => open,
    wait: () =>
      Promise.resolve({ status: 'error', error: { message: 'run lost' } }),
    cancel: () => release(),
    close: () => {
      closed = true
      release()
    },
    onTool: (result) => {
      execution = result
    },
  })
  const adapter = adapterOf(gateway)
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const chunks = await collect(adapter, request([...ASK], { tools }))
  assert.ok(!chunks.some((chunk) => chunk.type === 'tool-call-delta'))
  assert.equal(closed, true)
  assert.deepEqual(await execution, {
    content: [
      {
        type: 'text',
        text: 'The run ended before this tool call was delivered.',
      },
    ],
    isError: true,
  })
  // The stream could still have reported a rejection, so the failure stays
  // terminal instead of being offered for a retry.
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
})

test('a cancellation is not held behind the evidence deadline', async () => {
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  let closed = false
  const gateway = plannedGateway({
    status: () => 'error',
    stream: () => open,
    wait: () => open,
    cancel: () => release(),
    close: () => {
      closed = true
      release()
    },
  })
  const adapter = adapterOf(gateway)
  const controller = new AbortController()
  const started = Date.now()
  const running = collect(
    adapter,
    request([...ASK], { signal: controller.signal }),
  )
  setTimeout(() => controller.abort(), 25)
  const chunks = await running
  const elapsed = Date.now() - started
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'aborted',
    failure: { message: 'Cursor run cancelled', code: 'ABORTED' },
  })
  assert.equal(closed, true)
  // Well inside the one-second evidence deadline: the abort wins the wait.
  assert.ok(elapsed < 800, `cancellation took ${elapsed}ms`)
})

/* ---------------------------------------------------------------------------
 * Seventh review pass: one bounded drain deadline for terminal failures, a wake
 * is not proof of drainage, and a finished run still withholds tool calls while
 * its buffered output drains.
 * ------------------------------------------------------------------------- */

test('a wake mid-drain does not settle before the stream reports', async () => {
  let sends = 0
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          sends += 1
          return {
            get status() {
              return 'error' as const
            },
            async *stream() {
              // A text event wakes the pump 10 ms in; the decisive rejection
              // lands 30 ms later, still inside the drain deadline.
              await delay(10)
              yield {
                type: 'assistant' as const,
                message: { content: [{ type: 'text', text: 'busy' }] },
              }
              await delay(30)
              throw Object.assign(new Error('the run failed'), {
                code: 'unauthenticated',
                status: 401,
              })
            },
            async wait() {
              // The result reports only the weaker detail, and it arrives first.
              return {
                status: 'error' as const,
                error: { message: 'fetch failed' },
              }
            },
            async cancel() {},
          }
        },
        close() {},
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(sends, 1)
  // The stream's later rejection is the decisive evidence, and the wake that
  // published the text must not settle the failure without it.
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.match(warnings[0]!, /cause=credential/)
})

test('a handle-reported failure still waits for the stream to report', async () => {
  let release!: () => void
  const stuck = new Promise<void>((resolve) => {
    release = resolve
  })
  let sends = 0
  let threw = false
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          sends += 1
          return {
            get status() {
              return 'error' as const
            },
            async *stream() {
              // The stream rejects with the decisive evidence 40 ms after the
              // handle already said the run failed.
              await delay(40)
              threw = true
              yield* []
              throw Object.assign(new Error('the run failed'), {
                code: 'unauthenticated',
                status: 401,
              })
            },
            async wait() {
              await stuck
              return { status: 'error' as const }
            },
            async cancel() {
              release()
            },
          }
        },
        close() {
          release()
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(sends, 1)
  assert.equal(threw, true)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.match(warnings[0]!, /cause=credential/)
})

test('a finished handle hands no tool call but keeps its late text', async () => {
  let execution: Promise<unknown> | undefined
  const gateway = plannedGateway({
    status: () => 'finished',
    stream: () => delay(80),
    lateEvents: [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'late' }] },
      },
    ],
    wait: async () => {
      await delay(80)
      return { status: 'finished' }
    },
    onTool: (result) => {
      execution = result
    },
  })
  const adapter = adapterOf(gateway)
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const chunks = await collect(adapter, request([...ASK], { tools }))
  // The call is dead, the text is not.
  assert.ok(!chunks.some((chunk) => chunk.type === 'tool-call-delta'))
  assert.ok(
    chunks.some(
      (chunk) =>
        chunk.type === 'text-delta' && JSON.stringify(chunk).includes('late'),
    ),
  )
  assert.deepEqual(finishOf(chunks)?.reason, { kind: 'stop' })
  assert.deepEqual(await execution, {
    content: [
      {
        type: 'text',
        text: 'The run ended before this tool call was delivered.',
      },
    ],
    isError: true,
  })
})

test('a finished result hands no tool call without a live status', async () => {
  let execution: Promise<unknown> | undefined
  const gateway = plannedGateway({
    status: () => undefined,
    stream: () => delay(50),
    wait: () => Promise.resolve({ status: 'finished' }),
    onTool: (result) => {
      execution = result
    },
  })
  const adapter = adapterOf(gateway)
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const chunks = await collect(adapter, request([...ASK], { tools }))
  assert.ok(!chunks.some((chunk) => chunk.type === 'tool-call-delta'))
  assert.deepEqual(finishOf(chunks)?.reason, { kind: 'stop' })
  assert.deepEqual(await execution, {
    content: [
      {
        type: 'text',
        text: 'The run ended before this tool call was delivered.',
      },
    ],
    isError: true,
  })
})

/* ---------------------------------------------------------------------------
 * Eighth review pass: a rejection already on the session blocks the handoff, the
 * terminal decision reads every status source, the drain window reconsiders its
 * outcome on each wake, and calls that arrive during it are settled at once.
 * ------------------------------------------------------------------------- */

test('a rejected wait blocks the tool handoff', async () => {
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  let sends = 0
  let execution: Promise<unknown> | undefined
  let closed = false
  const gateway: CursorGateway = {
    async createAgent(options) {
      const tools = (
        options as {
          local?: {
            customTools?: Record<
              string,
              { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
            >
          }
        }
      )?.local?.customTools
      return {
        async send() {
          sends += 1
          for (const tool of Object.values(tools ?? {})) {
            execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
          }
          return {
            // The handle still says the run is going; only the result knows the
            // key was rejected.
            get status() {
              return 'running' as const
            },
            async *stream() {
              await open
              yield* []
            },
            async wait() {
              throw Object.assign(new Error('the run failed'), {
                code: 'unauthenticated',
                status: 401,
              })
            },
            async cancel() {
              release()
            },
          }
        },
        close() {
          closed = true
          release()
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const chunks = await collect(adapter, request([...ASK], { tools }))
  assert.equal(sends, 1)
  assert.ok(!chunks.some((chunk) => chunk.type === 'tool-call-delta'))
  assert.equal(closed, true)
  assert.deepEqual(await execution, {
    content: [
      {
        type: 'text',
        text: 'The run ended before this tool call was delivered.',
      },
    ],
    isError: true,
  })
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /cause=credential/)
})

test('a terminal notification is not masked by a running handle', async () => {
  let notify: ((status: CursorRunStatus) => void) | undefined
  let closed = false
  let execution: Promise<unknown> | undefined
  const gateway: CursorGateway = {
    async createAgent(options) {
      const tools = (
        options as {
          local?: {
            customTools?: Record<
              string,
              { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
            >
          }
        }
      )?.local?.customTools
      return {
        async send() {
          for (const tool of Object.values(tools ?? {})) {
            execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
          }
          // The listener reports the failure first; the getter keeps saying
          // `running`.
          setTimeout(() => notify?.('error'), 5)
          return {
            get status() {
              return 'running' as const
            },
            onDidChangeStatus(listener: (status: CursorRunStatus) => void) {
              notify = listener
              return () => {}
            },
            async *stream() {
              await new Promise<void>(() => {})
              yield* []
            },
            async wait() {
              await delay(20)
              return { status: 'error' as const }
            },
            async cancel() {},
          }
        },
        close() {
          closed = true
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const adapter = adapterOf(gateway)
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const chunks = await collect(adapter, request([...ASK], { tools }))
  assert.ok(!chunks.some((chunk) => chunk.type === 'tool-call-delta'))
  assert.equal(closed, true)
  assert.deepEqual(await execution, {
    content: [
      {
        type: 'text',
        text: 'The run ended before this tool call was delivered.',
      },
    ],
    isError: true,
  })
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
})

test('a cancelled result inside the window wins over the earlier error', async () => {
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  let sends = 0
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          sends += 1
          return {
            get status() {
              return 'error' as const
            },
            async *stream() {
              await open
              yield* []
            },
            async wait() {
              // The provider cancels the run while the pump drains it.
              await delay(30)
              return { status: 'cancelled' as const }
            },
            async cancel() {
              release()
            },
          }
        },
        close() {
          release()
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(sends, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'aborted',
    failure: { message: 'Cursor run cancelled', code: 'ABORTED' },
  })
})

test('a call arriving inside the window is settled at once', async () => {
  let release!: () => void
  // Released by the cleanup, not by the test: the failure path closes the agent.
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  let sends = 0
  let execution: Promise<unknown> | undefined
  const gateway: CursorGateway = {
    async createAgent(options) {
      const tools = (
        options as {
          local?: {
            customTools?: Record<
              string,
              { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
            >
          }
        }
      )?.local?.customTools
      return {
        async send() {
          sends += 1
          if (sends === 1) {
            return {
              get status() {
                return 'error' as const
              },
              async *stream() {
                // The iterator waits for a tool call that arrives during the
                // drain window, then ends once the pump settles it.
                await delay(20)
                for (const tool of Object.values(tools ?? {})) {
                  execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
                }
                await execution?.catch(() => undefined)
                yield* []
                await delay(10)
              },
              async wait() {
                return {
                  status: 'error' as const,
                  error: { message: 'local store open failed' },
                }
              },
              async cancel() {
                release()
              },
            }
          }
          release()
          return {
            async *stream() {
              // The gate is already open here; the replay delivers its text.
              await open
              yield {
                type: 'assistant' as const,
                message: { content: [{ type: 'text', text: 'ok' }] },
              }
            },
            async wait() {
              return { status: 'finished' as const }
            },
            async cancel() {},
          }
        },
        close() {
          release()
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const adapter = adapterOf(gateway)
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const chunks = await collect(adapter, request([...ASK], { tools }))
  // Settling the late call let the stream finish, so the local-store failure was
  // resolved and the turn could be replayed.
  assert.equal(sends, 2)
  assert.deepEqual(finishOf(chunks)?.reason, { kind: 'stop' })
})

/* ---------------------------------------------------------------------------
 * Ninth review pass: a stream failure wakes the pump before `wait()` settles, the
 * terminal union is resolved everywhere, and a retired run's callback cannot
 * touch the session.
 * ------------------------------------------------------------------------- */

test('a stream rejection settles without waiting for the result', async () => {
  let sends = 0
  let closed = false
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          sends += 1
          return {
            get status() {
              return 'running' as const
            },
            async *stream() {
              await delay(15)
              yield* []
              throw Object.assign(new Error('the run failed'), {
                code: 'unauthenticated',
                status: 401,
              })
            },
            // The result never settles: only the stream knows what happened.
            async wait() {
              await new Promise<void>(() => {})
              return { status: 'finished' as const }
            },
            async cancel() {},
          }
        },
        close() {
          closed = true
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(sends, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor rejected the API key while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /cause=credential/)
  assert.equal(closed, true)
})

test('a cancelled listener wins inside the drain window', async () => {
  let notify: ((status: CursorRunStatus) => void) | undefined
  let sends = 0
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          sends += 1
          setTimeout(() => notify?.('cancelled'), 30)
          return {
            get status() {
              return 'error' as const
            },
            onDidChangeStatus(listener: (status: CursorRunStatus) => void) {
              notify = listener
              return () => {}
            },
            async *stream() {
              // Stays open; the drain window is what ends the wait.
              await delay(200)
              yield* []
            },
            async wait() {
              // The result keeps saying the run failed.
              return {
                status: 'error' as const,
                error: { message: 'run lost' },
              }
            },
            async cancel() {},
          }
        },
        close() {},
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(sends, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'aborted',
    failure: { message: 'Cursor run cancelled', code: 'ABORTED' },
  })
})

test('a cancelled getter wins inside the drain window', async () => {
  let status: CursorRunStatus = 'error'
  let sends = 0
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          sends += 1
          setTimeout(() => {
            status = 'cancelled'
          }, 30)
          return {
            get status() {
              return status
            },
            async *stream() {
              // Stays open; the drain window is what ends the wait.
              await delay(200)
              yield* []
            },
            async wait() {
              return {
                status: 'error' as const,
                error: { message: 'run lost' },
              }
            },
            async cancel() {},
          }
        },
        close() {},
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  assert.equal(sends, 1)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'aborted',
    failure: { message: 'Cursor run cancelled', code: 'ABORTED' },
  })
})

test('a cancelled listener wins after the run settled', async () => {
  let notify: ((status: CursorRunStatus) => void) | undefined
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          return {
            get status() {
              return 'running' as const
            },
            onDidChangeStatus(listener: (status: CursorRunStatus) => void) {
              notify = listener
              return () => {}
            },
            async *stream() {
              await delay(10)
              notify?.('cancelled')
              yield* []
            },
            // The result still claims a clean finish.
            async wait() {
              return { status: 'finished' as const }
            },
            async cancel() {},
          }
        },
        close() {},
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const adapter = adapterOf(gateway)
  const chunks = await collect(adapter, request([...ASK]))
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'aborted',
    failure: { message: 'Cursor run cancelled', code: 'ABORTED' },
  })
})

test('a retired run cannot cancel the next one', async () => {
  let notifyOld: ((status: CursorRunStatus) => void) | undefined
  let sends = 0
  let execution: Promise<unknown> | undefined
  const gateway: CursorGateway = {
    async createAgent(options) {
      const tools = (
        options as {
          local?: {
            customTools?: Record<
              string,
              { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
            >
          }
        }
      )?.local?.customTools
      return {
        async send() {
          sends += 1
          if (sends === 1) {
            return {
              onDidChangeStatus(listener: (status: CursorRunStatus) => void) {
                notifyOld = listener
                return () => {}
              },
              async *stream() {
                yield {
                  type: 'assistant' as const,
                  message: { content: [{ type: 'text', text: 'first' }] },
                }
              },
              async wait() {
                return { status: 'finished' as const }
              },
              async cancel() {},
            }
          }
          // The second run is legitimate; the first run's listener delivers a
          // queued cancellation during its handoff debounce.
          setTimeout(() => notifyOld?.('cancelled'), 10)
          for (const tool of Object.values(tools ?? {})) {
            execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
          }
          return {
            async *stream() {
              // Stays open; the drain window is what ends the wait.
              await delay(200)
              yield* []
            },
            async wait() {
              await delay(200)
              return { status: 'finished' as const }
            },
            async cancel() {},
          }
        },
        close() {},
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const adapter = adapterOf(gateway)
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  await collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'go' }] }], {
      sessionId: 'reuse' as never,
      tools,
    }),
  )
  const second = collect(
    adapter,
    request(
      [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'first' }],
        },
        { role: 'user', content: [{ type: 'text', text: 'again' }] },
      ],
      { sessionId: 'reuse' as never, tools },
    ),
  )
  await waitFor(() => execution !== undefined)
  const chunks = await second
  // The legitimate call goes out; the retired run's cancellation is ignored.
  assert.ok(chunks.some((chunk) => chunk.type === 'tool-call-delta'))
})

/* ---------------------------------------------------------------------------
 * Tenth review pass: a recorded stream exception is a failed delivery on its own,
 * whatever the handle still claims and whatever the exception's cause.
 * ------------------------------------------------------------------------- */

test('a broken stream hands off no tool call', async () => {
  let sends = 0
  let execution: Promise<unknown> | undefined
  let closed = false
  const gateway: CursorGateway = {
    async createAgent(options) {
      const tools = (
        options as {
          local?: {
            customTools?: Record<
              string,
              { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
            >
          }
        }
      )?.local?.customTools
      return {
        async send() {
          sends += 1
          for (const tool of Object.values(tools ?? {})) {
            execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
          }
          return {
            get status() {
              return 'running' as const
            },
            async *stream() {
              await delay(15)
              yield* []
              throw new Error('stream_buffer_overflow')
            },
            async wait() {
              await new Promise<void>(() => {})
              return { status: 'finished' as const }
            },
            async cancel() {},
          }
        },
        close() {
          closed = true
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const chunks = await collect(adapter, request([...ASK], { tools }))
  assert.equal(sends, 1)
  assert.ok(!chunks.some((chunk) => chunk.type === 'tool-call-delta'))
  assert.equal(closed, true)
  assert.deepEqual(await execution, {
    content: [
      {
        type: 'text',
        text: 'The run ended before this tool call was delivered.',
      },
    ],
    isError: true,
  })
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.equal(warnings.length, 1)
  assert.match(
    warnings[0]!,
    /^Cursor failed before output \(phase=run, cause=local\)/,
  )
})

test('a broken stream without a tool still reports', async () => {
  let sends = 0
  let closed = false
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          sends += 1
          return {
            get status() {
              return 'running' as const
            },
            async *stream() {
              await delay(15)
              yield* []
              throw new Error('stream_buffer_overflow')
            },
            async wait() {
              await new Promise<void>(() => {})
              return { status: 'finished' as const }
            },
            async cancel() {},
          }
        },
        close() {
          closed = true
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  // The turn settles instead of waiting for a result that never comes.
  assert.equal(sends, 1)
  assert.equal(closed, true)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.equal(warnings.length, 1)
})

/* ---------------------------------------------------------------------------
 * Eleventh review pass: a nullish rejection is still a broken stream, so it can
 * neither hand off a tool call nor be reported as a clean stop.
 * ------------------------------------------------------------------------- */

test('a stream that throws undefined hands off no tool call', async () => {
  let sends = 0
  let execution: Promise<unknown> | undefined
  let closed = false
  const gateway: CursorGateway = {
    async createAgent(options) {
      const tools = (
        options as {
          local?: {
            customTools?: Record<
              string,
              { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
            >
          }
        }
      )?.local?.customTools
      return {
        async send() {
          sends += 1
          for (const tool of Object.values(tools ?? {})) {
            execution = tool.execute({ q: 'tool' }, { toolCallId: 'c1' })
          }
          return {
            async *stream() {
              await delay(15)
              yield* []
              // The iterator rejects with no value at all.
              throw undefined
            },
            async wait() {
              await new Promise<void>(() => {})
              return { status: 'finished' as const }
            },
            async cancel() {},
          }
        },
        close() {
          closed = true
        },
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const tools = [
    {
      name: 'tool',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const chunks = await collect(adapter, request([...ASK], { tools }))
  assert.equal(sends, 1)
  assert.ok(!chunks.some((chunk) => chunk.type === 'tool-call-delta'))
  assert.equal(closed, true)
  assert.deepEqual(await execution, {
    content: [
      {
        type: 'text',
        text: 'The run ended before this tool call was delivered.',
      },
    ],
    isError: true,
  })
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_RUN_FAILED',
    },
  })
  assert.equal(warnings.length, 1)
})

test('a stream that throws null is not a clean stop', async () => {
  let sends = 0
  const gateway: CursorGateway = {
    async createAgent() {
      return {
        async send() {
          sends += 1
          return {
            async *stream() {
              await delay(10)
              yield* []
              throw null
            },
            async wait() {
              return { status: 'finished' as const }
            },
            async cancel() {},
          }
        },
        close() {},
      }
    },
    async deleteAgent() {},
    async listModels() {
      return CATALOG
    },
  }
  const warnings: string[] = []
  const adapter = adapterOf(gateway, {
    onWarn: (message) => warnings.push(message),
  })
  const chunks = await collect(adapter, request([...ASK]))
  // The run settled with a replayable local failure and no output, so the turn
  // was replayed once; the failure is reported, never a clean stop.
  assert.equal(sends, 2)
  assert.deepEqual(finishOf(chunks)?.reason, {
    kind: 'error',
    failure: {
      message: 'Cursor failed while trying to run the model.',
      code: 'CURSOR_UNAVAILABLE',
    },
  })
  assert.equal(warnings.length, 1)
})
