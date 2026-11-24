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
 * This module is the orchestration those rules need: the turn gate decides who
 * owns the conversation, the agent factory creates and warms agents, the run
 * pump turns one run into stream chunks, and the failure policy classifies what
 * went wrong. The calibrated prompt overhead stays here because it belongs to
 * one runtime rather than to any of them.
 */

import {
  addedToolsNote,
  AgentFactory,
  syncTools,
  toolsKeyOf,
} from './agent-factory.js'
import { resolveModelId, type CursorParam } from './catalog.js'
import {
  classifyFailure,
  classifyFailures,
  describeFailure,
} from './failure.js'
import type { FailurePhase } from './failure.js'
import {
  modelParams,
  offeredContextValues,
  offeredTierValue,
  smallerContext,
} from './params.js'
import {
  estimateTranscript,
  fingerprint,
  hash,
  imagesOf,
  currentTurnImages,
  earlierImagesNote,
  renderTranscript,
  systemPromptAddition,
  textOf,
  toolResultForCursor,
  type Image,
} from './prompt.js'
import { ERROR_CODES, Reply } from './reply.js'
import {
  CursorSession,
  onlyContextDiffers,
  requestKeyOf,
  settle,
  type CursorGateway,
  type CursorRun,
} from './session.js'
import { SessionRegistry } from './session-registry.js'
import type { CursorTranscript } from './transcript.js'
import { pumpRun } from './run-pump.js'
import type { PumpInput, PumpOutcome } from './run-pump.js'
import { planIncrement, type Results } from './turn-plan.js'
import { TurnAborted, TurnGate, type TurnReservation } from './turn-gate.js'
import { buckets, runUsage, type CursorUsage } from './usage.js'

const CANCEL_WAIT_MS = 15_000
const ANON_PREFIX = 'anon:'

/** One runtime shared by the route's adapter. */
export interface CursorRuntimeOptions {
  gateway: CursorGateway
  /** Resolve the API key per call; `undefined` means unconfigured. */
  apiKey: () => Promise<string | undefined>
  /** Working directory for agents of one session. */
  cwd: (sessionId: string | undefined) => string
  /** The tier Cursor accepted for this model, when one is remembered. */
  acceptedTier?: (modelId: string) => string | undefined
  /** Remember a tier Cursor accepted after a rejection. */
  rememberAcceptedTier?: (modelId: string, value: string) => void
  /** Drop a remembered tier that no longer applies. */
  forgetAcceptedTier?: (modelId: string) => void
  /** Credential reference named in a missing-key diagnostic. */
  keyRef: string
  /** Diagnostics sink for runs that fail in the background. */
  onWarn?: (message: string) => void
  /** How long a reserved stream may wait before admission; default 60s. */
  reservationTtlMs?: number
  /** Clock the lifetime rule reads; defaults to wall-clock time. */
  now?: () => number
  /** How often the idle sweep runs; 0 disables the timer (tests sweep by hand). */
  sweepIntervalMs?: number
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
  /** The adapter's reservation; released on every exit, idempotently. */
  reservation?: TurnReservation
  reply: Reply
}

