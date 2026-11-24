# providers/cursor Specification

## Purpose

Registers Cursor as a key-based model route so its models and subscription quota
are usable from DeepSeek Harness without an OAuth login.

## Requirements

### Requirement: Route without OAuth

The plugin SHALL expose a `cursor` model route authenticated by a credential
reference rather than an OAuth session, and that reference SHALL default to
`CURSOR_API_KEY`.

#### Scenario: Key configured

- **WHEN** the configured credential reference resolves to a non-empty key
- **THEN** the route lists Cursor models in the model picker and accepts
  requests

#### Scenario: Key missing

- **WHEN** the configured credential reference resolves to nothing
- **THEN** the route offers no models and a direct request fails with a
  missing-credential error that names the reference

### Requirement: Live catalog with a known fallback

The route SHALL list the models Cursor's catalog reports for the account,
including display names and the reasoning efforts each model advertises, and
SHALL disambiguate display names shared by more than one model. It SHALL persist
the last reported catalog, SHALL seed itself from that catalog on start, and
SHALL advertise models only while the credential reference resolves to a
non-empty key.

#### Scenario: Live catalog

- **WHEN** the catalog read succeeds
- **THEN** the picker lists exactly the reported models with their advertised
  reasoning efforts and the route persists the catalog for later runs

#### Scenario: Shared display name

- **WHEN** two reported models carry the same display name
- **THEN** each label appends its model id so the entries stay distinguishable

#### Scenario: Catalog unavailable

- **WHEN** the catalog cannot be read and no catalog was persisted
- **THEN** the route offers a built-in list of known model ids and retries the
  live catalog on a later read

#### Scenario: Restart seeded from the persisted catalog

- **WHEN** the plugin starts with a persisted catalog and a key that resolves
- **THEN** the route lists the persisted models before a live read completes and
  refreshes them in the background

#### Scenario: Discovery failure after a persisted read

- **WHEN** the catalog cannot be read and a catalog was persisted
- **THEN** the route keeps serving the persisted models instead of the built-in
  list

#### Scenario: Key missing

- **WHEN** the configured credential reference resolves to nothing
- **THEN** the route lists no models even when a catalog was persisted

### Requirement: Request execution and tool handoff

Each DSH model call SHALL stream text, reasoning, tool calls, and a terminal
outcome in DSH's chunk contract. Tool calls SHALL be executed by DSH, and their
results SHALL be returned to the same Cursor run that requested them.

#### Scenario: Tool round trip

- **WHEN** Cursor calls a DSH tool during a run
- **THEN** the plugin reports the call, ends the call with a tool-use outcome,
  and the next request delivers the tool result to the same run without starting
  a new conversation

#### Scenario: Stop sequences rejected

- **WHEN** a request supplies stop sequences
- **THEN** the call fails with an unsupported-option error before any provider
  work

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

### Requirement: Context tier request

The route SHALL request the largest context tier a model offers, SHALL advertise
the capacity of the tier it actually requests, and SHALL reuse the tier Cursor
accepted after a rejection for later runs of that model. The route SHALL NOT
store, read, or accept a tier preference for a model or for the route.

#### Scenario: Largest tier requested

- **WHEN** a model reports several context tiers
- **THEN** the request carries the largest offered tier and the resolved model
  advertises that tier's capacity

#### Scenario: Tier rejection

- **WHEN** Cursor rejects the chosen context tier and the run emitted nothing
- **THEN** the route retries once with the next smaller offered tier, reuses
  that tier for later runs of the same model, and advertises the accepted tier's
  capacity

#### Scenario: Accepted tier remembered across restarts

- **WHEN** a tier was accepted after a rejection and the plugin restarts with
  the catalog still offering that tier
- **THEN** the route requests the accepted tier and advertises its capacity
  instead of the rejected one

#### Scenario: Accepted tier withdrawn

- **WHEN** the catalog no longer offers the remembered tier
- **THEN** the route forgets it, requests the largest offered tier, and
  advertises that tier's capacity

#### Scenario: No tier preference

- **WHEN** configuration or stored settings name a context tier
- **THEN** the route ignores that value and requests the largest offered tier

### Requirement: Reasoning effort mapping

The route SHALL map DSH's selected reasoning effort onto the Cursor parameters
the model advertises, so a model's own effort values decide what the request
carries and no table of supported models is needed.

#### Scenario: Effort mapping

- **WHEN** a model advertises effort values and DSH selects a level
- **THEN** the request carries the closest advertised value, or reasoning is
  turned off when the model allows it

