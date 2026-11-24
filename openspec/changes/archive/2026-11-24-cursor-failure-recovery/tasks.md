# Tasks

## 1. Baseline and behavior-preserving extraction

- [x] 1.1 Record the baseline: run
      `pnpm install --frozen-lockfile && pnpm build && pnpm test` on the branch
      before touching `src/providers/cursor`; every command exits 0 and the
      Cursor specs pass unchanged
- [x] 1.2 Move `planIncrement`, the `Plan`/Results types and the increment
      helpers into `turn-plan.ts`, re-exporting `planIncrement` from
      `runtime.ts`; verify `pnpm test` passes with no spec edits
- [x] 1.3 Move `CursorSession` into `session.ts` and re-export the moved types
      (`CursorSession`, `CursorAgent`, `CursorAgentOptions`, `CursorEvent`,
      `CursorRun`, `CursorRunResult`, `CursorGateway`) from `runtime.ts`; verify
      `pnpm build && pnpm test` pass without changing a spec import
- [x] 1.4 Extract `SessionRegistry` (`sessions`, `store`, `drop`, `closeAll`,
      `sessionCount`) into `session-registry.ts`, leaving the per-session timers
      in place for now; verify `pnpm test` passes, including agent reuse and the
      `dispose` assertions
- [x] 1.5 Extract `TurnGate` into `turn-gate.ts` with turn sequence,
      reservations, per-conversation generation and abort behind one
      `TurnLease`, and have `reserveTurn`/`turnState` delegate to it; verify
      `pnpm test` passes, especially the supersession, abandoned-reservation and
      admitted-expiry specs
- [x] 1.6 Extract `AgentFactory` into `agent-factory.ts` with creation options,
      tool sync, the disposed/aborted/superseded guards and warmup; verify
      `pnpm test` passes, especially the blocked-create cancel/dispose and
      prewarm specs
- [x] 1.7 Extract `RunPump` into `run-pump.ts`, returning the typed `Outcome`
      from design D1 while `runTurn` keeps today's replies; verify `pnpm test`
      and `pnpm lint` pass

## 2. Failure classification, codes and diagnostics

- [x] 2.1 Create `failure.ts` with `classifyFailure(error, phase)` (cause
      `credential`, `unreachable`, `parameters` or `local`, plus replayability),
      `redactDetail(text, secret)`, and a sentence builder that reproduces
      today's strings byte for byte; verify a new `test/cursor-failure.spec.ts`
      covers every cause, the key substitution, newline collapsing, and the
      200-character cap, and `pnpm test` passes
- [x] 2.2 Add the `CURSOR_UNAVAILABLE` code and override `providerRetryPolicy()`
      in `CursorAdapter` with
      `resolveRetryPolicy({ mode: 'normal', maxRetries: 2, retryableCodes: ['CURSOR_UNAVAILABLE'] })`
      for the `cursor` route; verify `test/cursor-provider.spec.ts` asserts the
      resolved policy and that the other routes return `undefined`, and
      `pnpm build && pnpm test` pass
- [x] 2.3 Emit one warning per failed turn through `onWarn` with phase, cause
      and the redacted detail; verify `test/cursor-stream.spec.ts` captures
      `onWarn` and asserts one line per failure, the `setup` and `run` phases,
      the `[key]` substitution, and that the caller-facing message is unchanged

## 3. Recovery before output

- [x] 3.1 Turn `runTurn` into the bounded attempt loop from design D1/D3: keep
      one lease for the turn, replay at most once when the attempt failed with
      no content and a replayable cause, seed a new agent from the full history,
      and report `CURSOR_UNAVAILABLE` only when the replay also fails before
      output; verify new specs recover from a gateway that fails once, end with
      `CURSOR_UNAVAILABLE` when it fails twice, and create no second agent after
      a failure that emitted text
- [x] 3.2 Hold the budget with the tier fallback: a rejected context tier
      followed by a replayable failure stays within three provider attempts, and
      a rejected credential is never replayed; verify the specs assert agent and
      send counts for both scripts and the auth sentence with
      `CURSOR_RUN_FAILED`
- [x] 3.3 Keep the tool-handoff path correct under the loop: a pre-output
      failure while continuing with new tools replays with the current tools and
      delivers each tool result exactly once; verify the extended tool-change
      specs assert one delivery

## 4. Wall-clock lifetime

