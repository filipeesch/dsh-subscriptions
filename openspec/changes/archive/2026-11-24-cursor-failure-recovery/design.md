# Design

## Context

See proposal.md - Why for the incident that motivated this change.

The route lives in `src/providers/cursor/`. `runtime.ts` is 1371 lines:
`CursorRuntime` holds the session registry, three separate ownership maps
(`keyGeneration`, `keyAbort`, `reservations`), the calibrated prompt overhead,
prewarm, and `runTurn` — about 485 lines that admit the turn, resolve the
credential, pick the context tier, choose a plan (`fresh`, `send`, `results`),
create or reuse an agent, pump the run, and map any failure through
`safeError()`. `Reply` (`reply.ts`) carries the stream and the transcript-shaped
message; `ERROR_CODES` names three codes, one of which (`CURSOR_RUN_FAILED`) is
used for every failure and sits outside the host's default retry set.

The host retries failed model requests through `@deepseek-ai/dsh-llm-retry` on
the agent loop's request-error hook, using the policy the adapter returns from
`LlmAdapter.providerRetryPolicy()`. `resolveRetryPolicy` and the policy schema
allow any code string from `@deepseek-ai/dsh-llm` `0.1.7-rc.2`, the bottom of
`dsh-versions.txt`, so a route-owned code works across the whole support window.
A host without the retry plugin simply never replays, which the plugin cannot
detect and does not need to.

`CursorSession` measures its idle budget with a `setTimeout` per session. That
timer pauses while the machine is suspended, and it fires without knowing
whether the session owns an active run (`busy`), so a run longer than the budget
can have its agent closed underneath it.

## Goals / Non-Goals

**Goals:**

- Recover a pre-output failure inside the same turn, with a bounded and
  auditable number of provider attempts.
- Let the failure code express what the attempt did, so the host replays only
  work that is safe to replay.
- Make every failed turn diagnosable from one redacted log line.
- Make the idle budget wall-clock and testable by injecting the clock, and never
  close an agent that owns a turn.
- Split the runtime into units with one reason to change each, without changing
  the behavior the current suite already pins.

**Non-Goals:**

- Recovering a process-wide `@cursor/sdk` failure without restarting DSH. The
  SDK exposes no reset, and a fresh agent reuses the same process state; the log
  is the evidence path for that case.
- A health watchdog, a settings toggle for the replay, or a forced SDK
  re-import.
- Any change to the caller-facing failure sentence.
- Replaying a failure after output, pooling several Cursor accounts, or changing
  the tier fallback rules.

## Decisions

### D1 — The replay lives in the runtime, above the pump

`runTurn` becomes a short attempt loop: admit the turn once (the lease is kept
for the whole turn, so a replay is not a new generation), plan, execute one
attempt, and decide. `run-pump.ts` executes one attempt and returns a typed
outcome:

```ts
type Outcome =
  | { kind: 'stop' }
  | { kind: 'toolUse' }
  | { kind: 'aborted' }
  | {
      kind: 'failed'
      phase: 'setup' | 'run'
      errors: readonly unknown[]
      emitted: boolean
    }
```

The loop replays only when `outcome.kind === 'failed'`, `phase`/plan allow it,
`emitted` is false, the cause is replayable, and the turn has not spent its one
replay. Emission is read from `reply.content`, the same object that produced the
stream, so there is no second flag to keep in sync.

The pump decides an outcome only after the run is terminal, and it settles tool
calls the run can no longer answer before it reports anything: a call handed to
the host for a dead run would make the host execute work whose result nobody can
receive. It reads the SDK's live `status` at that boundary, because a run can be
terminal there before its stream drains; a terminal `error` or `cancelled` then
settles the attempt without waiting for that drain, while `finished` still
drains so buffered output is not dropped. The status listener a run installs is
released when that run settles, not only when the agent closes, so a finished
handle the SDK still holds cannot keep a callback on a later turn; one
idempotent release serves both paths, consumed before the SDK callback is
invoked, so a throwing unsubscribe cannot hold up cleanup.

Early settlement is what made the terminal result urgent, so `wait()` now starts
with the stream instead of after it: the result is the SDK's other report of the
failure, and a stream that stalls must not hide a rejected key. A terminal
failure then gets one bounded drain window (`TERMINAL_DRAIN_MS`), whatever
source reported the status: a wake is not proof that either channel is done, so
the pump drains what arrived and keeps waiting until the run settles or the
window closes, and only then reports. A failure still unresolved at the close of
that window is reported without a replay, without a smaller tier, and without a
retryable code: the evidence that never arrived is exactly what a retry must not
gamble on. Ambiguity is one flag on the attempt's outcome, and every follow-up
decision reads it — the replay, the tier fallback, and the code the host sees —
while host-retry eligibility also keeps the replay the route actually ran, so no
path offers a retry it never earned. A cancellation ends the window instead of
waiting for it, because the abort path owns that ending.

A `finished` run is terminal for a different reason: it can no longer accept a
tool result, so its unhanded calls are settled the same way, but its buffered
text and reasoning still drain before the turn publishes a stop. Withholding a
call and draining output are separate questions, and treating `finished` as a
failure would have lost output, while accepting a tool result on it would have
handed the host work nobody could receive.

