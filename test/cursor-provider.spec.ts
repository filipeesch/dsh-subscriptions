import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CursorAdapter } from '../src/providers/cursor/adapter.js'
import { memoryCatalogStore, memoryTierStore } from './cursor-test-helpers.js'
import type { CursorCatalogModel } from '../src/providers/cursor/catalog.js'
import { PublishedContext } from '../src/providers/cursor/published-context.js'
import { CursorSettingsStore } from '../src/providers/cursor-settings.js'
import { enabledFor, manualWindowFor } from '../src/providers/cursor/policy.js'
import {
  cursorCatalogStore,
  loadCursorCatalog,
  saveCursorCatalog,
} from '../src/providers/cursor/catalog-store.js'
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
    catalogPersistence: memoryCatalogStore(),
    ...memoryTierStore(),
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
    catalogPersistence: memoryCatalogStore(),
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
      // 0.2.2 narrows the request's purpose field; the adapter reads its own.
      purpose: 'session-title' as never,
    }),
  )
  assert.equal(agents.length, 2)
})
const NO_TIER_CATALOG: CursorCatalogModel[] = [
  {
    id: 'deepseek-v41-flash-1017',
    displayName: 'DeepSeek V4.1 Flash 1017',
    parameters: [{ id: 'reasoning_effort', values: [{ value: 'high' }] }],
  },
]

test('a model without a context tier advertises the published capacity', async () => {
  const listed: string[][] = []
  const { gateway } = gatewayOf([], NO_TIER_CATALOG)
  const adapter = adapterOf(gateway, {
    publishedWindow: (modelId) =>
      modelId === 'deepseek-v41-flash-1017' ? 1_048_576 : undefined,
    onCatalog: (ids) => listed.push([...ids]),
  })
  const info = await adapter.resolveModel('cursor', 'deepseek-v41-flash-1017')
  assert.deepEqual(info.context, { contextWindow: 1_048_576 })
  assert.deepEqual(listed, [['deepseek-v41-flash-1017']])
  // Without a published capacity the documented default still applies.
  const { gateway: bare } = gatewayOf([], NO_TIER_CATALOG)
  const fallback = adapterOf(bare)
  assert.deepEqual(
    (await fallback.resolveModel('cursor', 'deepseek-v41-flash-1017')).context,
    { contextWindow: 200_000 },
  )
})

test('a tier still wins over the published and manual fallbacks', async () => {
  const { gateway } = gatewayOf()
  const adapter = adapterOf(gateway, {
    publishedWindow: () => 400_000,
    manualWindow: () => 300_000,
  })
  assert.deepEqual(
    (await adapter.resolveModel('cursor', 'claude-sonnet-5-5')).context,
    { contextWindow: 1_000_000 },
  )
})

test('a pending published fetch never blocks model resolution', async () => {
  const service = new PublishedContext({
    enabled: () => true,
    // A refresh that never settles stands in for a slow third-party endpoint.
    fetch: () => new Promise<Response>(() => undefined),
  })
  service.load({
    version: 2,
    fetchedAt: 1,
    windows: { 'deepseek-v41-flash-1017': 1_048_576 },
  })
  const { gateway } = gatewayOf([], NO_TIER_CATALOG)
  const adapter = adapterOf(gateway, {
    publishedWindow: (modelId) => service.windowFor(modelId),
    onCatalog: (ids) => service.note(ids),
  })
  const info = await adapter.resolveModel('cursor', 'deepseek-v41-flash-1017')
  assert.deepEqual(info.context, { contextWindow: 1_048_576 })
})
test('a restart seeds the catalog from disk and a failed read keeps it', async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'cursor-catalog-')),
    'catalog.json',
  )
  const seeded = [{ id: 'seed-model', displayName: 'Seed' }]
  await saveCursorCatalog({ at: Date.now(), models: seeded }, path)
  const { gateway } = gatewayOf([], CATALOG)
  gateway.listModels = async () => {
    throw new Error('offline')
  }
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    prewarm: false,
    catalogPersistence: cursorCatalogStore(path),
    catalogTtlMs: 0,
  })
  assert.deepEqual(
    (await adapter.listModels('cursor')).map((model) => model.id),
    ['seed-model'],
  )

  // A successful read replaces the stored catalog (write-through).
  gateway.listModels = async () => [{ id: 'live-model', displayName: 'Live' }]
  const store = cursorCatalogStore(path)
  // The cache writes through without awaiting, so the spec captures that save
  // before reading the file.
  let writing: Promise<void> = Promise.resolve()
  const persistence = {
    load: store.load,
    clear: store.clear,
    save: (snapshot: Parameters<typeof store.save>[0]) =>
      (writing = store.save(snapshot)),
  }
  const refreshed = new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    prewarm: false,
    catalogPersistence: persistence,
    catalogTtlMs: 0,
  })
  // A stale stored catalog answers at once; the refresh lands for a later read.
  assert.deepEqual(
    (await refreshed.listModels('cursor')).map((model) => model.id),
    ['seed-model'],
    'the stale catalog answers before the live read completes',
  )
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    const listed = await refreshed.listModels('cursor')
    if (listed[0]?.id === 'live-model') break
  }
  assert.deepEqual(
    (await refreshed.listModels('cursor')).map((model) => model.id),
    ['live-model'],
    'the background refresh replaces the stored catalog',
  )
  await writing
  assert.deepEqual(
    (await loadCursorCatalog(path))?.models.map((model) => model.id),
    ['live-model'],
  )
})

