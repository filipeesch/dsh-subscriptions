/**
 * One Cursor agent per DSH session, fed only what is new.
 *
 * - The first send carries the system prompt and the history; later sends carry
 *   only the new user and context text, so Cursor's prompt cache covers the
 *   whole conversation.
 * - A DSH tool call keeps the Cursor run alive: the custom tool's `execute`
 *   waits until DSH sends the result back on the next request, so the model sees
 *   a normal tool result.
 * - Tools changed mid-session keep the agent: every send carries the current
 *   tools, and system prompt lines that were only added are prepended to the
 *   next send. A run waiting for tool results is cancelled and continued with
 *   the new tools.
 * - Anything else that does not match what Cursor saw (compaction, edit, model
 *   or param change, rewritten system prompt, lost run) starts a new agent from
 *   the full history, so correctness never depends on the cache.
 *
 * Calls without a session id, and auxiliary calls (titles, compaction), get a
 * session keyed by their opening, closed once they finish.
 *
 * The runtime owns every piece of mutable state — sessions, calibrated prompt
 * overhead, and the context tier that worked after a rejection — so a test or a
 * second configuration never inherits another instance's memory.
 */

import {
  isRejectedParams,
  modelParams,
  resolveModelId,
  smallerContext,
  type CursorCatalogModel,
  type CursorParam,
} from './models.js'
import {
  estimateTranscript,
  fingerprint,
  hash,
  imagesOf,
  incrementText,
  currentTurnImages,
  renderTranscript,
  systemPromptAddition,
  textOf,
  toolResultForCursor,
  asObject,
  type Image,
} from './prompt.js'
import { ERROR_CODES, Reply } from './reply.js'
import type { CursorTranscript } from './transcript.js'
import { buckets, runUsage, type CursorUsage } from './usage.js'

const SLOTS_PER_KEY = 3
const IDLE_CLOSE_MS = 20 * 60_000
const PENDING_CLOSE_MS = 60 * 60_000
const HANDOFF_DEBOUNCE_MS = 50
const CANCEL_WAIT_MS = 15_000
const ANON_PREFIX = 'anon:'

/** One event Cursor's run stream reports. */
export interface CursorEvent {
  type?: string
  text?: string
  message?: { content?: unknown[] }
}

/** Final state of one Cursor run. */
export interface CursorRunResult {
  status?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  error?: { message?: string }
}

/** The run handle Cursor's SDK returns from a send. */
export interface CursorRun {
  stream(): AsyncIterable<CursorEvent>
  wait(): Promise<CursorRunResult>
  cancel?(): Promise<unknown>
}

/** The agent handle Cursor's SDK returns from `Agent.create`. */
export interface CursorAgent {
  agentId?: string
  send(
    message: string | { text: string; images?: readonly Image[] },
    options?: unknown,
  ): Promise<CursorRun>
  close?(): void
}

/** Options one agent is created with; mirrors the SDK's own shape. */
export interface CursorAgentOptions {
  model: { id: string; params?: readonly CursorParam[] }
  apiKey: string
  tools: readonly string[]
  local: {
    cwd: string
    settingSources: readonly string[]
    customTools?: Record<string, unknown>
  }
}

/** The seam the adapter tests replace; the real one wraps `@cursor/sdk`. */
export interface CursorGateway {
  createAgent(options: CursorAgentOptions): Promise<CursorAgent>
  deleteAgent?(
    agentId: string,
    options: { apiKey: string; local?: unknown },
  ): Promise<void>
  listModels(options: { apiKey: string }): Promise<CursorCatalogModel[]>
}

interface PendingCall {
  id: string
  name: string
  args: Record<string, unknown>
  handed: boolean
  resolve: (result: { content: unknown[]; isError: boolean }) => void
}

