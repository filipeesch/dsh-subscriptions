/**
 * Which turn may act on one conversation, and how it is cancelled.
 *
 * Three questions share one answer here: a later stream call owns the
 * conversation even though an earlier one started its setup first (ordering); a
 * newer turn cancels the work an older one dispatched (supersession); and a
 * stream that never reached a turn must not take ownership later (reservation
 * expiry). A turn that owns the conversation holds a {@link TurnLease}, and
 * releasing it retires that ownership.
 */

/** One reserved stream; releasing is idempotent. */
export interface TurnReservation {
  readonly seq: number
  readonly at: number
  released: boolean
  /** Admitted turns own their session until their own cleanup releases it. */
  admitted: boolean
  release(): void
}

/** Ends a turn whose caller cancelled while an async boundary was open. */
export class TurnAborted extends Error {}

/** What an admitted turn may do to its conversation. */
export interface TurnLease {
  /** Turn order assigned when the stream was reserved. */
  readonly generation: number
  /** Host cancellation, runtime lifetime, and supersession, combined. */
  readonly signal: AbortSignal
  /** Resolves when any of those cancellations fires. */
  readonly aborted: Promise<'aborted'>
  /** Whether this turn still owns the conversation. */
  owns(): boolean
  abortedNow(): boolean
  /** Detach the abort listener and retire this turn's ownership; idempotent. */
  release(): void
}

/** What one admission needs from the turn. */
export interface AdmitInput {
  /** Conversation the turn belongs to. */
  sessionKey: string
  /** The adapter's reservation for this stream, when it made one. */
  reservation?: TurnReservation
  /** Adapter-assigned order, used when there is no reservation. */
  turnSeq?: number
  /** The host's own cancellation for this call. */
  signal?: AbortSignal
  /** Woke when the turn is cancelled, so a waiting turn re-reads its state. */
  wake?: () => void
}

/** Turn ordering, reservations, and cancellations for one runtime. */
export class TurnGate {
  private turnSeq = 0
  /** Reserved streams per conversation key, released when each one ends. */
  private readonly reservations = new Map<string, TurnReservation[]>()
  /** Newest turn per conversation; an older create must not publish. */
  private readonly newest = new Map<string, number>()
  /** Cancels the work of a turn a newer one superseded. */
  private readonly aborting = new Map<string, AbortController>()

  constructor(
    private readonly options: {
      /** The runtime's lifetime; every turn is cancelled with it. */
      lifetime: AbortSignal
      /** How long a reserved stream may wait before admission; default 60s. */
      reservationTtlMs?: number
    },
  ) {}

  /** Order a turn before its async setup starts. */
  beginTurn(): number {
    this.turnSeq += 1
    return this.turnSeq
  }

  /**
   * Reserve a turn for a known session before its setup starts. The handle is
   * released when the stream closes, finishes, or expires, so a generation
   * entry is retired only once no reserved stream can still run.
   */
  reserveTurn(sessionId?: string): TurnReservation {
    const seq = this.beginTurn()
    const key =
      sessionId !== undefined && sessionId.length > 0 ? sessionId : undefined
    const reservation: TurnReservation = {
      seq,
      at: Date.now(),
      released: false,
      admitted: false,
      release: () => this.releaseReservation(key, reservation),
    }
    if (key !== undefined) {
      this.reservations.set(key, [
        ...(this.reservations.get(key) ?? []),
        reservation,
      ])
    }
    return reservation
  }

  /**
   * Admit the turn, or refuse it when it no longer owns the conversation.
   * @returns the lease, or `undefined` when the turn must end aborted.
   */
  admit(input: AdmitInput): TurnLease | undefined {
    const key = input.sessionKey
    const reservation = input.reservation
    if (reservation !== undefined) {
      const ttl = this.options.reservationTtlMs ?? 60_000
      if (Date.now() - reservation.at > ttl) {
        // An abandoned stream must not take ownership later.
        reservation.release()
        return undefined
      }
      // Admitted before the first await: the expiry sweep must never take an
      // active conversation's ownership away.
      reservation.admitted = true
    }
    const generation = reservation?.seq ?? input.turnSeq ?? this.beginTurn()
    const prior = this.newest.get(key) ?? 0
    if (generation < prior) {
      this.releaseOwnership(reservation)
      return undefined
    }
    // A newer turn cancels the work the older one already dispatched; the
    // older turn's signal then aborts its own races and late handles.
    let controller = this.aborting.get(key)
    if (generation > prior) {
      controller?.abort()
      controller = new AbortController()
      this.aborting.set(key, controller)
      this.newest.set(key, generation)
    }
    controller ??= new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      this.options.lifetime,
      ...(input.signal === undefined ? [] : [input.signal]),
    ])
    const owns = () => this.isCurrent(key, generation)
    let resolveAbort!: () => void
    const aborted = new Promise<'aborted'>((resolve) => {
      resolveAbort = () => resolve('aborted')
    })
    if (signal.aborted) resolveAbort()
    const onAbort = () => {
      resolveAbort()
      input.wake?.()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    let released = false
    // Every early exit past this point must release the listener and the
    // controller; only the current turn may delete the key's entries.
    const release = () => {
      if (released) return
      released = true
      signal.removeEventListener('abort', onAbort)
      if (this.aborting.get(key) === controller) this.aborting.delete(key)
      this.releaseOwnership(reservation)
      this.expire()
    }
    return {
      generation,
      signal,
      aborted,
      owns,
      abortedNow: () => signal.aborted,
      release,
    }
  }

  /** Whether `generation` still owns `key`, for a late asynchronous handle. */
  isCurrent(key: string, generation: number): boolean {
    return (this.newest.get(key) ?? 0) === generation
  }

  /** Drop reservations whose stream never reached a turn. */
  expire(): void {
    const ttl = this.options.reservationTtlMs ?? 60_000
    const now = Date.now()
    for (const list of [...this.reservations.values()]) {
      for (const reservation of [...list]) {
        // An admitted turn owns its conversation until its own cleanup; only
        // a stream that never reached the runtime may expire.
        if (reservation.admitted) continue
        if (now - reservation.at > ttl) reservation.release()
      }
    }
  }

  /** Cancellation state sizes; a test hook. */
  state(): { controllers: number; generations: number; reservations: number } {
    let reservations = 0
    for (const list of this.reservations.values()) reservations += list.length
    return {
      controllers: this.aborting.size,
      generations: this.newest.size,
      reservations,
    }
  }

  /** Forget every turn; the runtime calls this on disposal, after aborting. */
  clear(): void {
    this.aborting.clear()
    this.newest.clear()
    this.reservations.clear()
  }

  private releaseOwnership(reservation: TurnReservation | undefined): void {
    reservation?.release()
    this.expire()
  }

  private releaseReservation(
    key: string | undefined,
    reservation: TurnReservation,
  ): void {
    if (reservation.released) return
    reservation.released = true
    if (key === undefined) return
    const left = (this.reservations.get(key) ?? []).filter(
      (entry) => entry !== reservation,
    )
    if (left.length > 0) {
      this.reservations.set(key, left)
      return
    }
    this.reservations.delete(key)
    // Every reserved stream for this conversation is done: nothing older can
    // still arrive, so the generation entries can be retired.
    this.newest.delete(key)
    this.aborting.delete(key)
  }
}