### Requirement: Usage accounting per request

A finished run SHALL report disjoint input, output, cache-read, and cache-write
token buckets, omitting any total that would disagree with them.

#### Scenario: Single-call run

- **WHEN** a run contains one model call
- **THEN** its reported usage is forwarded as the run's buckets

#### Scenario: Multi-call run

- **WHEN** a run contains tool handoffs and therefore several model calls
- **THEN** the input buckets are scaled to the estimated context instead of
  reusing Cursor's cumulative input count, and output stays the run's real
  output

### Requirement: Images follow the host store

Images in user messages and tool results SHALL be forwarded to Cursor when the
host can read their bytes, and an image that is offloaded or unreadable SHALL be
represented by a text note instead.

#### Scenario: Readable image forwarded

- **WHEN** a message carries a readable image attachment
- **THEN** the Cursor request carries the image bytes

#### Scenario: Offloaded image noted

- **WHEN** an image was offloaded or cannot be read
- **THEN** the request carries a text note in its place

### Requirement: Subscription quota source

The Cursor usage reader SHALL exchange the API key for an access token and then
read the current period usage requesting pooled usage, and it SHALL map the
result to usage windows and a cycle.

#### Scenario: Enterprise spend against a ceiling

- **WHEN** the response carries an overall limit and used amount
- **THEN** the reader reports one money window with used, limit, remaining, and
  the cycle start and end

#### Scenario: Personal plan percentages

- **WHEN** the response carries percent-used values instead of a limit
- **THEN** the reader reports one window per reported percent, with the cycle
  when disclosed

#### Scenario: No disclosed limit

- **WHEN** the response carries spend but no ceiling
- **THEN** the reader uses a configured monthly ceiling when one is set, and
  otherwise reports the spend without a proportion

#### Scenario: Failed refresh

- **WHEN** a later read fails after a successful one
- **THEN** the last reading is served marked stale and its observation time is
  not advanced

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

### Requirement: Published context capacities

When a listed model's catalog entry offers no context tier and no manual window
is set, the route SHALL advertise the capacity the public models.dev catalog
publishes for that model. The route SHALL read a document whose entries are
provider maps of model maps, SHALL skip an entry that declares no usable
capacity instead of rejecting the document, and SHALL reject a document that is
not of that shape. It SHALL project only the ids Cursor currently lists, SHALL
prefer the capacity the model's own vendor publishes when candidates disagree,
and SHALL keep the last successful projection when a refresh fails. A refresh
SHALL run outside the request path, and no request SHALL wait for the network.

#### Scenario: Advertised from the public catalog

- **WHEN** a listed model offers no context tier, no manual window is set, and
  the projection describes the model
- **THEN** the resolved model advertises the published capacity

#### Scenario: Entries without a capacity are skipped

- **WHEN** the public catalog describes models that declare no usable capacity
  beside models that declare one
- **THEN** the refresh succeeds and the projection keeps the capacities the
  readable entries declare

#### Scenario: Projection follows the listed ids

- **WHEN** the public catalog describes models Cursor does not list
- **THEN** the projection keeps only capacities for the ids Cursor lists

#### Scenario: Disagreement between entries

- **WHEN** entries from several providers describe one model with different
  capacities
- **THEN** the entries published by the model's own vendor win, and the value
  most of those entries declare wins among them

#### Scenario: Refresh failure

- **WHEN** a refresh fails after a successful projection
- **THEN** the route keeps advertising the previous capacities and the failure
  does not fail a request

#### Scenario: Cold start

- **WHEN** the plugin starts before any projection exists
- **THEN** model listing and resolution proceed without waiting for the fetch

#### Scenario: Source disabled

- **WHEN** the published-capacity source is disabled
- **THEN** no fetch runs and a model with no tier and no manual window
  advertises the default capacity

#### Scenario: Source state on the card

- **WHEN** the Cursor card renders
- **THEN** it states whether published capacities are in effect and when the
  source last refreshed

#### Scenario: Source controls in the manager

- **WHEN** the model manager is open
- **THEN** it offers a control to refresh the source now and a control that
  turns the source off or on

#### Scenario: Manual refresh

- **WHEN** the manager requests a refresh
- **THEN** the route fetches the public catalog out of band and the manager then
  reflects the new refresh time, or the retained previous projection when the
  fetch failed

### Requirement: Manual context window

The route SHALL accept a manual window per model, stored with the route's
settings and supplied as a baseline by the plugin configuration, and SHALL use
it whenever the model offers no context tier. A manual window SHALL outrank the
capacity the public catalog publishes. A stored value SHALL win over the
configuration for the same model.

