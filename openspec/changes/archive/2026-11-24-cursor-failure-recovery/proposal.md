# Proposal

## Why

On 2026-11-24 at 10:06, after 17 hours without activity, a Cursor turn in a
QuintoAndar planning conversation failed twice with the generic sentence
`Cursor failed while trying to run the model.` Both attempts arrived about 100
ms after the request started, emitted no content, and the next turn in the same
process failed the same way; only restarting DSH recovered the route. The
runtime drops the SDK's cause, never rebuilds an agent that fails before it
produces anything, and reports every failure with one code the host does not
retry, so a transient or process-local failure costs the turn and leaves nothing
to diagnose.

## What Changes

- Recover before output: when an attempt fails before emitting any content (no
  text, no reasoning, no handed tool call), drop the agent and replay the turn
  once from the full history with a fresh agent.
- Split failure reporting at the output boundary: a pre-output failure that
  survives the replay reports the new `CURSOR_UNAVAILABLE` code, and the route
  publishes a retry policy that lets the host retry that code only, at most
  twice. A post-output failure keeps `CURSOR_RUN_FAILED`, outside the host's
  default retry set, so a half-finished run is never replayed.
- Diagnose failures: one warning line per failed turn (phase, cause class, and a
  detail from the route's own reviewed vocabulary plus allowlisted structured
  fields) reaches the plugin's warning sink, with no provider text, no
  credential and nothing the request carried. The user-facing sentence is
  unchanged.
- Bound agent lifetime by wall clock: a turn checks the session's last-used time
  against its idle budget before reusing it, and one sweep in the session
  registry closes idle agents that own no turn. The per-session timers go away;
  they pause while the machine sleeps and could close a session with an active
  run.
- Split the runtime: `runTurn` (about 485 lines, seven responsibilities) becomes
  `session.ts`, `session-registry.ts`, `turn-gate.ts`, `agent-factory.ts`,
  `run-pump.ts`, `turn-plan.ts`, and `failure.ts` behind a thin `runtime.ts`
  façade that keeps the existing hooks.
- Fix two defects the split exposes: a failed prewarm no longer disables warmup
  for the life of the process, and the unconditional `finally` that finished
  every turn as an error becomes an explicit guard.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `providers/cursor`: failure semantics split at the output boundary, plus new
  requirements for recovery before output, failure diagnostics, and wall-clock
  agent lifetime.

## Impact

- `src/providers/cursor/`: the runtime split into the modules above, the new
  `CURSOR_UNAVAILABLE` code, and the route's retry policy.
- `src/providers/cursor/adapter.ts`: overrides `providerRetryPolicy` for the
  `cursor` route.
- Tests: `test/cursor-stream.spec.ts` and `test/cursor-provider.spec.ts` for
  imports and hooks, plus new specs for recovery, classification, redaction, the
  retry policy, and the idle sweep.
- Docs: `docs/cursor.md` states the recovery path, the failure codes, the
  diagnostic line, and the lifetime rule; a provider Agent Note records why the
  replay exists only before output.
- Host API: `LlmAdapter.providerRetryPolicy` and `resolveRetryPolicy` exist from
  `0.1.7-rc.2`, the window floor, and that version's retry schema accepts a
  custom code. No new dependency, no configuration option, and no user-visible
  message change.