/** One live Cursor agent, and what it has seen. */
export class CursorSession {
  agent: CursorAgent | undefined
  run: CursorRun | undefined
  events: CursorEvent[] = []
  runDone = true
  runResult: CursorRunResult | undefined
  runError: unknown
  /** Model calls DSH can see in the current run: its start plus each handoff. */
  modelCalls = 0
  /** False for a run that re-delivers tool results: Cursor saw part of that turn twice. */
  runCalibrates = true
  sentFirst = false
  pending: PendingCall[] = []
  lastCallAt = 0
  toolsKey = ''
  toolNames: string[] = []
  /** The system prompt as Cursor knows it: the first send plus later additions. */
  systemPrompt = ''
  /** Fingerprints of the messages Cursor has seen, including its own replies. */
  seen: string[] = []
  busy = false
  closed = false
  private wakers: (() => void)[] = []
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  readonly key: string
  readonly signature: string
  readonly params: CursorParam[] | undefined

  constructor(
    key: string,
    signature: string,
    params: CursorParam[] | undefined,
  ) {
    this.key = key
    this.signature = signature
    this.params = params
  }

  wake(): void {
    const wakers = this.wakers
    this.wakers = []
    for (const wake of wakers) wake()
  }

  waitForChange(ms?: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(resolve, ms)
      this.wakers.push(() => {
        if (timer) clearTimeout(timer)
        resolve()
      })
    })
  }

  registerCall(
    name: string,
    args: unknown,
    toolCallId: string | undefined,
  ): Promise<{ content: unknown[]; isError: boolean }> {
    return new Promise((resolve) => {
      this.pending.push({
        id:
          toolCallId ??
          `call_${name}_${Date.now().toString(36)}_${this.pending.length}`,
        name,
        args: asObject(args),
        handed: false,
        resolve,
      })
      this.lastCallAt = Date.now()
      this.wake()
    })
  }

  startRun(run: CursorRun, calibrates = true): void {
    Object.assign(this, {
      run,
      events: [],
      runDone: false,
      runResult: undefined,
      runError: undefined,
      modelCalls: 1,
      runCalibrates: calibrates,
    })
    void (async () => {
      try {
        for await (const message of run.stream()) this.events.push(message)
      } catch (error) {
        this.runError = error
      }
      try {
        this.runResult = await run.wait()
      } catch (error) {
        this.runError ??= error
      }
      this.runDone = true
      this.wake()
    })()
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(
      () => this.onIdle?.(this),
      this.pending.length > 0 ? PENDING_CLOSE_MS : IDLE_CLOSE_MS,
    )
    this.idleTimer.unref?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const call of this.pending) {
      settle(() =>
        call.resolve({
          content: [{ type: 'text', text: 'Cancelled by the host.' }],
          isError: true,
        }),
      )
    }
    this.pending = []
    settle(() => void Promise.resolve(this.run?.cancel?.()).catch(() => {}))
    settle(() => this.agent?.close?.())
    this.wake()
  }

  /** Set by the owning runtime so an idle timer can drop this session. */
  onIdle?: (session: CursorSession) => void
}

function settle(action: () => void): void {
  try {
    action()
  } catch {
    /* best effort */
  }
}

type Results = {
  call: PendingCall
  message: Record<string, unknown>
  extra?: string
}[]

/** How new messages map onto the live Cursor session. */
type Plan =
  | { kind: 'fresh' }
  | { kind: 'send'; text: string; images: Image[] | undefined }
  | { kind: 'results'; results: Results }

const sendable = (message: Record<string, unknown>) =>
  message?.role === 'user' || message?.role === 'developer'

/** How the new messages map onto the live Cursor session. */
export function planIncrement(
  session: CursorSession | undefined,
  messages: readonly Record<string, unknown>[],
): Plan {
  if (!session || session.closed || !session.sentFirst) {
    return { kind: 'fresh' }
  }
  if (messages.length <= session.seen.length) return { kind: 'fresh' }
  if (
    session.seen.some((print, i) => fingerprint(messages[i] as never) !== print)
  ) {
    return { kind: 'fresh' }
  }
  const added = messages.slice(session.seen.length)
  const handed = session.pending.filter((call) => call.handed)

  if (handed.length > 0) {
    if (session.runDone) return { kind: 'fresh' }
    const results: Results = []
    let index = 0
    for (
      ;
      index < added.length && added[index]?.role === 'toolResult';
      index++
    ) {
      const call = handed.find((entry) => entry.id === added[index].toolCallId)
      if (!call || results.some((result) => result.call === call)) {
        return { kind: 'fresh' }
      }
      results.push({ call, message: added[index] })
    }
    if (results.length !== handed.length) return { kind: 'fresh' }
    const steering = added.slice(index)
    if (!steering.every(sendable)) return { kind: 'fresh' }
    const text = steering
      .map((message) => incrementText(message as never))
      .filter(Boolean)
      .join('\n\n')
    if (text) {
      results[results.length - 1].extra =
        `[The user sent this message while the tool was running]\n${text}`
    }
    return { kind: 'results', results }
  }

  if (
    !session.runDone ||
    session.pending.length > 0 ||
    !added.every(sendable)
  ) {
    return { kind: 'fresh' }
  }
  return {
    kind: 'send',
    text: added
      .map((message) => incrementText(message as never))
      .filter(Boolean)
      .join('\n\n'),
    images: imagesOf(added as never),
  }
}