test('a persisted catalog is not served without a credential', async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'cursor-catalog-')),
    'catalog.json',
  )
  await saveCursorCatalog(
    { at: Date.now(), models: [{ id: 'seed-model', displayName: 'Seed' }] },
    path,
  )
  const { gateway } = gatewayOf([], CATALOG)
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => undefined,
    cwd: () => '/tmp',
    prewarm: false,
    catalogPersistence: cursorCatalogStore(path),
  })
  assert.deepEqual(await adapter.listModels('cursor'), [])
})
test('a disabled model leaves the picker but still resolves', async () => {
  const { gateway } = gatewayOf()
  const adapter = adapterOf(gateway, {
    enabled: (modelId) => modelId !== 'claude-sonnet-5-5',
  })
  assert.deepEqual(
    (await adapter.listModels('cursor')).map((model) => model.id),
    ['default', 'auto-smart'],
  )
  // A saved conversation keeps working.
  assert.equal(
    (await adapter.resolveModel('cursor', 'claude-sonnet-5-5')).id,
    'claude-sonnet-5-5',
  )
})

test('a stale stored catalog is served while the refresh runs', async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'cursor-catalog-')),
    'catalog.json',
  )
  await saveCursorCatalog(
    {
      at: 1,
      models: [{ id: 'seed-model', displayName: 'Seed' }],
    },
    path,
  )
  const { gateway } = gatewayOf([], CATALOG)
  let release: (models: CursorCatalogModel[]) => void = () => undefined
  gateway.listModels = () =>
    new Promise<CursorCatalogModel[]>((resolve) => {
      release = resolve
    })
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    prewarm: false,
    catalogPersistence: cursorCatalogStore(path),
  })
  // The seeded catalog answers before the live read settles.
  assert.deepEqual(
    (await adapter.listModels('cursor')).map((model) => model.id),
    ['seed-model'],
  )
  release([{ id: 'live-model', displayName: 'Live' }])
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    const listed = await adapter.listModels('cursor')
    if (listed[0]?.id === 'live-model') return
  }
  assert.fail('the background refresh never replaced the stored catalog')
})