Three orderings had to be closed for that to hold. One resolver reads the
terminal status from every source — the handle's getter, the status listener,
and the result — so a getter still reporting `running` cannot mask a
notification, and a later `cancelled` outranks an earlier `error`. That resolver
runs at the handoff boundary, after every drain wake, and again before the
settled outcome is published, because a source can turn terminal at any of those
points. A rejection the run has already reported is decisive on its own, so it
blocks the handoff even before any status arrives: a rejected key cannot take a
tool result. And a call that arrives during the drain window is settled on the
next wake rather than at close, because leaving it pending also stalls the
stream the window is waiting for.

Two smaller rules make those work. A stream failure wakes the pump as it is
recorded, so its evidence is not held behind a `wait()` that may never settle,
and it is a failed delivery on its own — whatever status the handle still claims
— so no tool call goes out for a stream that cannot deliver the continuation and
the turn takes the bounded window instead of waiting for a result that may never
come. A status notification is applied only when its run is still the one the
session follows: a retired run can deliver a queued callback after the session
moved on, and that callback must not cancel the work that replaced it. A stream
that throws while the run later reports `finished` is a failed delivery, not a
clean stop: the provider finishing does not prove the host saw the whole stream,
so the pump reports the failure and, when output was already emitted, keeps it
terminal. Every signal a failed run produced — the stream's throw, a rejected
`wait()`, the SDK's live error, and the reported error — travels together to the
classifier, which lets the most terminal cause win; keeping the stream and the
wait failures apart is what stops a rejected credential from being read as the
transport blip next to it.

Alternatives: **host-only retry** (no runtime loop) — rejected because a host
without `dsh-llm-retry` would keep failing, and the first attempt would not
rebuild the agent; **a wrapper adapter around the current adapter** — rejected
because the replay needs the transcript, the tier decision, and the session
registry, all inside the runtime.

### D2 — The output boundary decides the code, and the route owns the policy

- A failure after emitting content reports `CURSOR_RUN_FAILED`, which the host's
  default policy does not retry.
- A failure before output that the replay did not fix reports
  `CURSOR_UNAVAILABLE`, which the route policy retries at most twice. Only a
  failure the route itself attempted is eligible: a request that fails during
  setup never spent a recovery, so it keeps `CURSOR_RUN_FAILED` even though it
  is pre-output. The reporting call derives eligibility from the facts —
  recovery spent, nothing emitted, and a cause a retry could fix — so a caller
  cannot assert a retryable code into existence.
- A rejected credential reports `CURSOR_RUN_FAILED`; a missing key reports
  `MISSING_CREDENTIAL`. Neither is retried.
- A cancelled turn reports `ABORTED`.

The adapter overrides `providerRetryPolicy()` for the `cursor` route with
`resolveRetryPolicy({ mode: 'normal', maxRetries: 2, retryableCodes: ['CURSOR_UNAVAILABLE'] }, ...)`,
so the host replays only the safe class and at most twice. Building it through
`resolveRetryPolicy` keeps the host's own backoff defaults instead of freezing
copies here.

Alternatives: **reuse `TRANSPORT`** — rejected because the failure is local to
the process, and the code is what the log and the session record carry;
**always-retry** — rejected because a broken SDK state would loop on a paid
request; **no policy override** — rejected because a route-owned code is not in
the host's default list, so nothing would ever be replayed.

### D3 — One replay, shared with the tier fallback, three attempts total

Order inside the turn: first a rejected context tier retries the smaller tier
(unchanged, still one retry, only on a fresh run that emitted nothing); then a
replayable failure rebuilds the agent and runs again. The turn never exceeds
three provider attempts. The replay seeds the new agent with the full current
history and marks the run as its first model call, so prompt-overhead
calibration behaves as it does for any fresh agent.

### D4 — One warning line from a closed diagnostic vocabulary

`failure.ts` classifies into a cause the route can defend: `credential`,
`unreachable`, `parameters`, or `local` (the default), and the phase reported by
the pump (`setup` while creating or sending, `run` once a run exists). The
credential test reads the SDK's structured name, code, and status before the
message, because an expired key's text names no status, and the run's reported
error keeps those fields through the pump. Free text counts only when it marks
the status as one (`HTTP 401`, `status=403`) or carries authentication wording:
a bare `401` is a substring of identifiers and byte counts, and reading it as a
rejection would stop a recoverable turn from replaying. The line goes through
the existing `onWarn` sink, which the plugin wires to `ctx.logger.warn`:

```text
dsh-subscriptions: Cursor failed before output (phase=setup, cause=local): <detail>
```

The detail is a reviewed literal, never provider text: `local store failure`,
`agent state lost`, `stream timed out`, `stream closed early`, `rate limited`,
`quota exhausted`, `transport unreachable`, the cause-level literals
`credential rejected` and `model parameters rejected`, and
`unclassified failure` for anything the route has not reviewed. Allowlisted
structured fields may follow it, and every one of them is a membership test or a
validated number: a class name from the reviewed set, a code from the reviewed
set, an HTTP status the SDK reports as a number. Nothing is read out of a
message, so a request fragment shaped like a status or an error name cannot be
reproduced. The caller-facing sentence stays exactly what it is today.

