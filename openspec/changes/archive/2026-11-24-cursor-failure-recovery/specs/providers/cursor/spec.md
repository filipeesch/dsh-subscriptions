# Spec Delta

## MODIFIED Requirements

### Requirement: Session continuity per conversation

Within one DSH session the route SHALL reuse the same Cursor agent and send only
content the agent has not seen, and SHALL rebuild the agent from the full
history when the transcript diverges from what the agent saw. An agent SHALL be
reused only while its last use is inside its idle budget: 20 minutes, or 60
minutes while a tool call is pending. The budget SHALL be measured in wall-clock
time, so a suspended machine cannot extend it, and it SHALL never expire an
agent that owns an active turn.

#### Scenario: Incremental send

- **WHEN** a later call in the same session extends the previous transcript
- **THEN** only the new content is sent to the existing agent

#### Scenario: Divergence rebuilds

- **WHEN** the transcript was compacted or edited, or the model or its
  parameters changed
- **THEN** the route starts a fresh agent seeded with the full current history

#### Scenario: Auxiliary calls isolated

- **WHEN** the host issues a title or compaction call that carries the session
  id
- **THEN** it uses its own short-lived agent and does not disturb the
  conversation's agent

#### Scenario: Bounded lifetime

- **WHEN** an agent sits idle past its idle budget, owns no active turn, or the
  plugin unloads
- **THEN** that agent, or every agent, is closed and removed from the
  conversation's registry

#### Scenario: Stale agent is not reused

- **WHEN** a turn starts and the conversation's agent is older than its budget
- **THEN** the turn opens a new agent instead of reusing that one

#### Scenario: Active run survives the budget

- **WHEN** a turn runs longer than its budget
- **THEN** its agent is not closed while that turn holds it

#### Scenario: Pending tool extends the budget

- **WHEN** an agent is waiting on a tool call, or a turn ended with one pending
- **THEN** its budget is 60 minutes instead of 20

#### Scenario: Suspension counts against the lifetime

- **WHEN** the machine is suspended past the budget and a turn then starts
- **THEN** the elapsed suspended time counts, and the stale agent is not reused

### Requirement: Failure semantics

A failed Cursor run SHALL surface an error code chosen by whether the attempt
produced output and whether recovery was spent. A failure after any output SHALL
report `CURSOR_RUN_FAILED`, a code the host's default policy does not retry. A
failure before any output that survives a replay SHALL report
`CURSOR_UNAVAILABLE`, a code the route's own retry policy makes retryable by the
host. A failure a retry cannot fix, such as a rejected credential, and a failure
that never reached an attempt, such as one during request setup, SHALL report
`CURSOR_RUN_FAILED`. When several signals describe one failed run, the most
terminal cause decides. A cancelled run SHALL report aborted and discard its
agent.

#### Scenario: Run failure

- **WHEN** a Cursor run ends in failure after emitting text, reasoning, or a
  tool call
- **THEN** the call finishes with `CURSOR_RUN_FAILED`, a code the host does not
  retry

#### Scenario: Failure before output

- **WHEN** a run fails before emitting text, reasoning, or a tool call, and the
  replay of that turn fails the same way
- **THEN** the call finishes with `CURSOR_UNAVAILABLE`

#### Scenario: Route-owned retry policy

- **WHEN** the host reads the retry policy of the `cursor` route
- **THEN** the policy retries only `CURSOR_UNAVAILABLE`, at most twice, so a
  pre-output failure is the only kind the host replays

#### Scenario: Rejected credential is terminal

- **WHEN** Cursor rejects the API key before any output, as its structured
  status, code, or class reports, or as an explicitly marked status or
  authentication wording in free text
- **THEN** the call finishes with `CURSOR_RUN_FAILED`, because a retry cannot
  fix a rejected key

#### Scenario: A number inside a message is not a rejection

- **WHEN** a local failure's message merely contains the digits of a status code
  inside an identifier
- **THEN** the failure keeps its local cause and the turn can still be replayed

#### Scenario: Setup failure is not retryable

- **WHEN** a request fails during setup, before any attempt could run
- **THEN** the call finishes with `CURSOR_RUN_FAILED`, because recovery was
  never spent

#### Scenario: A terminal failure settles without a stalled drain

- **WHEN** the run reports a terminal failure while its stream has not ended
- **THEN** the route reports that failure, closes the agent, and does not wait
  for the stream

#### Scenario: Terminal evidence is not lost to a stalled stream

- **WHEN** the run is terminal, its stream has not ended, and its result carries
  the credential rejection
- **THEN** the route settles with that evidence and reports the rejection
  instead of the weaker live detail

#### Scenario: A stream rejection settles without waiting for the result

- **WHEN** the stream reports a credential rejection while the run's result is
  still pending and no status has arrived
- **THEN** the route reports the rejection, closes the agent, and does not wait
  for the result

#### Scenario: A retired run cannot report

- **WHEN** a run that has already settled delivers a queued status notification
  while a newer run is in progress
- **THEN** the notification is ignored, so it cannot cancel or withhold the
  newer run's work