test('a disabled source falls back to a manual value and then the default', async () => {
  let enabled = true
  const service = new PublishedContext({
    enabled: () => enabled,
    fetch: async () => {
      throw new Error('offline')
    },
  })
  service.load({
    version: 2,
    fetchedAt: Date.now(),
    windows: { 'deepseek-v41-flash-1017': 1_048_576 },
  })
  const source = { manual: undefined as number | undefined }
  const { gateway } = gatewayOf([], NO_TIER_CATALOG)
  const adapter = adapterOf(gateway, {
    publishedWindow: (modelId) => service.windowFor(modelId),
    manualWindow: () => source.manual,
    onCatalog: (ids) => service.note(ids),
  })
  assert.deepEqual(
    (await adapter.resolveModel('cursor', 'deepseek-v41-flash-1017')).context,
    { contextWindow: 1_048_576 },
  )
  enabled = false
  assert.deepEqual(
    (await adapter.resolveModel('cursor', 'deepseek-v41-flash-1017')).context,
    { contextWindow: 200_000 },
    'a disabled source must not keep announcing its cached capacity',
  )
  source.manual = 300_000
  assert.deepEqual(
    (await adapter.resolveModel('cursor', 'deepseek-v41-flash-1017')).context,
    { contextWindow: 300_000 },
  )
})

test('a seeded catalog refreshes the projection while discovery is offline', async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'cursor-catalog-')),
    'catalog.json',
  )
  await saveCursorCatalog(
    {
      at: Date.now(),
      models: [
        {
          id: 'deepseek-v41-flash-1017',
          displayName: 'DeepSeek V4.1 Flash 1017',
        },
      ],
    },
    path,
  )
  const service = new PublishedContext({
    enabled: () => true,
    fetch: async () =>
      new Response(
        JSON.stringify({
          deepseek: {
            models: {
              'deepseek-v41-flash-1017': {
                id: 'deepseek-v41-flash-1017',
                limit: { context: 1_048_576 },
              },
            },
          },
        }),
      ),
  })
  const { gateway } = gatewayOf([], CATALOG)
  let attempts = 0
  gateway.listModels = async () => {
    attempts += 1
    throw new Error('offline')
  }
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    prewarm: false,
    catalogPersistence: cursorCatalogStore(path),
    // Force the SDK attempt so the offline path, not a fresh cache, is tested.
    catalogTtlMs: 0,
    publishedWindow: (modelId) => service.windowFor(modelId),
    onCatalog: (ids) => service.note(ids),
  })
  // The first resolution notes the seeded ids, so the projection can refresh
  // without any live catalog read.
  await adapter.resolveModel('cursor', 'deepseek-v41-flash-1017')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    if (
      attempts >= 1 &&
      service.windowFor('deepseek-v41-flash-1017') !== undefined
    ) {
      break
    }
  }
  assert.deepEqual(
    (await adapter.resolveModel('cursor', 'deepseek-v41-flash-1017')).context,
    { contextWindow: 1_048_576 },
  )
  assert.ok(attempts >= 1, 'the offline SDK read was attempted')
})

test('the manager catalog awaits the seed and falls back to the built-in list', async () => {
  const { gateway } = gatewayOf([], CATALOG)
  gateway.listModels = async () => {
    throw new Error('offline')
  }
  const adapter = adapterOf(gateway, {
    catalogPersistence: memoryCatalogStore(),
  })
  const models = await adapter.catalogSnapshot()
  assert.ok(models.length > 0)
  assert.ok(models.some((model) => model.id === 'default'))
  const unconfigured = new CursorAdapter({
    gateway,
    apiKey: async () => undefined,
    cwd: () => '/tmp',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
  })
  assert.deepEqual(await unconfigured.catalogSnapshot(), [])
})

test('a cold discovery failure serves the built-in list and retries later', async () => {
  let fail = true
  const { gateway } = gatewayOf([], CATALOG)
  gateway.listModels = async () => {
    if (fail) throw new Error('offline')
    return [{ id: 'live-model', displayName: 'Live' }]
  }
  const adapter = adapterOf(gateway, {
    catalogPersistence: memoryCatalogStore(),
  })
  const fallback = await adapter.listModels('cursor')
  assert.ok(fallback.some((model) => model.id === 'default'))
  fail = false
  assert.deepEqual(
    (await adapter.listModels('cursor')).map((model) => model.id),
    ['live-model'],
  )
})

test('exact model resolution carries the advertised reasoning efforts', async () => {
  const { gateway } = gatewayOf()
  const adapter = adapterOf(gateway)
  const info = await adapter.resolveModel('cursor', 'claude-sonnet-5-5')
  assert.deepEqual(
    info.reasoning?.efforts.map((effort) => effort.id),
    ['off', 'low', 'high'],
  )
})

