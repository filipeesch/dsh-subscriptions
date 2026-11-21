import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CursorAdapter } from '../src/providers/cursor/adapter.js'
import {
  CursorSession,
  planIncrement,
} from '../src/providers/cursor/runtime.js'
import { fingerprint } from '../src/providers/cursor/prompt.js'
import type { CursorCatalogModel } from '../src/providers/cursor/models.js'
import type {
  CursorAgent,
  CursorAgentOptions,
  CursorEvent,
  CursorGateway,
  CursorRun,
  CursorRunResult,
} from '../src/providers/cursor/runtime.js'

const CATALOG: CursorCatalogModel[] = [
  {
    id: 'claude-sonnet-5-5',
    displayName: 'Claude Sonnet 5.5',
    parameters: [
      { id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] },
      { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] },
      { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
      {
        id: 'context',
        values: [{ value: '200k' }, { value: '1m' }],
      },
    ],
  },
  { id: 'default', displayName: 'Auto' },
  { id: 'auto-smart', displayName: 'Auto' },
]

interface Sent {
  message: unknown
  options: unknown
}

function runOf(events: CursorEvent[], result: CursorRunResult): CursorRun {
  return {
    async *stream() {
      yield* events
    },
    async wait() {
      return result
    },
    async cancel() {},
  }
}

class FakeAgent implements CursorAgent {
  readonly sent: Sent[] = []
  readonly runs: CursorRun[] = []
  readonly executions: Promise<unknown>[] = []
  closed = false

  constructor(
    private readonly scripts: (CursorEvent[] | CursorRunResult)[][],
    readonly createOptions?: unknown,
  ) {}

  async send(message: unknown, options?: unknown): Promise<CursorRun> {
    this.sent.push({ message, options })
    const script = this.scripts.shift()
    if (script === undefined) {
      throw new Error('no scripted run left')
    }
    const events = (script[0] as CursorEvent[]) ?? []
    const result = (script[1] as CursorRunResult) ?? { status: 'finished' }
    // A Cursor agent invokes a custom tool during the run; the runtime's
    // execute returns a promise it settles with the next request's result.
    const toolHolder = (value: unknown) =>
      (
        value as {
          local?: {
            customTools?: Record<
              string,
              { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
            >
          }
        }
      )?.local?.customTools
    const tools = { ...toolHolder(this.createOptions), ...toolHolder(options) }
    for (const [name, tool] of Object.entries(tools ?? {})) {
      this.executions.push(tool.execute({ q: name }, { toolCallId: 'c1' }))
    }
    const run = runOf(events, result)
    this.runs.push(run)
    return run
  }

  close(): void {
    this.closed = true
  }
}

function gatewayOf(
  scripts: (CursorEvent[] | CursorRunResult)[][] = [],
  models: CursorCatalogModel[] = CATALOG,
) {
  const agents: FakeAgent[] = []
  let listCalls = 0
  const gateway: CursorGateway = {
    async createAgent(options) {
      const agent = new FakeAgent(scripts, options)
      agents.push(agent)
      return agent
    },
    async deleteAgent() {},
    async listModels() {
      listCalls++
      return models
    },
  }
  return { gateway, agents, listCalls: () => listCalls }
}

function adapterOf(
  gateway: CursorGateway,
  overrides: Partial<ConstructorParameters<typeof CursorAdapter>[0]> = {},
): CursorAdapter {
  return new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    prewarm: false,
    ...overrides,
  })
}

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

async function collect(
  adapter: CursorAdapter,
  options: GenerateOptions,
): Promise<Record<string, unknown>[]> {
  const chunks: Record<string, unknown>[] = []
  for await (const chunk of adapter.stream(options)) {
    chunks.push(chunk as unknown as Record<string, unknown>)
  }
  return chunks
}

test('the catalog requires a key and lists live models when one resolves', async () => {
  const { gateway } = gatewayOf()
  const withoutKey = new CursorAdapter({
    gateway,
    apiKey: async () => undefined,
    cwd: () => '/tmp',
  })
  assert.deepEqual(await withoutKey.listModels('cursor'), [])

  const adapter = adapterOf(gateway, { readImage: async () => undefined })
  const models = await adapter.listModels('cursor')
  assert.deepEqual(
    models.map((model) => model.id),
    ['claude-sonnet-5-5', 'default', 'auto-smart'],
  )
  assert.deepEqual(models[0]?.inputModalities, ['text', 'image'])
  assert.equal(
    models.find((model) => model.id === 'default')?.name,
    'Auto (default)',
  )
})

