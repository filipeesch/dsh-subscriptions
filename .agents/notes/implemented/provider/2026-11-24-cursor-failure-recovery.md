# Agent Note: Cursor turns recover before output

Status: implemented

## Problem

On 2026-11-24 at 10:06, after 17 hours without activity, a Cursor turn failed
twice with `Cursor failed while trying to run the model.` Each attempt ended
about 100 ms after the request started, emitted no content, and the next turn in
the same process failed the same way; only restarting DSH recovered the route.
Three properties of the route made that unrecoverable and undiagnosable: any
failure ended the turn without rebuilding the agent, one code covered every
failure and sat outside the host's retry set, and the SDK's own message was
discarded, so the session carried a generic sentence and nothing else.

The lifetime rule was a second latent defect. `CursorSession` kept a per-session
`setTimeout`, which pauses while the machine is suspended, and which fires
without consulting `busy`, so a run longer than the budget could have its agent
closed underneath it.

## Decision

A turn now replays once when an attempt fails before emitting text, reasoning,
or a tool call: the agent is dropped and a new one receives the full history.
Emission is read from the reply's own content, so there is no second flag to
keep in sync, and the replay shares the turn's lease, so it is not a new
generation. A failure after output is never replayed, because repeating a
half-finished run would send part of the turn twice. With the existing
smaller-tier retry, one turn makes at most three provider attempts.

The failure code now follows the boundary. A pre-output failure that survives
the replay reports `CURSOR_UNAVAILABLE`; the adapter publishes a retry policy
built through `resolveRetryPolicy` that repeats only that code, at most twice. A
failure after output, a rejected API key, and rejected model parameters report
`CURSOR_RUN_FAILED`, outside the host's default retry list. A cancelled turn
still reports `ABORTED`.

Every failed turn records one warning through the runtime's `onWarn`, which the
plugin wires to `ctx.logger.warn`. `classifyFailures` folds every signal a
failed run produced — the thrown value and the run's reported error — mapping it
to a cause (`credential`, `unreachable`, `parameters`, `local`) from the SDK's
structured name, code, and status before its message — free text counts only
when it marks the status as one or carries authentication wording, because a
bare `401` occurs inside identifiers and would block a recoverable replay — with
the most terminal cause winning: a transport failure that also reports a
rejected credential is a rejected credential, and one that also reports rejected
parameters is a parameter rejection, so neither is replayed nor allowed to try a
smaller tier. The session keeps the stream's throw and a rejected `wait()`
apart, and the pump carries the phase (`setup`, `run`) with every signal —
folding them early is how a rejected credential once got read as the transport
blip next to it.

The warning detail is a reviewed literal from the route's own vocabulary —
`local store failure`, `agent state lost`, `stream timed out`,
`stream closed early`, `rate limited`, `quota exhausted`,
`transport unreachable`, `credential rejected`, `model parameters rejected`, or
`unclassified failure` — optionally followed by allowlisted structured fields,
each a membership test or a validated number: a class name from the reviewed
set, a code from the reviewed set, an HTTP status the SDK reports as a number.
Provider text never reaches the log, and nothing is read out of it: redacting
the message failed review against a short prompt, a whitespace-normalised tool
result and a clipped excerpt, and reading values out of it failed too — an error
name shaped like a real one and a request fragment shaped like `HTTP 478` both
came through. The sentence in the conversation stays the fixed one. A missing
key is logged as well, so a logged-out route is visible in the same place, and a
request rejected during setup — the credential read before any agent exists —
ends in the same reporting from the adapter instead of throwing.

Only a failure the route itself attempted is host-retryable. The reporting call
takes `recoverySpent` as a fact and derives eligibility from it, from whether
output was emitted, and from the cause, so no caller can assert a retryable code
and a rejected credential can never obtain one. A setup failure, which never had
a recovery, keeps `CURSOR_RUN_FAILED`. The pump also decides nothing while the
run can still act: it settles tool calls a terminated run can no longer answer
before it reports its status, reads the SDK's live `status` at that boundary
because a run can be terminal before its stream drains — settling a terminal
failure without waiting for that drain, while `finished` still drains for its
buffered output — releases each run's status listener when the run settles
rather than when the agent closes, and settles a callback that arrives after
close instead of leaving it pending. The attachment fallback keeps a fixed line
of its own, with no reader exception and no raw attachment identifier. A stream
that throws is a failed delivery even when the run later reports `finished`,
because the provider finishing does not prove the host saw the whole stream;
output already emitted keeps that failure terminal.

Early settlement made the terminal result urgent, so `wait()` now starts with
the stream rather than after it: it is the SDK's other report of the failure,
and a stalled stream must not hide a rejected key. A terminal failure then gets
one bounded drain window (`TERMINAL_DRAIN_MS`) whichever source reported the
status, because a wake is not proof that either channel is done; a failure still
unresolved at the close of that window is reported with no replay, no smaller
tier and no retryable code. One ambiguity flag on the outcome feeds every
follow-up decision, and host-retry eligibility additionally keeps the replay the
route actually ran, so nothing offers a retry it never earned. A cancellation
ends the window rather than waiting for it.