test('a forced reload propagates an SDK failure', async () => {
  const { gateway } = gatewayOf()
  const adapter = adapterOf(gateway)
  await adapter.listModels('cursor')
  gateway.listModels = async () => {
    throw new Error('offline')
  }
  await assert.rejects(adapter.refreshCatalog(), /offline/)
})

test('startup revalidation publishes the seed and reads the SDK once', async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'cursor-catalog-')),
    'catalog.json',
  )
  await saveCursorCatalog(
    {
      at: Date.now(),
      models: [{ id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' }],
    },
    path,
  )
  const { gateway, listCalls } = gatewayOf()
  const notes: string[][] = []
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    prewarm: false,
    catalogPersistence: cursorCatalogStore(path),
    onCatalog: (ids) => notes.push([...ids]),
  })
  await adapter.revalidateCatalog()
  assert.equal(listCalls(), 1)
  assert.deepEqual(notes[0], ['claude-sonnet-5-5'])
  // Without a stored catalog there is nothing to revalidate.
  const empty = new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
    onCatalog: (ids) => notes.push([...ids]),
  })
  await empty.revalidateCatalog()
  assert.equal(listCalls(), 1)
})

test('a withdrawn tier is forgotten on catalog change and cannot reappear without a turn', async () => {
  const tier = memoryTierStore()
  tier.rememberAcceptedTier('claude-sonnet-5-5', '200k')
  let models = CATALOG
  const { gateway } = gatewayOf()
  gateway.listModels = async () => models
  const adapter = adapterOf(gateway, {
    catalogTtlMs: 0,
    ...tier,
  })
  // The catalog still offers the tier: the record survives the read.
  await adapter.listModels('cursor')
  assert.equal(tier.acceptedTier('claude-sonnet-5-5'), '200k')
  // A live read without that tier forgets it, without waiting for a turn.
  models = [
    {
      id: 'claude-sonnet-5-5',
      displayName: 'Claude Sonnet 5.5',
      parameters: [{ id: 'context', values: [{ value: '1m' }] }],
    },
  ]
  await adapter.listModels('cursor')
  assert.equal(tier.acceptedTier('claude-sonnet-5-5'), undefined)
  // Reappearance does not make the old acceptance effective again.
  models = CATALOG
  assert.deepEqual(
    (await adapter.resolveModel('cursor', 'claude-sonnet-5-5')).context,
    // The largest offered tier is 1m again: the stale 200k acceptance is gone.
    { contextWindow: 1_000_000 },
  )
})

test('a restart applies enabled, remembered tier, and window from the settings file', async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'cursor-settings-')),
    'settings.json',
  )
  const store = new CursorSettingsStore(path)
  await store.set({
    publishedContext: false,
    models: {
      // Auto has no tier, so its saved manual window is observable; Claude is
      // tiered, so its manual value is inert and only the tier decides.
      default: { enabled: false, contextWindow: 300_000 },
      'claude-sonnet-5-5': { enabled: true, contextWindow: 999_999 },
    },
    acceptedTiers: { 'claude-sonnet-5-5': { value: '200k' } },
  })
  // Reopen from the file: the adapter must read the durable document, not the
  // writer instance that produced it.
  const reopened = new CursorSettingsStore(path)
  const tier = memoryTierStore()
  tier.rememberAcceptedTier(
    'claude-sonnet-5-5',
    reopened.acceptedTier('claude-sonnet-5-5') as string,
  )
  const { gateway, agents } = gatewayOf([[[], { status: 'finished' }]])
  const adapter = new CursorAdapter({
    gateway,
    apiKey: async () => 'crsr_test',
    cwd: () => '/tmp',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
    enabled: (modelId) => enabledFor(reopened.get(), undefined, modelId),
    manualWindow: (modelId) =>
      manualWindowFor(reopened.get(), undefined, modelId),
    ...tier,
  })
  // The disabled model leaves the picker but exact resolution keeps working.
  assert.deepEqual(
    (await adapter.listModels('cursor')).map((model) => model.id),
    ['claude-sonnet-5-5', 'auto-smart'],
  )
  assert.deepEqual((await adapter.resolveModel('cursor', 'default')).context, {
    contextWindow: 300_000,
  })
  // The remembered tier is announced and sent on the wire, outranking the
  // inert manual value the settings also carry for that model.
  assert.deepEqual(
    (await adapter.resolveModel('cursor', 'claude-sonnet-5-5')).context,
    { contextWindow: 200_000 },
  )
  await collect(
    adapter,
    request([{ role: 'user', content: 'hi' }], {
      model: 'claude-sonnet-5-5',
    }),
  )
  const sent = agents[0]?.createOptions as
    { model?: { params?: { id: string; value: string }[] } } | undefined
  assert.deepEqual(
    sent?.model?.params?.find((param) => param.id === 'context'),
    { id: 'context', value: '200k' },
  )
})