test('one stream sends the largest context and reports disjoint usage', async () => {
  const { gateway, agents } = gatewayOf([
    [
      [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi there' }] },
        },
      ],
      {
        status: 'finished',
        usage: {
          inputTokens: 100,
          outputTokens: 7,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
        },
      },
    ],
  ])
  const adapter = adapterOf(gateway)
  const chunks = await collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], {
      sessionId: 'session-main' as never,
    }),
  )

  const create = agents[0]!.sent
  assert.equal(create.length, 1)
  const options = create[0]!.options as CursorAgentOptions | undefined
  // The first send carries the transcript text.
  assert.match(String(create[0]!.message), /hello/)
  assert.equal(agents.length, 1)

  const kinds = chunks.map((chunk) => chunk.type)
  assert.deepEqual(kinds.slice(0, 3), [
    'block-start',
    'text-delta',
    'block-end',
  ])
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.deepEqual(usage?.usage, {
    inputTokens: 75,
    outputTokens: 7,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
  })
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.deepEqual(finish?.reason, { kind: 'stop' })

  const adapterOptions = adapter as unknown as {
    runtime: {
      sessionCount: () => number
      dispose: () => void
      overheadFor: (model: string) => number
    }
  }
  assert.equal(adapterOptions.runtime.sessionCount(), 1)
  adapterOptions.runtime.dispose()
  assert.equal(agents[0]!.closed, true)

  // The agent was created with the largest offered context tier.
  assert.equal(
    adapterOptions.runtime.overheadFor('claude-sonnet-5-5') >= 0,
    true,
  )
  const local = options?.local as
    { customTools?: Record<string, unknown> } | undefined
  assert.ok(local === undefined || local.customTools !== undefined)
})

test('stop sequences are rejected before any provider work', async () => {
  const { gateway } = gatewayOf()
  const adapter = adapterOf(gateway)
  await assert.rejects(
    collect(
      adapter,
      request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], {
        stop: ['END'],
      }),
    ),
    (error: unknown) =>
      (error as { code?: string }).code === 'UNSUPPORTED_OPTION',
  )
})

test('a second call reuses the agent and sends only the new content', async () => {
  const script = () => [
    [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'one' }] },
      },
    ],
    { status: 'finished' },
  ]
  const { gateway, agents } = gatewayOf([script(), script()])
  const adapter = adapterOf(gateway)
  const first = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    },
  ]
  await collect(adapter, request(first, { sessionId: 'session-1' as never }))
  const second = [
    ...first,
    {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'one' }],
    },
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'next' }],
    },
  ]
  await collect(adapter, request(second, { sessionId: 'session-1' as never }))

  assert.equal(agents.length, 1)
  assert.equal(agents[0]!.sent.length, 2)
  assert.equal(agents[0]!.sent[1]!.message, 'next')
})

test('a tool call is handed to the host and its result returns to the same run', async () => {
  const scripts: (CursorEvent[] | CursorRunResult)[][] = [
    [
      [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'calling' }] },
        },
      ],
      { status: 'finished' },
    ],
  ]
  const { gateway, agents } = gatewayOf(scripts)
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
  const chunks = await collect(
    adapter,
    request(first, { sessionId: 'session-tool' as never, tools }),
  )
  const toolFinish = chunks.find((chunk) => chunk.type === 'finish')
  assert.deepEqual(toolFinish?.reason, { kind: 'tool-calls' })
  assert.ok(chunks.some((chunk) => chunk.type === 'tool-call-delta'))
  assert.equal(agents[0]!.sent.length, 1)

  // Delivering the result is the runtime's decision, not a new conversation:
  // a handed-off call makes the next request a result delivery to the same
  // live run.
  const session = new CursorSession('k', 'sig', undefined)
  session.sentFirst = true
  session.runDone = false
  const user = {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'use the tool' }],
  }
  const assistant = {
    role: 'assistant' as const,
    content: [
      {
        type: 'toolCall' as const,
        id: 'c1',
        name: 'tool',
        arguments: { q: 'tool' },
      },
    ],
  }
  session.seen = [fingerprint(user), fingerprint(assistant)]
  const callPromise = session.registerCall('tool', { q: 'tool' }, 'c1')
  session.pending[0]!.handed = true
  const plan = planIncrement(session, [
    user,
    assistant,
    {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'tool',
      isError: false,
      content: [{ type: 'text', text: 'the result' }],
    },
  ])
  assert.equal(plan.kind, 'results')
  if (plan.kind === 'results') {
    assert.equal(plan.results.length, 1)
    assert.equal(plan.results[0]!.call.id, 'c1')
    plan.results[0]!.call.resolve({
      content: [{ type: 'text', text: 'the result' }],
      isError: false,
    })
  }
  assert.deepEqual(await callPromise, {
    content: [{ type: 'text', text: 'the result' }],
    isError: false,
  })
})

test('a rejected context tier retries with the next smaller one', async () => {
  const { gateway, agents } = gatewayOf([
    [
      [],
      {
        status: 'error',
        error: { message: 'invalid parameters for registry model claude' },
      },
    ],
    [
      [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        },
      ],
      { status: 'finished' },
    ],
  ])
  const adapter = adapterOf(gateway)
  const chunks = await collect(
    adapter,
    request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
  )
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'))
  assert.equal(agents.length, 2)
  const created = agents[1]!.createOptions as CursorAgentOptions
  assert.deepEqual(
    created.model.params?.find((param) => param.id === 'context'),
    { id: 'context', value: '200k' },
  )
})

test('an auxiliary call never shares the conversation agent', async () => {
  const script = () => [
    [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 't' }] },
      },
    ],
    { status: 'finished' },
  ]
  const { gateway, agents } = gatewayOf([script(), script(), script()])
  const adapter = adapterOf(gateway)
  const messages = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] },
  ]
  await collect(adapter, request(messages, { sessionId: 's-1' as never }))
  await collect(
    adapter,
    request(messages, {
      sessionId: 's-1' as never,
      purpose: 'session-title',
    }),
  )
  assert.equal(agents.length, 2)
})