- [x] 4.1 Track `lastUsedAt` on `CursorSession` and inject `now()` into the
      registry, then remove the per-session timers; verify `pnpm test` passes
      with no real-time dependence
- [x] 4.2 Implement `SessionRegistry.sweep(now)` closing a session past its
      budget (20 minutes, 60 with a pending call) that is not `busy`, and
      schedule it from the runtime at 60 s with `unref()`; verify specs advance
      the injected clock and assert a closed idle agent, an untouched busy
      agent, and the longer pending-tool budget
- [x] 4.3 Check the candidate's age when a turn starts and open a fresh agent
      instead of reusing a stale one; verify a spec with an old `lastUsedAt`
      asserts a new `createAgent` instead of a `send` on the old agent

## 5. Defects the split exposes

- [x] 5.1 Clear the prewarm latch when warmup rejects so a later catalog read
      retries it; verify a spec rejects the first warmup and asserts the next
      catalog read creates an agent again
- [x] 5.2 Replace the unconditional `finally` failure finish with an explicit
      unsettled guard; verify `pnpm test` passes and a spec asserts a normally
      finished turn never reports the fallback sentence

## 6. Documentation and release notes

- [x] 6.1 Update `docs/cursor.md` with the recovery path, the two failure codes,
      the route retry policy, the diagnostic line and the wall-clock lifetime
      rule; verify `npx --yes markdownlint-cli2@0.22.0` and `pnpm format:check`
      pass
- [x] 6.2 Write
      `.agents/notes/implemented/provider/2026-11-24-cursor-failure-recovery.md`
      covering the pre-output replay, why post-output failures stay terminal,
      the diagnostics contract and the wall-clock lifetime, with alternatives
      and consequences; verify `node scripts/verify-agent-notes.mjs` exits 0
- [x] 6.3 Add the `CHANGELOG.md` entry and set the plugin version in
      `package.json` for the release this change ships in; verify
      `pnpm format:check` passes and the entry states the recovery, the
      retryable code and the diagnostic warning

## 7. Gates

- [x] 7.1 Run `pnpm build`, `pnpm test`, `pnpm lint` and `pnpm format:check`;
      every command exits 0
- [x] 7.2 Run the repository checks `node scripts/verify-agent-notes.mjs`,
      `node scripts/check-markdown-tables.mjs` and
      `node scripts/check-compat-docs.mjs`; every command exits 0
- [x] 7.3 Run `bash scripts/host-e2e.sh` with `CHROME_BIN` set, because the
      change touches the streaming failure path; verify it passes, or record
      that CI covers it on every supported DSH version. Local run on
      `0.2.2-rc.5` exited 2, the scripted harness failure: the driver did not
      find the composer in a locally localized UI while the page rendered with
      no console exception and no outside request. The client bundle is
      untouched by this change, and CI runs this gate on every supported version
- [x] 7.4 Run `openspec validate cursor-failure-recovery --strict` and confirm
      `openspec status` shows every artifact done before opening the PR

## 8. Review findings (fixed after the first review pass)

- [x] 8.1 Classify a rejected credential from the SDK's structured name, code
      and status, and carry the run's reported error object through the pump;
      verify a thrown `AuthenticationError` and a run error with
      `code: unauthenticated` each make one attempt and report
      `CURSOR_RUN_FAILED`
- [x] 8.2 Redact the request's own text from the warning detail; verify a
      failure whose detail echoes a transcript marker logs `[content]` and not
      the marker
- [x] 8.3 Carry the effective tier and fallback flag across a replay, and use
      the failure's message for the parameter-rejection check; verify
      `1m -> 200k -> 200k` and a rejecting `wait()` that still falls back
- [x] 8.4 Recheck cancellation and lease ownership right after the pump
      resolves, before publishing stop, fallback or failure; verify a cancel
      landed behind the pump ends aborted and drops the agent
- [x] 8.5 Report a request-setup rejection at the stream boundary with the same
      sentence, warning and code; verify a rejecting credential resolver ends
      the stream instead of throwing
- [x] 8.6 Narrow the prewarm claim to the next live catalog read and drop the
      write-only warmup handle fields; verify the note, the design and the code
      comment agree
- [x] 8.7 Strengthen the specs the review called out: closed handles, the replay
      payload, the replayed tool set, a reasoning-only failure, and the reply's
      one-shot finish
- [x] 8.8 Tighten the standing doc, the changelog entry, the delta scenario and
      the design wording the review flagged
