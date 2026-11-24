/**
 * How new transcript messages map onto the live Cursor agent.
 *
 * A Cursor agent is fed only what is new, so the mapping is a pure decision
 * over the agent's own memory (what it has seen, what it is waiting on) and the
 * host's current transcript. Nothing here performs I/O: the runtime acts on the
 * returned plan.
 */

import { fingerprint, imagesOf, incrementText } from './prompt.js'
import type { Image } from './prompt.js'
import type { CursorSession, PendingCall } from './session.js'

/** Tool results the host sent back, in the order the agent asked for them. */
export type Results = {
  call: PendingCall
  message: Record<string, unknown>
  extra?: string
}[]

/** How new messages map onto the live Cursor session. */
export type Plan =
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