/** One runtime shared by the route's adapter. */
export interface CursorRuntimeOptions {
  gateway: CursorGateway
  /** Resolve the API key per call; `undefined` means unconfigured. */
  apiKey: () => Promise<string | undefined>
  /** Working directory for agents of one session. */
  cwd: (sessionId: string | undefined) => string
  /** Context tier preference (`max` by default). */
  contextPreference: () => string
  /** Diagnostics sink for runs that fail in the background. */
  onWarn?: (message: string) => void
}

/** Everything a turn needs; the adapter supplies it per request. */
export interface CursorTurnOptions {
  model: { id: string; cursorParameters?: unknown }
  transcript: CursorTranscript
  reasoning?: string
  signal?: AbortSignal
  sessionId?: string
  /** Auxiliary call classification; title and compaction calls stay isolated. */
  purpose?: 'compaction' | 'session-title'
  reply: Reply
}

export class CursorRuntime {
  private readonly sessions = new Map<string, CursorSession[]>()
  private readonly overhead = new Map<string, number>()
  private readonly workingContext = new Map<string, string>()
  private warming: Promise<void> | undefined
  private disposed = false

  constructor(private readonly options: CursorRuntimeOptions) {}

  /** Close every agent; called from the plugin's disposer. */
  dispose(): void {
    this.disposed = true
    for (const slots of this.sessions.values()) {
      for (const session of slots) session.close()
    }
    this.sessions.clear()
  }

  /** Number of live sessions; a test hook. */
  sessionCount(): number {
    let count = 0
    for (const slots of this.sessions.values()) count += slots.length
    return count
  }

  /** Tokens Cursor adds on top of the transcript for one model; a test hook. */
  overheadFor(modelId: string): number {
    return this.overhead.get(modelId) ?? 0
  }