- [x] 8.9 Re-run every gate after the fixes

## 9. Second review findings (fixed after the second review pass)

- [x] 9.1 Replace message redaction with a closed diagnostic vocabulary plus
      allowlisted structured fields, and apply it to run and setup reporting;
      verify the unit and stream specs pin every literal, the placeholder, and
      the absence of request text and the resolved key
- [x] 9.2 Fold every signal of one failed run and let the most terminal cause
      win; verify a thrown transport error plus a reported 401 is terminal, and
      a structured 401 outranks parameter wording so no tier is tried
- [x] 9.3 Make host-retry eligibility an explicit reporting input, true only
      once recovery was spent; verify a setup failure reports
      `CURSOR_RUN_FAILED`
- [x] 9.4 Decide the pump outcome only after the run is terminal and settle tool
      calls a dead run can no longer answer; verify a run that ends during the
      handoff debounce hands no call and closes its agent
- [x] 9.5 Treat a stream that breaks as a failed delivery even when the run
      reports finished; verify the empty case replays and the partial case stays
      terminal
- [x] 9.6 Update the delta scenarios, the design, the standing doc, the
      changelog and this note to the vocabulary and the new rules
- [x] 9.7 Re-run every gate after the second-pass fixes

## 10. Third review findings (fixed after the third review pass)

- [x] 10.1 Print an error class name only when it is one of the reviewed SDK
      classes, and never read a status out of provider text; verify an
      error-shaped unknown name and a message quoting `HTTP 478` both log the
      placeholder
- [x] 10.2 Keep the stream's throw and a rejected `wait()` apart and classify
      every signal with the SDK's live error and the reported one; verify both
      operations rejecting ends in one send with `cause=credential`
- [x] 10.3 Read the SDK's live run status at the handoff boundary and withhold a
      call from a run that is already terminal; verify a status that turns
      terminal before the stream drains hands no call
- [x] 10.4 Settle a tool callback that arrives after close instead of enqueuing
      it; verify the callback resolves as cancelled and the queue stays empty
- [x] 10.5 Make failure field extraction total, so an unprintable error still
      reports one warning and one finish chunk; verify a null-prototype
      rejection through the adapter
- [x] 10.6 Derive host-retry eligibility inside the reporter from the recovery
      fact, the output boundary, and the cause; verify contradictory inputs
      report `CURSOR_RUN_FAILED`
- [x] 10.7 Update the delta scenarios, the design, the standing doc, the
      changelog and this note, and re-run every gate

## 11. Fourth review findings (fixed after the fourth review pass)

- [x] 11.1 Keep structured name, code, and status as the credential evidence and
      read free text only for a marked status or authentication wording; verify
      a local-store message containing status digits still replays and succeeds,
      while an actual HTTP 403 stays terminal
- [x] 11.2 Release a run's status listener when that run settles, not only when
      the agent closes; verify two turns on one agent subscribe twice and
      unsubscribe twice
- [x] 11.3 Settle a terminal `error` or `cancelled` run without waiting for its
      stream to drain, keeping `finished` on the draining path; verify a stalled
      iterator still reports the failure and closes the agent
- [x] 11.4 Give the unreadable-attachment fallback a fixed line with no reader
      exception and no raw attachment identifier; verify it through the adapter
- [x] 11.5 Update the delta scenarios, the design, the standing doc, this note
      and the changelog, and re-run every gate

## 12. Fifth review findings (fixed after the fifth review pass)

- [x] 12.1 Start `wait()` with the stream instead of after it, so a stalled
      stream cannot hide the terminal result; verify a rejected or promptly
      resolving wait wins over an open terminal stream
- [x] 12.2 Give a terminal `error` a bounded moment for its result, settling
      immediately when the evidence already names a rejection, and report an
      unresolved failure with no replay and no retryable code; verify the
      unresolved case makes one send and returns `CURSOR_RUN_FAILED`
- [x] 12.3 Share one idempotent, best-effort listener release between settlement
      and close, consumed before the SDK callback runs; verify a throwing
      unsubscribe still closes the agent and empties the registry
- [x] 12.4 Derive host-retry eligibility from the replay the route actually ran,
      so an unresolved or unreplayed failure never offers a retry
- [x] 12.5 Update the proposal, the delta scenarios, the design, the standing
      doc and this note, and re-run every gate

