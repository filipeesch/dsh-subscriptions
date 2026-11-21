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
  offeredContextValues,
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
  earlierImagesNote,
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
  /** The model this agent runs, independent of the parameters it negotiated. */
  readonly modelId: string
  /** Which credential opened this agent; a rotated key gets a new one. */
  readonly credentialId: string
  /** The exact request (model, requested parameters, credential) it serves. */
  readonly requestKey: string
  /** This agent runs a fallback tier, so a finished run may teach it. */
  fellBack = false

  constructor(
    key: string,
    signature: string,
    params: CursorParam[] | undefined,
    modelId = '',
    credentialId = '',
    requestKey = '',
  ) {
    this.key = key
    this.signature = signature
    this.params = params
    this.modelId = modelId
    this.credentialId = credentialId
    this.requestKey = requestKey
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
        for await (const message of run.stream()) {
          this.events.push(message)
          this.wake()
        }
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
  /** Credential reference named in a missing-key diagnostic. */
  keyRef: string
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
  /** Adapter-assigned order, reserved before its async setup starts. */
  turnSeq?: number
  reply: Reply
}

export class CursorRuntime {
  private readonly sessions = new Map<string, CursorSession[]>()
  private readonly overhead = new Map<string, number>()
  private readonly workingContext = new Map<string, string>()
  /** Newest turn per session key; an older create must not publish. */
  private readonly keyGeneration = new Map<string, number>()
  /** Cancels the work of a turn a newer one superseded. */
  private readonly keyAbort = new Map<string, AbortController>()
  private warming: Promise<void> | undefined
  private prewarmAgent: CursorAgent | undefined
  private prewarmRun: CursorRun | undefined
  private prewarmCleanup: (() => Promise<void>) | undefined
  private disposed = false
  /** Aborts every turn on unload, whether or not the SDK stream cooperates. */
  private readonly lifetime = new AbortController()
  private turnSeq = 0

  constructor(private readonly options: CursorRuntimeOptions) {}

  /** Order a turn before its async setup starts; the adapter calls this. */
  beginTurn(): number {
    this.turnSeq += 1
    return this.turnSeq
  }

  /** Close every agent; called from the plugin's disposer. */
  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
    this.keyAbort.clear()
    this.keyGeneration.clear()
    // The warmup's one cleanup closes whatever handle exists; its finally
    // then finds the agent already closed and does not close it again.
    void this.prewarmCleanup?.()
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

  /** Cancellation state sizes; a test hook. */
  turnState(): { controllers: number; generations: number } {
    return {
      controllers: this.keyAbort.size,
      generations: this.keyGeneration.size,
    }
  }

  /** Tokens Cursor adds on top of the transcript for one model; a test hook. */
  overheadFor(modelId: string): number {
    return this.overhead.get(modelId) ?? 0
  }