#### Scenario: Manual value used

- **WHEN** a model offers no tier and a manual window is set
- **THEN** the resolved model advertises the manual value

#### Scenario: More authoritative sources win

- **WHEN** a model offers a context tier and a manual window is also set
- **THEN** the resolved model advertises the tier's capacity instead of the
  manual value

#### Scenario: Published value overridden

- **WHEN** a model offers no tier, the public catalog describes it, and a manual
  window is also set
- **THEN** the resolved model advertises the manual value instead of the
  published capacity

#### Scenario: Settings over configuration

- **WHEN** the stored settings and the configuration both set a manual window
  for one model
- **THEN** the stored value is advertised

#### Scenario: Invalid stored value

- **WHEN** a stored or configured manual window is not a positive integer
- **THEN** the route ignores it and resolves the model through the remaining
  sources

### Requirement: Per-model settings and enablement

The route SHALL persist per-model settings — enablement and manual window —
SHALL accept a configuration baseline for each, and SHALL apply a change without
a plugin restart. A stored setting SHALL win over the configuration for the same
field.

#### Scenario: Disabled model leaves the picker

- **WHEN** a model is disabled in the settings
- **THEN** the route stops listing it in the picker, and a saved conversation
  that selected it still resolves the model

#### Scenario: Configuration baseline

- **WHEN** the configuration sets a model's enablement or window and the
  settings carry no value for that field
- **THEN** the route applies the configured value

#### Scenario: Settings override the baseline

- **WHEN** the settings and the configuration set different values for one field
- **THEN** the route applies the stored value

#### Scenario: Settings survive a restart

- **WHEN** the plugin restarts after a settings save
- **THEN** the route applies the saved enablement and windows

#### Scenario: Model manager shows the resolution

- **WHEN** the Cursor card's model manager opens
- **THEN** each listed model shows its resolved window and where that window
  came from

#### Scenario: Legacy tier field ignored

- **WHEN** the stored settings still carry a tier preference for a model
- **THEN** the route reads the rest of the document, ignores that field, and
  requests the largest offered tier

#### Scenario: Corrupt settings

- **WHEN** the stored settings document is unreadable or invalid
- **THEN** the route falls back to the configuration baseline and the defaults
  without failing the route

### Requirement: Model manager

The Cursor card SHALL offer a model manager listing every model the route holds,
one compact row per model that names the model and states the window the route
will advertise. A row SHALL name the source of that window without opening it,
including in the value's accessible name. The manager SHALL filter the list by
name or id, SHALL state how many listed models are enabled, and SHALL offer to
reload the catalog.

A row whose window does not come from the provider's tier SHALL offer a manual
override: the resolved value becomes editable, saving marks the window as manual
while still naming the source it replaced, and returning the model to the
automatic value removes the stored override. A row whose window comes from the
tier SHALL NOT offer the override, because the tier decides what the provider
applies.

The manager SHALL apply each change when the reader makes it instead of on an
explicit save: an enablement change applies immediately, a typed window applies
after a pause in typing, and a change that cannot be stored restores the value
the route holds and states the failure in the affected row.

#### Scenario: One row per model

- **WHEN** the manager opens
- **THEN** each listed model is one row naming the model, its id, and the window
  the route advertises, with that window's source named on the value

#### Scenario: Filtered list

- **WHEN** the reader types a filter
- **THEN** only rows whose name or id matches remain, and the manager states
  when no row matches

#### Scenario: Manual override

- **WHEN** a row's window comes from the published capacity and the reader edits
  it
- **THEN** saving stores a manual window, and the row shows that value while
  still naming the published capacity it replaced

#### Scenario: Return to automatic

- **WHEN** a row carries a manual window and the reader returns it to the
  automatic value
- **THEN** the stored override is removed and the row shows the resolved window
  again

#### Scenario: No override on a tiered model

- **WHEN** a model's window comes from the provider's tier
- **THEN** its row offers no manual field

#### Scenario: Autosave

- **WHEN** the reader changes a model's enablement
- **THEN** the route applies it without a save action, and the manager offers no
  save or cancel action

#### Scenario: Failed write

- **WHEN** a change cannot be stored
- **THEN** the row returns to the value the route holds and states the failure

#### Scenario: Source section

- **WHEN** the manager is open
- **THEN** it states whether the source is on, when it last refreshed, and how
  many listed models still fall back to the default window

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
