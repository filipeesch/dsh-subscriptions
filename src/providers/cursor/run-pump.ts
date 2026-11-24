/**
 * One Cursor run turned into DSH stream chunks.
 *
 * The pump reads what the session collected, maps run events to reply chunks,
 * hands tool calls to the host, and reports how the attempt ended. It finishes
 * the reply only where the outcome is final for that attempt — a tool handoff
 * or an aborted turn — and leaves it open on a failure, so the runtime can
 * decide whether the attempt may be replayed.
 *
 * A run that has already ended never hands a tool call to the host: the run that
 * asked for it could no longer receive the result.
 */

import { asObject, fingerprint } from './prompt.js'
import type { Reply } from './reply.js'
import type {
  CursorRunResult,
  CursorRunStatus,
  CursorSession,
} from './session.js'
import { classifyFailures } from './failure.js'
import type { FailurePhase } from './failure.js'

const HANDOFF_DEBOUNCE_MS = 50
/**
 * How long a terminal failure keeps collecting evidence before it reports. The
 * stream's last events and the run's result can arrive after the status does, and
 * a rejected credential in either one is what decides whether a retry is safe.
 * A wake is not proof that either channel is done, so only the deadline or the
 * run's own settlement ends this wait.
 */
const TERMINAL_DRAIN_MS = 250

/** How one attempt ended. */
export type PumpOutcome =
  | { kind: 'stop'; result: CursorRunResult | undefined }
  | { kind: 'toolUse' }
  | { kind: 'aborted' }
  | {
      kind: 'failed'
      phase: FailurePhase
      /** Every signal the run produced: the thrown value and/or its report. */
      errors: readonly unknown[]
      emitted: boolean
      /**
       * Whether the evidence may be incomplete — a terminal run whose result
       * never arrived. Such a failure is not replayed: the missing evidence
       * could be the rejection a retry should not touch.
       */
      ambiguous: boolean
    }

/** What one pump needs from the turn that started it. */
export interface PumpInput {
  session: CursorSession
  reply: Reply
  /** Whether the runtime was disposed. */
  disposed: () => boolean
  /** Whether this turn still owns the conversation. */
  owns: () => boolean
  /** Whether the caller cancelled this turn. */
  aborted: () => boolean
}

/** Settle tool calls a finished run can no longer receive an answer for. */
function abandonLateCalls(session: CursorSession): void {
  for (const call of session.pending) {
    if (call.handed) continue
    call.resolve({
      content: [
        {
          type: 'text',
          text: 'The run ended before this tool call was delivered.',
        },
      ],
      isError: true,
    })
  }
  session.pending = session.pending.filter((call) => call.handed)
}

/** Publish what the stream already queued. */
function drainEvents(session: CursorSession, reply: Reply): void {
  while (session.events.length > 0) {
    const message = session.events.shift()!
    if (message?.type === 'thinking') {
      if (message.text) reply.thinking(message.text)
    } else if (message?.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        const record = asObject(block)
        if (record.type === 'text' && record.text) {
          reply.text(String(record.text))
        }
      }
    }
  }
}

/**
 * The most terminal status any source reports.
 *
 * A handle getter that still says `running` must not mask a terminal notification,
 * and a later `cancelled` outranks an earlier `error`. `finished` is the weakest
 * reading, because it is the one a stale source is most likely to keep.
 * @param session - the session whose run is being read.
 * @returns the resolved status, or `undefined` while every source is running.
 */
function terminalStatusOf(session: CursorSession): CursorRunStatus | undefined {
  const statuses = [
    session.run?.status,
    session.runStatus,
    session.runResult?.status,
  ]
  if (statuses.includes('cancelled')) return 'cancelled'
  if (statuses.includes('error')) return 'error'
  if (statuses.includes('finished')) return 'finished'
  return undefined
}

/** Every signal a failed run has reported so far. */
function evidenceOf(session: CursorSession): unknown[] {
  return [
    session.run?.error,
    session.runError,
    session.runWaitError,
    session.runResult?.error,
  ].filter((error) => error !== undefined && error !== null)
}

/**
 * Drain the session until the attempt ends.
 * @returns how it ended; a failure leaves the reply unfinished.
 */