## 13. Sixth review findings (fixed after the sixth review pass)

- [x] 13.1 Gate the tier fallback on resolved evidence, so an ambiguous failure
      tries no smaller tier; verify a terminal handle with parameter wording and
      an unsettled result makes one send
- [x] 13.2 Pass ambiguity to the reporter so a replay that never resolved offers
      the host no retry; verify an unresolved replay ends with
      `CURSOR_RUN_FAILED` after exactly two sends
- [x] 13.3 Take a terminal failure from an already-recorded result as well as
      from the handle, so a call is withheld when only the result is terminal;
      verify no tool chunk and a closed agent
- [x] 13.4 Give the stream its moment before a result-driven settlement, so
      output that arrived with the result is not lost; verify the after-output
      and reasoning-only cases stop replaying
- [x] 13.5 Let the evidence wait return as soon as the turn is cancelled; verify
      a cancellation finishes well inside the evidence deadline
- [x] 13.6 Update the delta scenario, the design, the standing doc and this
      note, and re-run every gate

## 14. Seventh review findings (fixed after the seventh review pass)

- [x] 14.1 Replace the result-only drain grace with one bounded drain window for
      every terminal failure, rechecking after every wake and publishing what
      arrives; verify a wake mid-drain does not settle without the stream's
      later rejection
- [x] 14.2 Apply the window to a handle-reported failure too, so the stream's
      later 401 is not lost; verify one send with `cause=credential`
- [x] 14.3 Withhold unhanded calls on a `finished` run while still draining its
      buffered text; verify no tool chunk, the late text delivered, and the call
      settled as ended
- [x] 14.4 Apply the same withholding to a `finished` result with no live
      status; verify no tool chunk and a stop
- [x] 14.5 Fix the fake that reported `finished` while accepting a tool result,
      so it settles only when the test releases it
- [x] 14.6 Update the delta scenarios, the design, the standing doc and this
      note, and re-run every gate

## 15. Eighth review findings (fixed after the eighth review pass)

- [x] 15.1 Treat a rejection the run already reported as decisive before the
      handoff, so no tool call goes out for a rejected attempt; verify one send,
      no tool delta, the call settled, the agent closed, one credential warning
- [x] 15.2 Union the handle's getter, the listener and the result when deciding
      terminal status, so a stale `running` reading cannot mask a notification;
      verify the call is withheld in that ordering
- [x] 15.3 Recheck status on every drain wake and honour a cancelled result over
      an earlier failure; verify one send and `ABORTED`
- [x] 15.4 Settle calls that arrive during the drain window on each wake, so a
      stream waiting on them can finish; verify the resolved failure replays
- [x] 15.5 Update the delta scenarios, the design, the standing doc and this
      note, and re-run every gate

## 16. Ninth review findings (fixed after the ninth review pass)

- [x] 16.1 Wake the pump as soon as the stream records its failure, so a pending
      `wait()` cannot hold the evidence behind; verify a stream 401 alone
      settles with one credential warning, agent closure and `CURSOR_RUN_FAILED`
- [x] 16.2 Use one terminal-status resolver at the handoff boundary, on every
      drain wake and before the settled outcome; verify getter-only and
      listener-only cancellations during drainage and a conflicting result after
      settlement
- [x] 16.3 Apply a status notification only when its run is still the session's
      current run; verify a retired run's late callback cannot cancel the next
      run's call
- [x] 16.4 Update the delta scenarios, the design, the standing doc and this
      note, and re-run every gate

## 17. Tenth review findings (fixed after the tenth review pass)

- [x] 17.1 Treat a recorded stream exception as a failed delivery on its own,
      whatever the handle still claims and whatever the exception's cause;
      verify a broken stream with a queued tool hands off nothing, settles the
      callback, closes the agent and reports one warning
- [x] 17.2 Take the bounded window when the result never arrives, so the turn
      reports instead of hanging; verify a broken stream without a tool settles
      with `CURSOR_RUN_FAILED` and no host retry
- [x] 17.3 Update the delta scenarios, the design, the standing doc and this
      note, and re-run every gate

## 18. Eleventh review findings (fixed after the eleventh review pass)

- [x] 18.1 Record that the stream's iterator threw separately from the value it
      threw, and normalize a nullish throw to a fixed local error; verify
      neither `undefined` nor `null` can hand off a tool call or produce a clean
      stop
- [x] 18.2 Re-run every gate
