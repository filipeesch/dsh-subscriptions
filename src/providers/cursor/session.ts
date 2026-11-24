/**
 * One live Cursor agent, and what it has seen.
 *
 * The session owns the agent and run handles, the events each run pushed, the
 * tool calls waiting for their results, and the fingerprints of the transcript
 * Cursor already received. A runtime keeps one session per conversation while
 * it is usable; the session itself performs no I/O and holds no registry.
 */

import type { CursorCatalogModel, CursorParam } from './catalog.js'
import { asObject, hash, type Image } from './prompt.js'

/** How long an unused agent is kept before the runtime closes it. */
const IDLE_CLOSE_MS = 20 * 60_000
/** A run waiting on a tool result keeps its agent longer than an idle one. */
const PENDING_CLOSE_MS = 60 * 60_000

/** The idle budget every agent starts with, in milliseconds. */
export const DEFAULT_IDLE_BUDGET_MS = IDLE_CLOSE_MS

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
  /**
   * The run's failure, shaped the way the SDK reports it. `code` and `status`
   * are what classify a rejected credential: its message varies by reason.
   */
  error?: { message?: string; name?: string; code?: string; status?: number }
}

/** The status the SDK reports for a run, live and independently of `wait()`. */
export type CursorRunStatus = 'running' | 'finished' | 'error' | 'cancelled'

/** The run handle Cursor's SDK returns from a send. */
export interface CursorRun {
  stream(): AsyncIterable<CursorEvent>
  wait(): Promise<CursorRunResult>
  cancel?(): Promise<unknown>
  /**
   * The SDK's live status. A run can be terminal here before its stream ends,
   * which is what tells the pump not to hand its tool calls to the host.
   */
  readonly status?: CursorRunStatus | undefined
  /** Observe status transitions; returns an unsubscribe function. */
  onDidChangeStatus?(listener: (status: CursorRunStatus) => void): () => void
  /** The SDK's live terminal failure, when it has one. */
  readonly error?: unknown
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

/** One tool call the run handed to the host and has not received an answer for. */
export interface PendingCall {
  id: string
  name: string
  args: Record<string, unknown>
  handed: boolean
  resolve: (result: { content: unknown[]; isError: boolean }) => void
}

/** The failure recorded when the stream threw something with no value. */
const STREAM_FAILED = new Error('the run stream closed early')

/** Run a best-effort cleanup action, ignoring a throw. */
export function settle(action: () => void): void {
  try {
    action()
  } catch {
    /* best effort */
  }
}

/** One live Cursor agent, and what it has seen. */
export class CursorSession {
  agent: CursorAgent | undefined
  run: CursorRun | undefined
  events: CursorEvent[] = []
  runDone = true
  runResult: CursorRunResult | undefined
  /** The failure the stream threw, when it did. */
  runError: unknown
  /** Whether the stream's iterator threw, whatever value it threw. */
  streamFailed = false
  /** The failure `wait()` threw, when it did; kept apart from the stream's. */
  runWaitError: unknown
  /** The newest status the SDK reported for the current run. */
  runStatus: CursorRunStatus | undefined
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
  /**
   * Wall-clock time of the last work this agent did. A suspended machine cannot
   * extend it, which is why the lifetime rule reads this instead of a timer.
   */
  lastUsedAt = Date.now()
  private wakers: (() => void)[] = []
  /** Release the current run's status listener; idempotent and best effort. */
  private releaseStatus: (() => void) | undefined

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
    // A call that arrives after the session closed has no run to answer it; the
    // close pass already ran, so it must be settled here rather than hang.
    if (this.closed) {
      return Promise.resolve({
        content: [{ type: 'text', text: 'Cancelled by the host.' }],
        isError: true,
      })
    }
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
      this.lastUsedAt = this.lastCallAt
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
      streamFailed: false,
      runWaitError: undefined,
      runStatus: run.status,
      modelCalls: 1,
      runCalibrates: calibrates,
    })
    // A terminal status can arrive before the stream ends, so it has to wake a
    // waiting pump: that is what withholds a tool call from a dead run.
    const unsubscribe = run.onDidChangeStatus?.((status) => {
      // A retired run can deliver an already-queued notification after the
      // session moved on. Only the run this session is following may report.
      if (this.closed || this.run !== run) return
      this.runStatus = status
      this.wake()
    })
    // One release per run, consumed by whichever path finishes first: the
    // settlement below or `close()`. Consuming it before the SDK callback means
    // a throwing unsubscribe cannot hold up cleanup.
    let released = false
    this.releaseStatus = () => {
      if (released) return
      released = true
      unsubscribe?.()
    }
    // `wait()` is started with the stream, not after it: it carries the run's
    // terminal result, and a stream that stalls must not hide a rejected key.
    const waited = (async () => {
      try {
        this.runResult = await run.wait()
      } catch (error) {
        // Both failures matter: a rejected wait can carry the credential
        // rejection the stream's error does not.
        this.runWaitError = error
      }
      this.wake()
    })()
    void (async () => {
      try {
        try {
          for await (const message of run.stream()) {
            this.events.push(message)
            this.wake()
          }
        } catch (error) {
          // A stream can fail while `wait()` is still pending, and its failure is
          // decisive on its own: wake the pump instead of waiting for the settled
          // result to do it. A nullish throw is still a broken stream, so it is
          // recorded as one instead of looking like a stream that never failed.
          this.streamFailed = true
          this.runError = error ?? STREAM_FAILED
          this.wake()
        }
        await waited
      } finally {
        // The handle is done, so its listener must not outlive it: a finished
        // run the SDK still holds would otherwise keep a callback on this turn.
        this.releaseRunStatus()
        this.runDone = true
        this.wake()
      }
    })()
  }

  /**
   * The budget this agent is allowed to sit unused: shorter while it answers
   * turns, longer while a tool result is still owed to it.
   */
  idleBudgetMs(): number {
    return this.pending.length > 0 ? PENDING_CLOSE_MS : IDLE_CLOSE_MS
  }

  /** Whether this agent outlived its budget at `now`. */
  isStale(now: number): boolean {
    return now - this.lastUsedAt > this.idleBudgetMs()
  }

  /** Record that the agent just did work, in wall-clock time. */
  markUsed(now: number): void {
    this.lastUsedAt = now
  }

  /** Consume the current run's release, and never let it throw. */
  private releaseRunStatus(): void {
    const release = this.releaseStatus
    this.releaseStatus = undefined
    if (release !== undefined) settle(release)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.releaseRunStatus()
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
}

/** The identity of one agent's request, without the credential it uses. */
export function signatureOf(
  modelId: string,
  params: CursorParam[] | undefined,
): string {
  return hash(JSON.stringify([modelId, params ?? []]))
}

/** The exact request identity a session serves, credential included. */
export function requestKeyOf(
  modelId: string,
  requested: CursorParam[] | undefined,
  credentialId: string,
): string {
  return hash(JSON.stringify([modelId, requested ?? [], credentialId]))
}

/** True when two parameter sets differ only in the context tier value. */
export function onlyContextDiffers(
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