export async function pumpRun(input: PumpInput): Promise<PumpOutcome> {
  const { session, reply } = input
  for (;;) {
    drainEvents(session, reply)
    if (input.disposed() || session.closed || !input.owns()) {
      return { kind: 'aborted' }
    }
    if (input.aborted()) return { kind: 'aborted' }

    if (!session.runDone) {
      // The SDK reports a run's terminal status before its stream drains, and a
      // result can arrive before the events that belong to it. Either way the
      // run is over: nothing can answer a tool call it left open, so those calls
      // are withheld first. The status is read from the handle, from the status
      // listener, and from a result that already arrived.
      const terminal = terminalStatusOf(session)
      // A rejection the run already reported is terminal evidence on its own: a
      // rejected key cannot take a tool result, so the handoff is skipped even
      // before any status arrives.
      const decisive =
        classifyFailures(evidenceOf(session)).cause === 'credential'
      // A recorded stream exception is a failed delivery on its own: whatever
      // the handle still claims, the stream cannot deliver the rest of the run,
      // so no tool call may go out for it and the turn must not wait forever for
      // a result that may never come.
      const streamFailed = session.streamFailed
      if (terminal !== undefined || decisive || streamFailed) {
        abandonLateCalls(session)
      }
      if (terminal === 'cancelled') return { kind: 'aborted' }
      if (terminal === 'finished' && !decisive && !streamFailed) {
        // Buffered output still drains, and the settled outcome publishes it as
        // a stop.
        await session.waitForChange()
        continue
      }
      if (terminal === 'error' || decisive || streamFailed) {
        // A rejection already in hand is decisive, so it settles at once.
        let evidence = evidenceOf(session)
        let settled = classifyFailures(evidence).cause === 'credential'
        const deadline = Date.now() + TERMINAL_DRAIN_MS
        while (!settled && !session.runDone && !session.closed) {
          if (input.aborted() || input.disposed() || !input.owns()) {
            return { kind: 'aborted' }
          }
          const left = deadline - Date.now()
          if (left <= 0) break
          // A wake is not proof that either channel is done: drain what arrived,
          // settle any call that arrived meanwhile (a run that already failed
          // cannot answer it, and leaving it pending would also stall the stream),
          // and keep waiting until the run settles or the deadline passes.
          await session.waitForChange(left)
          drainEvents(session, reply)
          abandonLateCalls(session)
          evidence = evidenceOf(session)
          settled = classifyFailures(evidence).cause === 'credential'
          // Any source may report the cancellation while this waits.
          if (terminalStatusOf(session) === 'cancelled') {
            return { kind: 'aborted' }
          }
        }
        if (input.aborted() || input.disposed() || !input.owns()) {
          return { kind: 'aborted' }
        }
        if (session.closed) return { kind: 'aborted' }
        if (terminalStatusOf(session) === 'cancelled') {
          return { kind: 'aborted' }
        }
        // The run settled, so every signal it had is in hand. Otherwise a channel
        // could still report a rejection, and an unresolved failure is never
        // replayed nor offered for a retry.
        const resolved = session.runDone || settled
        if (evidence.length === 0) evidence.push('the run ended in error')
        return {
          kind: 'failed',
          phase: 'run',
          errors: evidence,
          emitted: reply.content.length > 0,
          ambiguous: !resolved,
        }
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
        return { kind: 'toolUse' }
      }
      await session.waitForChange()
      continue
    }

    // The run is over. A call it left unanswered is abandoned here, before the
    // terminal status decides the attempt, so no host work starts for a run
    // that cannot take its result.
    abandonLateCalls(session)
    const result = session.runResult
    const status = terminalStatusOf(session) ?? result?.status
    // Every signal the run produced: the stream's throw, a rejected wait, the
    // SDK's own live failure, and the reported error. A rejected credential in
    // any of them is terminal, so none may be dropped.
    const errors = [
      session.runError,
      session.runWaitError,
      session.run?.error,
      result?.error,
    ].filter((error) => error !== undefined && error !== null)
    if (status === 'cancelled') return { kind: 'aborted' }
    // A stream that threw did not deliver its output, whatever the provider
    // later reports for the run.
    if (status === 'finished' && errors.length === 0) {
      return { kind: 'stop', result }
    }
    if (errors.length === 0) errors.push('the run ended without a result')
    return {
      kind: 'failed',
      phase: 'run',
      errors,
      emitted: reply.content.length > 0,
      // The run settled here, so every signal it had is in hand.
      ambiguous: false,
    }
  }
}