A `finished` run withholds its unhanded calls like any terminal run but still
drains its buffered output before publishing a stop: withholding a call and
delivering output are separate questions, and a fake that reports `finished`
while it can still accept a tool result is simply wrong. Three orderings close
that rule out: one resolver reads the terminal status from the handle's getter,
the listener and the result, so a stale `running` cannot mask a notification and
a later `cancelled` outranks an earlier failure, and that resolver runs at the
handoff boundary, after every drain wake and before the settled outcome is
published; a rejection the run already reported blocks the handoff before any
status arrives; and a call that arrives during the drain window is settled on
the next wake, because leaving it pending also stalls the stream. Two smaller
rules keep the evidence honest: a stream failure wakes the pump as it is
recorded and is a failed delivery on its own — no tool call goes out for a
stream that cannot deliver the continuation, and the turn takes the bounded
window rather than waiting for a result that may never come — and a status
callback applies only when its run is still the one the session follows, so a
retired run cannot cancel its successor.

The lifetime rule is wall clock. `CursorSession` records `lastUsedAt` and its
budget (20 minutes, or 60 while a tool call is pending), `SessionRegistry.sweep`
closes stale agents that own no turn, the runtime runs it every minute, and a
turn sweeps before it looks for an agent to reuse. The clock is injected, so a
test advances it instead of waiting.

The runtime split into `session`, `session-registry`, `turn-gate`,
`agent-factory`, `run-pump`, `turn-plan`, and `failure` behind the same
`CursorRuntime` façade and the same adapter contract; the three ownership maps
sit behind one `TurnLease`. A warmup that fails before its run exists clears its
latch, so the next live catalog read tries the warmup again instead of leaving
it off for the process's life.

## Alternatives considered

- **Rely on the host's retry only, with no replay.** The host repeats a request
  with the same transcript, but it cannot rebuild the agent, and a host built
  without `dsh-llm-retry` would keep failing. The replay is also cheaper for the
  user: it happens inside the turn instead of after a visible error.
- **Report `TRANSPORT` for every pre-output failure.** It reuses a builtin code
  and needs no policy override, but it states that the network failed when the
  failure may be local to the process, which is exactly the distinction the log
  exists to record.
- **Retry with `mode: 'always'`.** A broken process state would loop on paid
  requests instead of ending with a diagnosable failure.
- **Redact the provider's message instead of replacing it.** It keeps more
  detail per failure, and the first implementation did it: the key by exact
  match, the request's text by fragment, whitespace collapsed. Review broke it
  three ways — a short prompt under the fragment floor, a tool result the SDK
  normalised, a clipped excerpt of a long prompt — and any surviving text is a
  possible echo. A closed vocabulary trades the message for a guarantee.
- **Put the failure class in the sentence the conversation shows.** Rejected by
  the product decision: the caller-facing text stays exactly as it was. The
  class lives in the warning instead, with the reviewed detail.
- **Keep the per-session timers and add the sweep on top.** Two rules for one
  lifetime would disagree after a suspension, and the timer still could not see
  `busy`.
- **Add a health watchdog or a forced SDK re-import.** A watchdog needs a
  failure rate the route has not observed yet, and re-importing the SDK module
  would run two copies of its runtime in one process. The honest limit stays: a
  process-wide SDK failure needs a DSH restart, and the new warning is what
  makes that case identifiable.
- **Keep the runtime in one file and add the policy inside it.** That is what
  made a five-line failure rule live in the middle of a 485-line function; the
  split is what gives the recovery, the budget, and the warning one owner each.

## Consequences

A transient or process-local Cursor failure now costs one extra full-history
send instead of a dead turn, and the host may repeat the turn twice more when
the replay also failed. A persistent SDK failure takes a few seconds longer to
surface, and still needs a restart, but the warning names it. The adapter's
contract, the user-facing sentence, the stored catalog and settings, and the
configuration surface are unchanged; the package gains no dependency, because
`providerRetryPolicy` and `resolveRetryPolicy` exist across the whole supported
DSH window.

Coverage: `test/cursor-failure.spec.ts` covers classification by structured
field, the cause precedence, the fixed sentences, the reviewed literals and the
placeholder, the allowlisted structured fields, and the warning line; the Cursor
stream and provider specs cover the replay and its budget, the suppressed replay
after output, a structured credential rejection both thrown and reported, both
signals on one run, a credential that outranks parameter wording, a
request-echoing message, a message quoting the resolved key, the tier a replay
must keep, a parameter rejection that arrives as a rejected wait, a cancellation
landed behind the pump, a setup rejection that never reaches the runtime, a run
that ends during the handoff debounce, a broken stream with and without partial
output, the retry policy, the wall-clock sweep, the retried prewarm, and the
reply's one-shot finish. What remains untested is the SDK's own failure
vocabulary, which the fakes only approximate, the host's retry executor end to
end — the route publishes the policy, but no spec drives `dsh-llm-retry` itself
— and the exact interleaving of a cancellation that lands in the one microtask
between the pump's decision and its publication, which the runtime's recheck now
covers but only a replaced pump can reach deterministically.

Related: the [key-route decision](2026-11-21-cursor-key-route.md) explains why
Cursor is a key-based route and what the SDK seam covers, and the
[capacity decision](2026-11-23-cursor-capacities-and-manager.md) records why the
window resolves in this order.