  /** Run one DSH model call on a persistent Cursor session. */
  async runTurn(options: CursorTurnOptions): Promise<void> {
    const { reply, transcript } = options
    const sessionKey = sessionKeyFor(
      options.sessionId,
      transcript,
      options.purpose,
    )
    // Ownership follows the adapter's call order, reserved before any await:
    // a later turn owns the conversation even if an earlier one sets up first.
    const generation = options.turnSeq ?? this.beginTurn()
    const prior = this.keyGeneration.get(sessionKey) ?? 0
    if (generation < prior) {
      reply.finish('aborted')
      return
    }
    // A newer turn cancels the work the older one already dispatched; the
    // older turn's signal then aborts its own races and late handles.
    let turnController = this.keyAbort.get(sessionKey)
    if (generation > prior) {
      turnController?.abort()
      turnController = new AbortController()
      this.keyAbort.set(sessionKey, turnController)
      this.keyGeneration.set(sessionKey, generation)
    }
    turnController ??= new AbortController()
    // One signal per turn: the host's cancellation, the runtime lifetime, and
    // supersession by a newer turn of the same conversation.
    const signal = AbortSignal.any([
      turnController.signal,
      this.lifetime.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ])
    const owns = () => (this.keyGeneration.get(sessionKey) ?? 0) === generation
    const abortedNow = () => signal.aborted
    let resolveAbort!: () => void
    const aborted = new Promise<'aborted'>((resolve) => {
      resolveAbort = () => resolve('aborted')
    })
    if (signal.aborted) resolveAbort()
    let session: CursorSession | undefined
    const onAbort = () => {
      resolveAbort()
      session?.wake()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // Every early exit past this point must release the listener and the
    // controller; only the current turn may delete the key's entries.
    const cleanupTurn = () => {
      signal.removeEventListener('abort', onAbort)
      if (this.keyAbort.get(sessionKey) === turnController) {
        this.keyAbort.delete(sessionKey)
        // No newer turn has been reserved, so nothing older can still arrive.
        if (
          generation === this.turnSeq &&
          this.keyGeneration.get(sessionKey) === generation
        ) {
          this.keyGeneration.delete(sessionKey)
        }
      }
    }
    if (signal.aborted) {
      reply.finish('aborted')
      cleanupTurn()
      return
    }
    let apiKey: string | undefined
    try {
      const credential = await Promise.race([
        this.options.apiKey().then((value) => ({ value })),
        aborted,
      ])
      if (credential === 'aborted') {
        reply.finish('aborted')
        cleanupTurn()
        return
      }
      apiKey = credential.value
    } catch (error) {
      reply.finish('error', safeError(error, 'resolve the Cursor API key'))
      cleanupTurn()
      return
    }
    if (!apiKey) {
      reply.finish(
        'error',
        `No Cursor API key. Store ${this.options.keyRef} in DSH credentials.`,
        ERROR_CODES.missingKey,
      )
      cleanupTurn()
      return
    }
    if (signal?.aborted || !owns()) {
      reply.finish('aborted')
      cleanupTurn()
      return
    }
    const modelId = resolveModelId(options.model.id)

    const requestedParams = modelParams(
      options.model,
      options.reasoning,
      this.options.contextPreference(),
    )
    let params = requestedParams
    // A learned tier belongs to this credential and configured preference,
    // and is usable only while the catalog still offers it.
    const tierKey = [
      modelId,
      hash(apiKey),
      this.options.contextPreference(),
    ].join('|')
    const offered = offeredContextValues(options.model)
    const known = this.workingContext.get(tierKey)
    if (known !== undefined && offered.includes(known)) {
      params = params?.map((param) =>
        param.id === 'context' ? { id: param.id, value: known } : param,
      )
    } else if (known !== undefined) {
      this.workingContext.delete(tierKey)
    }
    const credentialId = hash(apiKey)

    const transcriptTokens = () =>
      estimateTranscript(
        transcript.systemPrompt,
        transcript.tools,
        transcript.messages,
        reply.content as never,
      )
    const contextTokens = () =>
      transcriptTokens() + (this.overhead.get(modelId) ?? 0)

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
    // A cancelled turn must not wait for a send in flight; a run that arrives
    // after the cancellation is cancelled instead of consumed.
    const sendGuarded = async (
      target: CursorSession,
      text: string,
      images: Image[] | undefined,
      sendOptions: unknown,
    ): Promise<CursorRun> => {
      if (signal?.aborted) throw new TurnAborted()
      const pending = send(target, text, images, sendOptions)
      const first = await Promise.race([
        pending.then((run) => ({ run })),
        aborted,
      ])
      if (first === 'aborted') {
        void pending.then((run) => run?.cancel?.()).catch(() => {})
        throw new TurnAborted()
      }
      const run = first.run
      if (signal?.aborted) {
        void Promise.resolve(run?.cancel?.()).catch(() => {})
        throw new TurnAborted()
      }
      return run
    }
    const sendFirst = async (session: CursorSession) => {
      session.sentFirst = true
      const text = [
        earlierImagesNote(transcript.messages as never),
        renderTranscript(transcript.systemPrompt, transcript.messages),
      ]
        .filter(Boolean)
        .join('\n\n')
      session.startRun(
        await sendGuarded(
          session,
          text,
          currentTurnImages(transcript.messages as never),
          {},
        ),
      )
    }

    const messages = transcript.messages as unknown as Record<string, unknown>[]
    const usable = (entry: CursorSession) =>
      !entry.closed &&
      !entry.busy &&
      // A refreshed catalog can withdraw a tier the live agent still runs.
      (entry.params?.find((param) => param.id === 'context')?.value ===
        undefined ||
        offered.includes(
          entry.params!.find((param) => param.id === 'context')!.value,
        ))
    const candidates = (this.sessions.get(sessionKey) ?? []).filter(usable)
    const requestKey = requestKeyOf(modelId, requestedParams, credentialId)
    session = candidates.find((entry) => entry.requestKey === requestKey)
    let plan = planIncrement(session, messages)
    if (session === undefined) {
      // Only a verified pending handoff may reuse an agent whose parameters
      // differ, and only when the context tier is the sole difference, from
      // the same model and credential.
      for (const candidate of candidates) {
        if (candidate.modelId !== modelId) continue
        if (candidate.credentialId !== credentialId) continue
        if (!onlyContextDiffers(requestedParams, candidate.params)) continue
        if (!candidate.pending.some((call) => call.handed)) continue
        const candidatePlan = planIncrement(candidate, messages)
        if (candidatePlan.kind === 'results') {
          session = candidate
          plan = candidatePlan
          break
        }
      }
    }
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
    let tierRetried = false
    try {
      const openFresh = async (
        effective: CursorParam[] | undefined,
        fellBack = false,
      ) => {
        if (!owns() || abortedNow()) throw new TurnAborted()
        const created = await Promise.race([
          this.open(
            sessionKey,
            modelId,
            requestedParams,
            effective,
            transcript,
            apiKey,
            options.sessionId,
            signal,
            generation,
          ),
          aborted.then(() => {
            throw new TurnAborted()
          }),
        ])
        created.fellBack = fellBack
        // Creation is async: a cancel or a newer turn that landed meanwhile
        // must close the agent instead of sending into it.
        if (!owns() || abortedNow()) {
          this.drop(created)
          throw new TurnAborted()
        }
        created.busy = true
        try {
          await sendFirst(created)
        } catch (error) {
          this.drop(created)
          throw error
        }
        if (signal?.aborted) {
          this.drop(created)
          throw new TurnAborted()
        }
        return created
      }
      if (!session || plan.kind === 'fresh') {
        try {
          session = await openFresh(params)
        } catch (error) {
          // A rejected tier can surface while creating or sending, before any
          // run exists; it is the same single retry as a rejected run.
          const message = error instanceof Error ? error.message : String(error)
          if (error instanceof TurnAborted || !isRejectedParams(message)) {
            throw error
          }
          if (!owns() || abortedNow()) throw new TurnAborted()
          const lower = smallerContext(options.model, params)
          if (!lower || tierRetried) throw error
          tierRetried = true
          session = await openFresh(lower, true)
        }
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
        if (!owns() || abortedNow()) throw new TurnAborted()
        session.startRun(
          await sendGuarded(
            session,
            text,
            plan.images,
            syncTools(session, transcript.tools),
          ),
        )
        session.systemPrompt = transcript.systemPrompt
      } else if (note || session.toolsKey !== toolsKeyOf(transcript.tools)) {
        session.busy = true
        const continued = await continueWithNewTools(
          session,
          plan.results,
          transcript.tools,
          note,
          sendGuarded,
          aborted,
          () => abortedNow() || !owns(),
        )
        if (abortedNow() || !owns()) throw new TurnAborted()
        if (continued) {
          session.systemPrompt = transcript.systemPrompt
        } else {
          this.drop(session)
          // The rebuild is a new agent like any other: same abort checks and
          // late-handle cleanup as the first send.
          session = await openFresh(params)
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
        if (this.disposed || session.closed || !owns()) {
          this.drop(session)
          reply.finish('aborted')
          return
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
          // Only a fallback that proved necessary is learned: a concurrent run
          // on the configured tier must not undo it.
          const tier = session.params?.find((param) => param.id === 'context')
          if (tier && session.fellBack)
            this.workingContext.set(tierKey, tier.value)
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
          !tierRetried &&
          !emitted &&
          session.modelCalls === 1 &&
          isRejectedParams(error)
            ? smallerContext(options.model, session.params)
            : undefined
        if (lower) {
          tierRetried = true
          this.drop(session)
          session = await openFresh(lower, true)
          session.seen = transcript.messages.map((message) =>
            fingerprint(message as never),
          )
          continue
        }
        this.drop(session)
        reply.finish(
          status === 'cancelled' ? 'aborted' : 'error',
          error === undefined ? undefined : safeError(error, 'run the model'),
        )
        return
      }
    } catch (error) {
      if (session) this.drop(session)
      const aborted = error instanceof TurnAborted || abortedNow()
      reply.finish(
        aborted ? 'aborted' : 'error',
        aborted ? undefined : safeError(error, 'run the model'),
      )
    } finally {
      cleanupTurn()
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
    if (this.disposed) return
    let agent: CursorAgent | undefined
    let run: CursorRun | undefined
    let cancelled = false
    let agentClosed = false
    // One cleanup path closes whatever handle exists by then, exactly once.
    const close = async (): Promise<void> => {
      if (run !== undefined && !cancelled) {
        cancelled = true
        await Promise.resolve(run.cancel?.()).catch(() => {})
      }
      if (agent !== undefined && !agentClosed) {
        agentClosed = true
        settle(() => agent?.close?.())
      }
    }
    this.prewarmCleanup = close
    try {
      const cwd = this.options.cwd(undefined)
      agent = await this.options.gateway.createAgent({
        model: { id: modelId },
        apiKey,
        tools: ['mcp'],
        local: { cwd, settingSources: [] },
      })
      this.prewarmAgent = agent
      if (this.disposed) return
      run = await agent.send('.')
      this.prewarmRun = run
      if (this.disposed) return
      cancelled = true
      await Promise.resolve(run.cancel?.()).catch(() => {})
      await Promise.resolve(run.wait?.()).catch(() => {})
      const id = agent.agentId
      if (id) {
        void this.options.gateway
          .deleteAgent?.(id, { apiKey, local: { cwd } })
          .catch(() => {})
      }
    } catch (error) {
      this.warn(`Cursor prewarm failed: ${safeError(error, 'warm the SDK')}`)
    } finally {
      this.prewarmAgent = undefined
      this.prewarmRun = undefined
      this.prewarmCleanup = undefined
      await close()
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
    // One live agent per conversation: a model or parameter change replaces
    // the previous agent instead of parking it for a later switch back, whose
    // transcript would already have moved on.
    for (const entry of this.sessions.get(session.key) ?? []) {
      if (entry !== session) entry.close()
    }
    this.sessions.set(session.key, [session])
  }

  private async open(
    key: string,
    modelId: string,
    requested: CursorParam[] | undefined,
    params: CursorParam[] | undefined,
    transcript: CursorTranscript,
    apiKey: string,
    sessionId: string | undefined,
    signal?: AbortSignal,
    generation = 0,
  ): Promise<CursorSession> {
    if (this.disposed) throw new Error('Cursor runtime is disposed')
    const credentialId = hash(apiKey)
    const session = new CursorSession(
      key,
      signatureOf(modelId, params),
      params,
      modelId,
      credentialId,
      requestKeyOf(modelId, requested, credentialId),
    )
    session.onIdle = (idle) => this.drop(idle)
    session.systemPrompt = transcript.systemPrompt
    const { local } = syncTools(session, transcript.tools)
    const agent = await this.options.gateway.createAgent({
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
    // A cancelled or disposed turn must not publish a late agent into the
    // registry: it would close the session that replaced it.
    if (this.disposed) {
      settle(() => agent.close?.())
      throw new Error('Cursor runtime is disposed')
    }
    if (signal?.aborted) {
      settle(() => agent.close?.())
      throw new TurnAborted()
    }
    // A newer turn of the same conversation owns the key now: close this
    // late handle without publishing it.
    if ((this.keyGeneration.get(key) ?? 0) !== generation) {
      settle(() => agent.close?.())
      throw new TurnAborted()
    }
    session.agent = agent
    this.store(session)
    return session
  }

  private warn(message: string): void {
    this.options.onWarn?.(message)
  }
}

/**
 * Credential-free diagnostics: provider text can echo a key or token, so a
 * transcript only ever sees a classified sentence.
 */
export function safeError(error: unknown, action: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /401|403|unauthori[sz]ed|forbidden|invalid api key|authentication/i.test(
      message,
    )
  ) {
    return `Cursor rejected the API key while trying to ${action}.`
  }
  if (/invalid parameters for registry model/i.test(message)) {
    return 'Cursor rejected the selected model parameters.'
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(message)) {
    return `Cursor could not be reached while trying to ${action}.`
  }
  return `Cursor failed while trying to ${action}.`
}

/** Ends a turn whose caller cancelled while an async boundary was open. */
class TurnAborted extends Error {}

function signatureOf(
  modelId: string,
  params: CursorParam[] | undefined,
): string {
  return hash(JSON.stringify([modelId, params ?? []]))
}

/** The exact request identity a session serves, credential included. */
function requestKeyOf(
  modelId: string,
  requested: CursorParam[] | undefined,
  credentialId: string,
): string {
  return hash(JSON.stringify([modelId, requested ?? [], credentialId]))
}

/** True when two parameter sets differ only in the context tier value. */
function onlyContextDiffers(
  requested: CursorParam[] | undefined,
  effective: CursorParam[] | undefined,
): boolean {
  const withoutContext = (params: CursorParam[] | undefined) =>
    JSON.stringify((params ?? []).filter((param) => param.id !== 'context'))
  if (withoutContext(requested) !== withoutContext(effective)) return false
  const contextOf = (params: CursorParam[] | undefined) =>
    params?.find((param) => param.id === 'context')?.value
  return contextOf(requested) !== contextOf(effective)
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
  aborted: Promise<'aborted'>,
  cancelled: () => boolean,
): Promise<boolean> {
  if (cancelled()) throw new TurnAborted()
  settle(() => void Promise.resolve(session.run?.cancel?.()).catch(() => {}))
  const deadline = Date.now() + CANCEL_WAIT_MS
  while (!session.runDone && Date.now() < deadline) {
    const stopped = await Promise.race([
      session.waitForChange(deadline - Date.now()),
      aborted,
    ])
    if (stopped === 'aborted') throw new TurnAborted()
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
  if (cancelled()) throw new TurnAborted()
  const run = await send(
    session,
    parts.join('\n\n'),
    imagesOf(results.map((result) => result.message as never)),
    syncTools(session, tools),
  )
  session.startRun(run, false)
  return true
}