export class CursorRuntime {
  private readonly registry = new SessionRegistry()
  private readonly overhead = new Map<string, number>()
  private readonly gate: TurnGate
  private readonly factory: AgentFactory
  private disposed = false
  /** Aborts every turn on unload, whether or not the SDK stream cooperates. */
  private readonly lifetime = new AbortController()
  private readonly now: () => number
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: CursorRuntimeOptions) {
    this.gate = new TurnGate({
      lifetime: this.lifetime.signal,
      ...(options.reservationTtlMs === undefined
        ? {}
        : { reservationTtlMs: options.reservationTtlMs }),
    })
    this.factory = new AgentFactory({
      gateway: options.gateway,
      cwd: options.cwd,
      disposed: () => this.disposed,
      ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
    })
    this.now = options.now ?? (() => Date.now())
    const sweepInterval = options.sweepIntervalMs ?? 60_000
    if (sweepInterval > 0) {
      this.sweepTimer = setInterval(
        () => this.registry.sweep(this.now()),
        sweepInterval,
      )
      this.sweepTimer.unref?.()
    }
  }

  /** Order a turn before its async setup starts; the adapter calls this. */
  beginTurn(): number {
    return this.gate.beginTurn()
  }

  /**
   * Reserve a turn for a known session before its setup starts. The handle is
   * released when the stream closes, finishes, or expires, so a generation
   * entry is retired only once no reserved stream can still run.
   */
  reserveTurn(sessionId?: string): TurnReservation {
    return this.gate.reserveTurn(sessionId)
  }

  /** Close every agent; called from the plugin's disposer. */
  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
    this.gate.clear()
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    // The warmup's one cleanup closes whatever handle exists; its finally
    // then finds the agent already closed and does not close it again.
    void this.factory.cleanup()
    this.registry.closeAll()
  }

  /** Number of live sessions; a test hook. */
  sessionCount(): number {
    return this.registry.count()
  }

  /** Cancellation state sizes; a test hook. */
  turnState(): {
    controllers: number
    generations: number
    reservations: number
  } {
    return this.gate.state()
  }

  /** Run the idle sweep now; a test hook for the periodic rule. */
  sweepNow(): void {
    this.registry.sweep(this.now())
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
    let session: CursorSession | undefined
    const lease = this.gate.admit({
      sessionKey,
      ...(options.reservation === undefined
        ? {}
        : { reservation: options.reservation }),
      ...(options.turnSeq === undefined ? {} : { turnSeq: options.turnSeq }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      wake: () => session?.wake(),
    })
    if (lease === undefined) {
      reply.finish('aborted')
      return
    }
    // One signal per turn: the host's cancellation, the runtime lifetime, and
    // supersession by a newer turn of the same conversation.
    const { signal, aborted } = lease
    const owns = () => lease.owns()
    const abortedNow = () => lease.abortedNow()
    // Every early exit past this point must release the lease; only the
    // current turn may retire the conversation's ownership.
    const cleanupTurn = () => lease.release()
    if (lease.abortedNow()) {
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
      const report = describeFailure({
        phase: 'setup',
        errors: [error],
        action: 'resolve the Cursor API key',
        beforeOutput: true,
        // No attempt ran and no replay could happen: this is not the retryable
        // class, which is reserved for a failure that survived recovery.
        recoverySpent: false,
      })
      this.warn(report.warning)
      reply.finish('error', report.sentence, report.code)
      cleanupTurn()
      return
    }
    if (!apiKey) {
      // A missing credential is a configuration state, not a failed attempt: it
      // keeps its own code, and the warning names the reference that resolved to
      // nothing.
      this.warn(
        `Cursor failed before output (phase=setup, cause=credential): no Cursor API key at ${this.options.keyRef}`,
      )
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
    // Age is wall-clock time, so a sweep that has not run yet cannot hand a
    // suspended agent to this turn.
    this.registry.sweep(this.now())
    const modelId = resolveModelId(options.model.id)

    // One effective tier decides both the request and the agent's request key:
    // the tier Cursor already accepted for this model while the catalog still
    // offers it, else the largest offered. A withdrawn remembered tier is
    // forgotten here, on the model's next turn.
    const offered = offeredContextValues(options.model)
    const remembered = this.options.acceptedTier?.(modelId)
    const accepted =
      remembered === undefined
        ? undefined
        : offeredTierValue(options.model, remembered)
    if (remembered !== undefined && accepted === undefined) {
      this.options.forgetAcceptedTier?.(modelId)
    }
    const requestTier =
      accepted ?? (offered.length > 0 ? offered[offered.length - 1] : undefined)
    const params = modelParams(options.model, options.reasoning, requestTier)
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
    const candidates = this.registry.candidates(sessionKey).filter(usable)
    const requestKey = requestKeyOf(modelId, params, credentialId)
    session = candidates.find((entry) => entry.requestKey === requestKey)
    let plan = planIncrement(session, messages)
    if (session === undefined) {
      // Only a verified pending handoff may reuse an agent whose parameters
      // differ, and only when the context tier is the sole difference, from
      // the same model and credential.
      for (const candidate of candidates) {
        if (candidate.modelId !== modelId) continue
        if (candidate.credentialId !== credentialId) continue
        if (!onlyContextDiffers(params, candidate.params)) continue
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

    let tierRetried = false
    let replayed = false
    // The parameters the current attempt requests. A tier fallback sticks, so a
    // replay never climbs back to the tier Cursor already rejected.
    let attemptParams: CursorParam[] | undefined = params
    let attemptFellBack: boolean = false
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
            effective ?? params,
            transcript,
            apiKey,
            options.sessionId,
            signal,
            lease.generation,
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

      for (;;) {
        let freshRun = false
        let failure:
          | {
              phase: FailurePhase
              errors: readonly unknown[]
              emitted: boolean
              /** Whether the evidence may be missing a terminal signal. */
              ambiguous: boolean
            }
          | undefined
        try {
          {
            if (!session || plan.kind === 'fresh') {
              try {
                session = await openFresh(attemptParams, attemptFellBack)
              } catch (error) {
                // A rejected tier can surface while creating or sending, before any
                // run exists; it is the same single retry as a rejected run.
                if (
                  error instanceof TurnAborted ||
                  classifyFailure(error).cause !== 'parameters'
                ) {
                  throw error
                }
                if (!owns() || abortedNow()) throw new TurnAborted()
                const lower = smallerContext(options.model, params)
                if (!lower || tierRetried) throw error
                tierRetried = true
                attemptParams = lower
                attemptFellBack = true
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
            } else if (
              note ||
              session.toolsKey !== toolsKeyOf(transcript.tools)
            ) {
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
                // late-handle cleanup as the first send, and the same tier.
                session = await openFresh(attemptParams, attemptFellBack)
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
          }
          session.markUsed(this.now())
          // What Cursor has now seen; this call's reply is appended when it ends.
          session.seen = transcript.messages.map((message) =>
            fingerprint(message as never),
          )

          // Pump until this attempt ends, retrying a rejected tier once.
          for (;;) {
            const outcome = await this.pumpAttempt({
              session,
              reply,
              disposed: () => this.disposed,
              owns,
              aborted: abortedNow,
            })
            // The pump's own decision is stale once it resolves: a cancellation
            // or a newer turn can land in the gap before this turn publishes.
            if (abortedNow() || !owns() || this.disposed || session.closed) {
              this.drop(session)
              reply.finish('aborted')
              return
            }
            if (outcome.kind === 'toolUse') return
            if (outcome.kind === 'aborted') {
              this.drop(session)
              reply.finish('aborted')
              return
            }
            if (outcome.kind === 'stop') {
              // Only a fallback that proved necessary is learned: a concurrent run
              // on the configured tier must not undo it.
              const tier = session.params?.find(
                (param) => param.id === 'context',
              )
              if (tier && session.fellBack) {
                this.options.rememberAcceptedTier?.(modelId, tier.value)
              }
              reply.usage = runUsage(
                outcome.result?.usage,
                session.modelCalls,
                contextTokens(),
              )
              if (session.modelCalls === 1 && session.runCalibrates) {
                this.calibrate(
                  modelId,
                  outcome.result?.usage,
                  transcriptTokens(),
                )
              }
              session.run = undefined
              reply.finish('stop')
              session.seen.push(fingerprint(reply.message as never))
              if (sessionKey.startsWith(ANON_PREFIX)) this.drop(session)
              return
            }
            // An unresolved failure is not followed by another attempt either:
            // the missing result could still be the rejection a retry must not
            // touch, so ambiguity blocks the tier fallback like the replay.
            const lower =
              freshRun &&
              !tierRetried &&
              !outcome.emitted &&
              !outcome.ambiguous &&
              session.modelCalls === 1 &&
              classifyFailures(outcome.errors).cause === 'parameters'
                ? smallerContext(options.model, session.params)
                : undefined
            if (lower) {
              tierRetried = true
              attemptParams = lower
              attemptFellBack = true
              this.drop(session)
              session = await openFresh(lower, true)
              session.seen = transcript.messages.map((message) =>
                fingerprint(message as never),
              )
              continue
            }
            failure = {
              phase: outcome.phase,
              errors: outcome.errors,
              emitted: outcome.emitted,
              ambiguous: outcome.ambiguous,
            }
            break
          }
        } catch (error) {
          if (error instanceof TurnAborted || abortedNow()) {
            if (session) this.drop(session)
            reply.finish('aborted')
            return
          }
          failure = {
            phase: 'setup',
            errors: [error],
            emitted: reply.content.length > 0,
            ambiguous: false,
          }
        }
        if (failure === undefined) return

        // One replay, only when the attempt emitted nothing and its cause makes
        // a new agent plausible; a rejected credential never qualifies. The
        // attempt's effective tier carries over, so replaying cannot undo a
        // fallback Cursor already accepted.
        // A session the attempt already dropped cannot describe the tier it was
        // using, so the attempt's own record decides.
        const live =
          session !== undefined && !session.closed ? session : undefined
        const effective = live?.params ?? attemptParams
        const fellBack: boolean = live?.fellBack ?? attemptFellBack
        if (session !== undefined) {
          this.drop(session)
          session = undefined
        }
        const classified = classifyFailures(failure.errors)
        // An unresolved failure is not replayed: the evidence that never
        // arrived is exactly what a retry must not gamble on.
        const replayable = !failure.ambiguous && classified.replayable
        if (!replayed && !failure.emitted && replayable) {
          replayed = true
          attemptParams = effective
          attemptFellBack = fellBack
          continue
        }
        const report = describeFailure({
          phase: failure.phase,
          errors: failure.errors,
          action: 'run the model',
          beforeOutput: !failure.emitted,
          // `replayed` is the fact: the host may retry only what survived a
          // recovery the route actually ran, and only when the evidence was
          // complete.
          recoverySpent: replayed,
          ambiguous: failure.ambiguous,
        })
        this.warn(report.warning)
        reply.finish('error', report.sentence, report.code)
        return
      }
    } finally {
      cleanupTurn()
      if (session) {
        session.busy = false
        if (!session.closed) session.markUsed(this.now())
      }
      if (!reply.settled) {
        reply.finish('error', 'Cursor turn ended without a result')
      }
    }
  }

  /** Pay the SDK's per-process setup in the background, once. */
  prewarm(apiKey: string, modelId: string): void {
    this.factory.prewarm(apiKey, modelId)
  }

  /** Record one diagnostic line on the plugin's warning sink. */
  private warn(message: string): void {
    this.options.onWarn?.(message)
  }

  /**
   * Run one attempt's pump. A seam: the cancellation test replaces it to land a
   * cancel exactly between the pump's decision and this turn's publication.
   */
  private async pumpAttempt(input: PumpInput): Promise<PumpOutcome> {
    return pumpRun(input)
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
    this.registry.drop(session)
  }

  private store(session: CursorSession): void {
    this.registry.store(session)
  }

  /** Create one agent for this turn and publish its session. */
  private async open(
    key: string,
    modelId: string,
    params: CursorParam[] | undefined,
    transcript: CursorTranscript,
    apiKey: string,
    sessionId: string | undefined,
    signal?: AbortSignal,
    generation = 0,
  ): Promise<CursorSession> {
    const session = await this.factory.create({
      key,
      modelId,
      params,
      transcript,
      apiKey,
      sessionId,
      ...(signal === undefined ? {} : { signal }),
      generation,
      disposed: () => this.disposed,
      current: () => this.gate.isCurrent(key, generation),
    })
    this.store(session)
    return session
  }
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

/**
 * The session module's agent-facing types are re-exported here because the
 * runtime is the module the route's callers and specs import. They describe
 * the SDK seam, not this file's state.
 */
export type {
  CursorAgent,
  CursorAgentOptions,
  CursorEvent,
  CursorGateway,
  CursorRun,
  CursorRunResult,
  CursorSession,
} from './session.js'
export { planIncrement } from './turn-plan.js'
export type { Plan, Results } from './turn-plan.js'
export type { TurnReservation } from './turn-gate.js'
export { safeError } from './failure.js'
