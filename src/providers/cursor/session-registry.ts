/**
 * The live Cursor agents one runtime keeps, one slot per conversation.
 *
 * A conversation holds at most one usable agent: a model or parameter change
 * replaces the previous one instead of parking it for a later switch back, whose
 * transcript would already have moved on. The registry performs no I/O and owns
 * no timers; the runtime decides when a session is stored, dropped, or swept.
 */

import type { CursorSession } from './session.js'

/** One slot per conversation key, holding the agents that may serve it. */
export class SessionRegistry {
  private readonly slots = new Map<string, CursorSession[]>()

  /** The agents stored for one conversation, in insertion order. */
  candidates(key: string): CursorSession[] {
    return this.slots.get(key) ?? []
  }

  /** Every live session, flattened; a diagnostic and sweep view. */
  all(): CursorSession[] {
    const out: CursorSession[] = []
    for (const slot of this.slots.values()) out.push(...slot)
    return out
  }

  /**
   * Publish one agent as its conversation's agent, closing whatever else that
   * conversation held: a second live agent for one conversation would let a
   * stale transcript answer a later turn.
   */
  store(session: CursorSession): void {
    for (const entry of this.slots.get(session.key) ?? []) {
      if (entry !== session) entry.close()
    }
    this.slots.set(session.key, [session])
  }

  /** Close one agent and forget it, leaving the conversation registered only if another entry remains. */
  drop(session: CursorSession): void {
    session.close()
    const rest = (this.slots.get(session.key) ?? []).filter(
      (entry) => entry !== session,
    )
    if (rest.length > 0) this.slots.set(session.key, rest)
    else this.slots.delete(session.key)
  }

  /**
   * Close every agent that sat unused past its budget and owns no turn.
   *
   * The rule reads wall-clock time, so a suspended machine cannot extend a
   * lifetime, and it skips a busy agent, so a run longer than the budget is
   * never closed underneath its turn.
   * @param now - the current wall-clock time in milliseconds.
   */
  sweep(now: number): void {
    for (const session of this.all()) {
      if (session.busy) continue
      if (!session.isStale(now)) continue
      this.drop(session)
    }
  }

  /** Close every agent; the runtime calls this on disposal. */
  closeAll(): void {
    for (const slot of this.slots.values()) {
      for (const session of slot) session.close()
    }
    this.slots.clear()
  }

  /** Number of live sessions; a test hook. */
  count(): number {
    let count = 0
    for (const slot of this.slots.values()) count += slot.length
    return count
  }
}