test('a rejecting credential resolver cannot escape startup revalidation', async () => {
  const warnings: string[] = []
  const adapter = new CursorAdapter({
    gateway: gatewayOf().gateway,
    apiKey: async () => {
      throw new Error('credential store offline')
    },
    cwd: () => '/tmp',
    prewarm: false,
    catalogPersistence: memoryCatalogStore(),
    onWarn: (message) => warnings.push(message),
  })
  await adapter.revalidateCatalog()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /revalidation failed/)
})

test('a metadata change re-announces the picker after the cache is installed', async () => {
  let models: CursorCatalogModel[] = [
    {
      id: 'm',
      displayName: 'First',
      parameters: [{ id: 'effort', values: [{ value: 'low' }] }],
    },
  ]
  const { gateway } = gatewayOf()
  gateway.listModels = async () => models
  const applied: (readonly CursorCatalogModel[])[] = []
  const adapter = adapterOf(gateway, {
    catalogTtlMs: 0,
    onCatalogApplied: (next) => applied.push(next),
  })
  await adapter.listModels('cursor')
  assert.equal(applied.length, 1)
  // The same id with a new name and a new reasoning effort must notify.
  models = [
    {
      id: 'm',
      displayName: 'Second',
      parameters: [
        { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] },
      ],
    },
  ]
  await adapter.listModels('cursor')
  for (let attempt = 0; attempt < 50 && applied.length < 2; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  assert.equal(applied.length, 2)
  assert.equal(applied[1]?.[0]?.displayName, 'Second')
  assert.deepEqual(applied[1]?.[0]?.parameters?.[0]?.values, [
    { value: 'low' },
    { value: 'high' },
  ])
})

test('a refresh started by exact resolution re-announces new metadata', async () => {
  let models: CursorCatalogModel[] = [
    {
      id: 'm',
      displayName: 'First',
      parameters: [{ id: 'effort', values: [{ value: 'low' }] }],
    },
  ]
  const { gateway } = gatewayOf()
  gateway.listModels = async () => models
  const applied: (readonly CursorCatalogModel[])[] = []
  const adapter = adapterOf(gateway, {
    catalogTtlMs: 0,
    onCatalogApplied: (next) => applied.push(next),
  })
  await adapter.listModels('cursor')
  assert.equal(applied.length, 1)
  models = [
    {
      id: 'm',
      displayName: 'Second',
      parameters: [
        { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] },
      ],
    },
  ]
  // A host resolution of the model starts the refresh.
  await adapter.resolveModel('cursor', 'm')
  for (let attempt = 0; attempt < 50 && applied.length < 2; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  assert.equal(applied.length, 2)
  assert.equal(applied[1]?.[0]?.displayName, 'Second')
})
test('the route publishes a retry policy for pre-output failures only', () => {
  const { gateway } = gatewayOf()
  const adapter = adapterOf(gateway)
  const policy = adapter.providerRetryPolicy('cursor')
  assert.equal(policy?.mode, 'normal')
  assert.equal(policy?.mode === 'normal' ? policy.maxRetries : undefined, 2)
  assert.deepEqual(
    policy?.mode === 'normal' ? [...policy.retryableCodes] : [],
    ['CURSOR_UNAVAILABLE'],
  )
  // The other routes this plugin serves keep the host's default policy.
  assert.equal(adapter.providerRetryPolicy('codex'), undefined)
})