#### Scenario: A reported rejection blocks the handoff

- **WHEN** the run's result reports a credential rejection before the tool call
  is handed to the host, even though no terminal status has arrived
- **THEN** the route reports the rejection, settles the call, and never
  publishes it

#### Scenario: A cancelled result wins over an earlier failure status

- **WHEN** the run reports a failure and its result later reports cancellation
  inside the drain window
- **THEN** the turn ends aborted instead of being replayed

#### Scenario: Late evidence still decides

- **WHEN** the run is terminal, the result reports a weaker detail first, and
  the stream reports the credential rejection inside the drain window
- **THEN** the route reports the rejection, because a wake is not proof that the
  stream has nothing left to say

#### Scenario: An unresolved terminal failure is not replayed

- **WHEN** the run is terminal, its stream has not ended, and no result or
  failure ever arrives
- **THEN** the route reports the failure without replaying the turn, without
  trying another tier, and without offering the host a retry

#### Scenario: Terminal evidence wins

- **WHEN** one failed run carries a transport error and a rejection of the
  credential, whether the spread reports it or the wait raises it
- **THEN** the call finishes as a rejected credential instead of a retryable
  transport failure

#### Scenario: Cancellation

- **WHEN** the caller cancels the stream
- **THEN** the call finishes as aborted and the agent is discarded

## ADDED Requirements

### Requirement: Recovery before output

When an attempt fails before emitting any content, the route SHALL rebuild the
conversation's agent from the full current history and run the turn once more,
and SHALL report the failure only if that replay also fails. The route SHALL NOT
replay a turn that already emitted content, and SHALL NOT exceed three provider
attempts for one turn, counting a smaller-tier fallback.

#### Scenario: Failure before output recovers

- **WHEN** the first attempt of a turn fails before emitting text, reasoning, or
  a tool call
- **THEN** the route opens a new agent from the full history and runs the turn
  again, and the caller sees one reply

#### Scenario: Failed replay is reported

- **WHEN** the replayed attempt also fails before emitting content
- **THEN** the call finishes with `CURSOR_UNAVAILABLE` and the agent is
  discarded

#### Scenario: Content already sent is not replayed

- **WHEN** an attempt fails after emitting text, reasoning, or a tool call
- **THEN** the route reports the failure without running the turn again

#### Scenario: Rejected credential is not retried

- **WHEN** Cursor rejects the API key on an attempt that emitted no content
- **THEN** the route reports the failure immediately instead of replaying

#### Scenario: Attempts stay bounded

- **WHEN** a turn needed a smaller context tier and then a replay
- **THEN** the turn used at most three provider attempts

#### Scenario: A terminal run hands no tool call

- **WHEN** a run reaches a terminal status before its tool call was handed to
  the host, including a `finished` one
- **THEN** the route withholds the call, settles it with an error result, and
  still delivers any output the stream had buffered

#### Scenario: A broken stream is a failed delivery

- **WHEN** the run stream ends in an error, whether the run later reports that
  it finished or still reports that it is running
- **THEN** the route reports the failure instead of a clean stop or a handoff,
  and keeps it terminal when any output was emitted

#### Scenario: A broken stream does not wait forever

- **WHEN** the stream ends in an error, the run still reports that it is
  running, and its result never arrives
- **THEN** the route reports the failure, closes the agent, and neither replays
  the turn nor offers the host a retry

### Requirement: Failure diagnostics

For every failed Cursor turn the route SHALL record one warning line on the
plugin's warning sink that names the failure phase, a cause class, and a
diagnostic detail drawn from the route's own reviewed vocabulary — a fixed
literal, optionally followed by allowlisted structured fields such as an SDK
error class name, a reviewed error code, or an HTTP status. The line SHALL NOT
contain provider-supplied text, the resolved API key, or any text the request
carried, and the caller-facing sentence SHALL stay free of provider text. The
same rule applies to every other warning the route writes to that sink.

#### Scenario: Warning states the phase, cause, and reviewed detail

- **WHEN** a turn fails
- **THEN** one warning line states whether the failure happened while setting up
  the agent or during the run, which cause class applies, and which reviewed
  detail applies

#### Scenario: Structured fields are allowlisted

- **WHEN** the failed run reports an SDK error class, an error code, or a status
  code
- **THEN** the warning includes only the values the route reviews, and omits the
  rest

#### Scenario: Unrecognized failure uses the fixed placeholder

- **WHEN** no reviewed pattern describes the failure
- **THEN** the warning reports the fixed placeholder instead of the provider's
  message

#### Scenario: Request text never reaches the warning

- **WHEN** the failure's provider message quotes the prompt, a message, or a
  tool result
- **THEN** the warning carries none of that text

#### Scenario: Caller-facing sentence carries no provider text

- **WHEN** a turn fails
- **THEN** the caller receives the route's own fixed sentence, not the
  provider's message

#### Scenario: Other warnings follow the same rule

- **WHEN** the route warns about something other than a failed turn, such as an
  attachment it could not read
- **THEN** the warning is a fixed local line with no provider text and no raw
  identifier