Alternatives: **redacting the SDK message** (key by exact match, request text by
fragment, whitespace collapsed) — rejected by review: a short prompt, a
whitespace-normalised tool result, and a clipped excerpt of a long prompt all
survived it, and any residual text is a possible echo; **log only
name/code/status** — rejected because it says nothing about which local failure
happened, which is the question this warning exists to answer; **add the class
to the user sentence** — declined by the product decision: the message stays
unchanged.

### D5 — Wall-clock lifetime owned by the registry

`CursorSession` keeps `lastUsedAt` and loses its timer. `SessionRegistry` owns a
single `sweep(now)` that closes sessions whose `now() - lastUsedAt` exceeds
their budget (20 minutes, or 60 with a pending call) and that are not `busy`;
the runtime schedules it with `setInterval(…, 60_000).unref()`. A turn also
checks the candidate's age at start, so a sweep that has not run yet cannot hand
out a stale agent. `now` is an injected function, which makes both paths
testable by advancing a variable instead of the process clock.

Alternatives: **keep per-session timers** — rejected: they pause during
suspension, never consult `busy`, and cannot be tested without real time;
**wall-clock check only, no sweep** — rejected because idle agents would keep
their handles until a whole minute of the next turn, and nothing would close
them between turns.

### D6 — Six modules behind a thin façade

- `session.ts`: the agent and run handles, pending calls, seen fingerprints,
  `lastUsedAt`, and `busy`.
- `session-registry.ts`: slots per conversation, find/store/drop/close-all, and
  the idle sweep.
- `turn-gate.ts`: turn sequence, reservations, per-conversation generation and
  abort, and the expiry sweep; one `TurnLease` is the single handle to the three
  maps, so a caller cannot reach one without the others.
- `agent-factory.ts`: agent creation with the disposed/aborted/superseded
  guards, tool sync, and the warmup.
- `run-pump.ts`: events to `Reply`, the tool handoff, and the terminal outcome.
- `turn-plan.ts`: `planIncrement` and the `Plan` type.
- `failure.ts`: classification, codes, the reviewed detail vocabulary, and the
  route retry policy.
- `runtime.ts`: the façade — gate, registry, factory, pump, and policy; the
  attempt loop; calibration; and the hooks `sessionCount`, `turnState`,
  `overheadFor`, `dispose`.

The façade keeps the hooks the specs reach through a cast, and re-exports the
moved agent/gateway types so `test/cursor-stream.spec.ts` and
`test/cursor-provider.spec.ts` keep their imports. `CursorAdapter.stream()`
keeps reserving the turn at call time before the generator runs; that ordering
guarantee moves into the gate, not away.

Alternatives: **four modules** (session/turn/factory/failure) — rejected as the
halfway point that still leaves the pump and the plan tangled; **the current
single file** — rejected as the reason a failure policy has to be edited in the
middle of a 485-line function.

### D7 — Prewarm and the terminal guard

`prewarm` keeps a promise latch, but a warmup that fails before its run exists
clears it, so the next live catalog read retries; a run the warmup itself
cancelled rejects its own wait and counts as the warmup's expected end. The
`finally` that unconditionally finished every turn with
`Cursor turn ended without a result` becomes an explicit `if (!reply.settled)`
guard, which is what actually protects a path that returns without finishing.

## Risks / Trade-offs

- **A replay doubles the paid work of the failed turn** → it runs only when
  nothing was emitted and only once per turn; the host's two retries are the
  only further attempts, and each is visible in the session record.
- **The host replays the full transcript up to twice more** → the policy is
  narrow (one code, two retries) and depends on the same rebuild, so a
  persistent failure stops after the budget instead of looping.
- **A process-wide SDK failure now takes seconds longer to surface** (one
  in-turn attempt plus host backoff) → accepted; the log line names the cause,
  which is what the incident lacked.
- **The split can regress lifecycle ordering, where the suite is strongest** →
  the tasks order the work as behavior-preserving extractions, each verified by
  the existing suite before the behavior changes land.
- **Wall-clock time can jump** (clock change) → the rule only decides whether to
  reuse an agent, and a wrong decision costs one rebuild, never correctness.
- **An unfamiliar failure printed as `unclassified failure` says little** → the
  structured fields still name the shape, and extending the vocabulary is a code
  change with a test, which is the trade chosen over printing provider text.
- **A failure the vocabulary mislabels looks like a different one** → the cause
  class, the literal, and the structured fields are derived independently, so a
  wrong label still leaves evidence; the route never decides behavior from the
  literal, only from the classification.
- **A non-builtin code is opaque to consumers that expect the host's list** →
  the retry schema accepts it, the session record stores it as a string, and the
  caller-facing message is unchanged.

## Migration Plan

No stored state changes: `cursor-settings.json`, `cursor-catalog.json`, and
`cursor-context-windows.json` keep their shape. No configuration key is added or
removed. Rollback is reverting the change: the route then reports the old code
and the host stops replaying, with no data to undo.