  /** Run one DSH model call on a persistent Cursor session. */
  async runTurn(options: CursorTurnOptions): Promise<void> {
    const { reply, transcript, signal } = options
    const modelId = resolveModelId(options.model.id)
    const apiKey = await this.options.apiKey()
    if (!apiKey) {
      reply.finish(
        'error',
        'No Cursor API key. Store CURSOR_API_KEY in DSH credentials.',
        ERROR_CODES.missingKey,
      )
      return
    }

    let params = modelParams(
      options.model,
      options.reasoning,
      this.options.contextPreference(),
    )
    const known = this.workingContext.get(modelId)
    if (known) {
      params = params?.map((param) =>
        param.id === 'context' ? { id: param.id, value: known } : param,
      )
    }
    const signature = signatureOf(modelId, params)
    const sessionKey = sessionKeyFor(
      options.sessionId,
      transcript,
      options.purpose,
    )

    const transcriptTokens = () =>
      estimateTranscript(
        transcript.systemPrompt,
        transcript.tools,
        transcript.messages,
        reply.content as never,
      )
    const contextTokens = () => transcriptTokens() + this.overhead.get(modelId)!

    const send = (
      session: CursorSession,
      text: string,
      images: Image[] | undefined,
      sendOptions: unknown,
    ) => {
      if (!session.agent) throw new Error('Cursor agent is not available')
      return session.agent.send(
        images && images.length > 0 ? { text, images } : text,
        sendOptions,
      )
    }
    const sendFirst = async (session: CursorSession) => {
      session.sentFirst = true
      session.startRun(
        await send(
          session,
          renderTranscript(transcript.systemPrompt, transcript.messages),
          currentTurnImages(transcript.messages as never),
          {},
        ),
      )
    }

    let session = (this.sessions.get(sessionKey) ?? []).find(
      (entry) => entry.signature === signature && !entry.closed && !entry.busy,
    )
    let plan = planIncrement(
      session,
      transcript.messages as unknown as Record<string, unknown>[],
    )
    let note = ''
    if (session && plan.kind !== 'fresh') {
      const addition = systemPromptAddition(
        session.systemPrompt,
        transcript.systemPrompt,
      )
      if (addition === undefined) plan = { kind: 'fresh' }
      else note = addition
    }
    if (session && plan.kind === 'fresh') {
      this.drop(session)
      session = undefined
    }

    let freshRun = false
    let emitted = false
    const onAbort = () => session?.wake()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      if (!session || plan.kind === 'fresh') {
        session = await this.open(
          sessionKey,
          modelId,
          params,
          transcript,
          apiKey,
          options.sessionId,
        )
        session.busy = true
        await sendFirst(session)
        freshRun = true
      } else if (plan.kind === 'send') {
        session.busy = true
        const text = [
          note,
          addedToolsNote(session, transcript.tools),
          plan.text,
        ]
          .filter(Boolean)
          .join('\n\n')
        session.startRun(
          await send(
            session,
            text,
            plan.images,
            syncTools(session, transcript.tools),
          ),
        )
        session.systemPrompt = transcript.systemPrompt
      } else if (note || session.toolsKey !== toolsKeyOf(transcript.tools)) {
        session.busy = true
        if (
          await continueWithNewTools(
            session,
            plan.results,
            transcript.tools,
            note,
            send,
          )
        ) {
          session.systemPrompt = transcript.systemPrompt
        } else {
          this.drop(session)
          session = await this.open(
            sessionKey,
            modelId,
            params,
            transcript,
            apiKey,
            options.sessionId,
          )
          session.busy = true
          await sendFirst(session)
          freshRun = true
        }
      } else {
        session.busy = true
        session.modelCalls++
        for (const result of plan.results) {
          session.pending = session.pending.filter(
            (call) => call !== result.call,
          )
          result.call.resolve(
            toolResultForCursor(result.message as never, result.extra),
          )
        }
      }
      session.touch()
      // What Cursor has now seen; this call's reply is appended when it ends.
      session.seen = transcript.messages.map((message) =>
        fingerprint(message as never),
      )

      for (;;) {
        while (session.events.length > 0) {
          const message = session.events.shift()!
          if (message?.type === 'thinking') {
            if (message.text) {
              reply.thinking(message.text)
              emitted ||= true
            }
          } else if (message?.type === 'assistant') {
            for (const block of message.message?.content ?? []) {
              const record = asObject(block)
              if (record.type === 'text' && record.text) {
                reply.text(String(record.text))
                emitted = true
              }
            }
          }
        }
        if (signal?.aborted) {
          this.drop(session)
          reply.finish('aborted')
          return
        }

        const fresh = session.pending.filter((call) => !call.handed)
        if (fresh.length > 0) {
          // Parallel calls arrive a few ms apart; hand them to DSH together.
          const wait = session.lastCallAt + HANDOFF_DEBOUNCE_MS - Date.now()
          if (wait > 0) {
            await session.waitForChange(wait)
            continue
          }
          for (const call of fresh) call.handed = true
          reply.toolCalls(
            fresh.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.args,
            })),
          )
          reply.finish('toolUse')
          session.seen.push(fingerprint(reply.message as never))
          return
        }

        if (!session.runDone) {
          await session.waitForChange()
          continue
        }

        const result = session.runResult
        const status =
          result?.status ?? (session.runError ? 'error' : 'finished')
        if (status === 'finished') {
          reply.usage = runUsage(
            result?.usage,
            session.modelCalls,
            contextTokens(),
          )
          if (session.modelCalls === 1 && session.runCalibrates) {
            this.calibrate(modelId, result?.usage, transcriptTokens())
          }
          session.run = undefined
          reply.finish('stop')
          session.seen.push(fingerprint(reply.message as never))
          if (sessionKey.startsWith(ANON_PREFIX)) this.drop(session)
          return
        }

        const error =
          result?.error?.message ??
          (session.runError instanceof Error
            ? session.runError.message
            : session.runError
              ? String(session.runError)
              : undefined)
        const lower =
          freshRun &&
          !emitted &&
          session.modelCalls === 1 &&
          isRejectedParams(error)
            ? smallerContext(options.model, session.params)
            : undefined
        if (lower) {
          this.workingContext.set(
            modelId,
            lower.find((param) => param.id === 'context')!.value,
          )
          this.drop(session)
          session = await this.open(
            sessionKey,
            modelId,
            lower,
            transcript,
            apiKey,
            options.sessionId,
          )
          session.busy = true
          await sendFirst(session)
          session.seen = transcript.messages.map((message) =>
            fingerprint(message as never),
          )
          continue
        }
        this.drop(session)
        reply.finish(status === 'cancelled' ? 'aborted' : 'error', error)
        return
      }
    } catch (error) {
      if (session) this.drop(session)
      reply.finish(
        signal?.aborted ? 'aborted' : 'error',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      signal?.removeEventListener?.('abort', onAbort)
      if (session) {
        session.busy = false
        if (!session.closed) session.touch()
      }
      reply.finish('error', 'Cursor turn ended without a result')
    }
  }

  /** Pay the SDK's per-process setup in the background, once. */
  prewarm(apiKey: string, modelId: string): void {
    this.warming ??= this.runPrewarm(apiKey, modelId)
  }

  // Discarded state on dispose only; kept for one process in tests.
  private async runPrewarm(apiKey: string, modelId: string): Promise<void> {
    try {
      const cwd = this.options.cwd(undefined)
      const agent = await this.options.gateway.createAgent({
        model: { id: modelId },
        apiKey,
        tools: ['mcp'],
        local: { cwd, settingSources: [] },
      })
      const run = await agent.send('.')
      await Promise.resolve(run.cancel?.()).catch(() => {})
      await Promise.resolve(run.wait()).catch(() => {})
      settle(() => agent.close?.())
      const id = agent.agentId
      if (id) {
        void this.options.gateway
          .deleteAgent?.(id, { apiKey, local: { cwd } })
          .catch(() => {})
      }
    } catch (error) {
      this.warn(
        `Cursor prewarm failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private calibrate(
    modelId: string,
    usage: CursorUsage | undefined,
    transcriptTokens: number,
  ): void {
    if (!usage) return
    this.overhead.set(
      modelId,
      Math.max(0, buckets(usage).total - transcriptTokens),
    )
  }

  private drop(session: CursorSession): void {
    session.close()
    const rest = (this.sessions.get(session.key) ?? []).filter(
      (entry) => entry !== session,
    )
    if (rest.length > 0) this.sessions.set(session.key, rest)
    else this.sessions.delete(session.key)
  }

  private store(session: CursorSession): void {
    const slots = (this.sessions.get(session.key) ?? []).filter(
      (entry) => entry.signature !== session.signature,
    )
    slots.unshift(session)
    while (slots.length > SLOTS_PER_KEY) slots.pop()?.close()
    this.sessions.set(session.key, slots)
  }

  private async open(
    key: string,
    modelId: string,
    params: CursorParam[] | undefined,
    transcript: CursorTranscript,
    apiKey: string,
    sessionId: string | undefined,
  ): Promise<CursorSession> {
    if (this.disposed) throw new Error('Cursor runtime is disposed')
    const session = new CursorSession(key, signatureOf(modelId, params), params)
    session.onIdle = (idle) => this.drop(idle)
    session.systemPrompt = transcript.systemPrompt
    const { local } = syncTools(session, transcript.tools)
    session.agent = await this.options.gateway.createAgent({
      model: { id: modelId, ...(params?.length ? { params } : {}) },
      apiKey,
      // Always "mcp": DSH tools are MCP custom tools, and tools can be added later.
      tools: ['mcp'],
      local: {
        cwd: this.options.cwd(sessionId),
        settingSources: [],
        ...(local?.customTools === undefined
          ? {}
          : { customTools: local.customTools }),
      },
    })
    this.store(session)
    return session
  }

  private warn(message: string): void {
    this.options.onWarn?.(message)
  }
}

function signatureOf(
  modelId: string,
  params: CursorParam[] | undefined,
): string {
  return hash(JSON.stringify([modelId, params ?? []]))
}

/** Auxiliary calls (titles, compaction) carry the session id but must not touch its agent. */
export function sessionKeyFor(
  sessionId: unknown,
  transcript: CursorTranscript,
  purpose?: string,
): string {
  if (!purpose && typeof sessionId === 'string' && sessionId) return sessionId
  return (
    ANON_PREFIX +
    hash(
      `${purpose ?? ''}\n${transcript.systemPrompt}\n${transcript.messages.length > 0 ? fingerprint(transcript.messages[0] as never) : ''}`,
    )
  )
}

function toolsKeyOf(
  tools: readonly {
    name?: string
    description?: string
    parameters?: unknown
  }[],
): string {
  return hash(
    JSON.stringify(
      tools.map((tool) => [
        tool?.name,
        tool?.description ?? '',
        tool?.parameters ?? {},
      ]),
    ),
  )
}

/** Point the session at the current tools; returns the send options that carry them. */
function syncTools(
  session: CursorSession,
  tools: CursorTranscript['tools'],
): { local?: { customTools?: Record<string, unknown> } } {
  session.toolsKey = toolsKeyOf(tools)
  session.toolNames = tools.map((tool) => tool?.name).filter(Boolean)
  const customTools: Record<string, unknown> = {}
  for (const tool of tools) {
    if (!tool?.name) continue
    customTools[tool.name] = {
      description: tool.description || tool.name,
      inputSchema:
        tool.parameters !== null && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
      execute: (args: unknown, context: unknown) =>
        session.registerCall(
          tool.name,
          args,
          asObject(context).toolCallId as string | undefined,
        ),
    }
  }
  return Object.keys(customTools).length > 0 ? { local: { customTools } } : {}
}

/**
 * Cursor lists the custom tools to the model when a conversation starts and
 * does not announce later ones, so an added tool needs a note.
 */
function addedToolsNote(
  session: CursorSession,
  tools: CursorTranscript['tools'],
): string {
  const added = tools
    .map((tool) => tool?.name)
    .filter(
      (name): name is string =>
        Boolean(name) && !session.toolNames.includes(name!),
    )
  return added.length > 0
    ? `[Tool update: these tools were added and are now available: ${added.join(', ')}. Look up their schemas before calling them.]`
    : ''
}

/**
 * Cursor fixes a run's tools when it starts. Cancel the waiting run and deliver
 * its tool results in a follow-up send that carries the new tools. False if the
 * run would not stop.
 */
async function continueWithNewTools(
  session: CursorSession,
  results: Results,
  tools: CursorTranscript['tools'],
  note: string,
  send: (
    session: CursorSession,
    text: string,
    images: Image[] | undefined,
    options: unknown,
  ) => Promise<CursorRun>,
): Promise<boolean> {
  settle(() => void Promise.resolve(session.run?.cancel?.()).catch(() => {}))
  const deadline = Date.now() + CANCEL_WAIT_MS
  while (!session.runDone && Date.now() < deadline) {
    await session.waitForChange(deadline - Date.now())
  }
  if (!session.runDone) return false
  for (const call of session.pending) {
    settle(() =>
      call.resolve({
        content: [{ type: 'text', text: 'Delivered in the next message.' }],
        isError: false,
      }),
    )
  }
  session.pending = []
  const parts = [
    "[Tool results for your last tool calls. The run was restarted because the host's tools or system prompt changed; the tools on this request are current.]",
  ]
  for (const result of results) {
    parts.push(
      `### ${result.call.name} (${result.call.id})${result.message.isError ? ' [error]' : ''}\n${textOf(result.message.content) || '(no output)'}`,
    )
    if (result.extra) parts.push(result.extra)
  }
  if (note) parts.push(note)
  const added = addedToolsNote(session, tools)
  if (added) parts.push(added)
  parts.push('Continue the task.')
  const run = await send(
    session,
    parts.join('\n\n'),
    imagesOf(results.map((result) => result.message as never)),
    syncTools(session, tools),
  )
  session.startRun(run, false)
  return true
}
