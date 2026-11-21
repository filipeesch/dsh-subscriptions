# Spec Delta

## Purpose

Registers Cursor as a key-based model route so its models and subscription quota
are usable from DeepSeek Harness without an OAuth login.

## ADDED Requirements

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
SHALL disambiguate display names shared by more than one model.

#### Scenario: Live catalog

- **WHEN** the catalog read succeeds
- **THEN** the picker lists exactly the reported models with their advertised
  reasoning efforts

#### Scenario: Shared display name

- **WHEN** two reported models carry the same display name
- **THEN** each label appends its model id so the entries stay distinguishable

#### Scenario: Catalog unavailable

- **WHEN** the catalog cannot be read
- **THEN** the route offers a built-in list of known model ids and retries the
  live catalog on a later read

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
history when the transcript diverges from what the agent saw.

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

- **WHEN** an agent sits idle past its idle budget, or the plugin unloads
- **THEN** that agent, or every agent, is closed

### Requirement: Context tier and reasoning mapping

The route SHALL advertise the model's largest offered context tier by default,
with the choice configurable, and SHALL map DSH's selected reasoning effort onto
the Cursor parameters the model advertises.

#### Scenario: Maximum context advertised

- **WHEN** a model reports several context tiers
- **THEN** the resolved model advertises the largest tier unless configuration
  selects another

#### Scenario: Effort mapping

- **WHEN** a model advertises effort values and DSH selects a level
- **THEN** the request carries the closest advertised value, or reasoning is
  turned off when the model allows it

#### Scenario: Tier rejection

- **WHEN** Cursor rejects the chosen context tier and the run emitted nothing
- **THEN** the route retries once with the next smaller offered tier and reuses
  that tier for subsequent runs of the same model in the process

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

A failed Cursor run SHALL surface an error code outside the host's default retry
set, and a cancelled run SHALL report aborted.

#### Scenario: Run failure

- **WHEN** a Cursor run ends in failure
- **THEN** the call finishes with an error whose code the host does not retry

#### Scenario: Cancellation

- **WHEN** the caller cancels the stream
- **THEN** the call finishes as aborted and the agent is discarded
