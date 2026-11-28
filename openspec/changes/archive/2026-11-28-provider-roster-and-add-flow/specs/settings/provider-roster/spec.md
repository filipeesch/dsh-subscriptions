# Spec Delta

## Purpose

Shows the providers this installation is configured to use as one collapsed row
each, states each row's connection in text, and expands the row to the controls
that provider already had.

## ADDED Requirements

### Requirement: Only configured providers are listed

The roster SHALL show exactly one row per provider this installation is
configured to use: an OAuth-session provider with at least one connected
account, the Cursor route while its key resolves, the Ollama route while a
connection is saved, or a key-managed source while its configured key is
present. A provider that is not configured SHALL have no row, and SHALL be
reachable only from the add-provider selector. A provider whose configuration is
not yet confirmed SHALL have no row until it is.

#### Scenario: Configured providers listed

- **WHEN** the roster reads the configured set and two providers are configured
- **THEN** the roster shows one row for each of the two and no row for the other
  providers

#### Scenario: Nothing configured

- **WHEN** the configured set answers that no provider is configured
- **THEN** the roster shows the empty state and no rows

#### Scenario: A provider stops being configured

- **WHEN** a read reports that a provider with a row is no longer configured
- **THEN** that row leaves the roster and the other rows stay as they were

#### Scenario: Configuration still in progress

- **WHEN** a provider's configuration was started and the route has not
  confirmed it
- **THEN** the roster has no row for that provider, because the form that owns
  the attempt carries its state

### Requirement: A collapsed row states the provider and its connection in text

Each row SHALL render collapsed with the provider's name and one textual
connection state. A collapsed row SHALL NOT show an account name, an account
expiry, a quota value, a credential value, or an action. The state SHALL name
what the route holds: the number of connected accounts for an OAuth-session
provider, the saved key for a key route, the Cloud key or the local address for
Ollama, and the managed key for a key-managed source. A route whose saved
credential cannot be used SHALL state that the provider needs attention instead
of presenting it as connected.

#### Scenario: One connected account

- **WHEN** an OAuth-session provider has one connected account
- **THEN** its collapsed row states that one account is connected

#### Scenario: Several connected accounts

- **WHEN** an OAuth-session provider has three connected accounts
- **THEN** its collapsed row states that three accounts are connected

#### Scenario: Saved key

- **WHEN** a key route's credential resolves
- **THEN** its collapsed row states that its API key is configured

#### Scenario: Ollama connection shapes

- **WHEN** the Ollama route holds a saved local address and no Cloud key
- **THEN** its collapsed row states that a local address is configured

#### Scenario: A key that cannot be used

- **WHEN** a key route holds a saved key its read rejects, or Ollama holds a
  Cloud key that its saved address makes idle
- **THEN** the collapsed row states that the provider needs attention and does
  not state that it is connected

#### Scenario: No quota value while collapsed

- **WHEN** a provider reports usage and its row is collapsed
- **THEN** no percentage, amount, or window bar is visible in the row

### Requirement: Expanding a row reveals the controls the card carried

Expanding a row SHALL reveal, in place and without navigating away, every
control that provider's Settings card carried before this change: for an
OAuth-session provider its accounts with the default selection and sign-out, its
usage windows with refresh, adding an account, and the account manager; for a
key route its credential field with the route's own validation; for Cursor and
Ollama their model and connection controls; for a key-managed source its usage
windows with refresh. Expanding or collapsing a row SHALL write no setting. A
row's first expansion SHALL start only the reads that provider's card already
performed on mount, and no read SHALL start while the row stays collapsed.

#### Scenario: OAuth row expanded

- **WHEN** the reader expands an OAuth-session provider's row
- **THEN** the row shows its accounts, its usage windows with refresh, the add
  account action, and the account manager

#### Scenario: Key route row expanded

- **WHEN** the reader expands the Cursor row
- **THEN** the row shows the credential field, the model controls, and the
  connection state the card showed

#### Scenario: Key-managed row expanded

- **WHEN** the reader expands a key-managed source's row
- **THEN** the row shows its usage windows with refresh and no credential field,
  because that key belongs to Settings → Models

#### Scenario: Collapsing writes nothing

- **WHEN** the reader collapses an expanded row
- **THEN** the roster writes no setting and the row states its connection as
  before

### Requirement: Rows expand independently

The roster SHALL allow any number of rows to be expanded at once. Expanding or
collapsing one row SHALL leave every other row in the state it was in, and an
expanded row SHALL NOT be stored for a later visit.

#### Scenario: Two rows expanded

- **WHEN** the reader expands two rows
- **THEN** both stay expanded and neither collapses the other

#### Scenario: A later visit starts collapsed

- **WHEN** the page is opened again after a row was left expanded
- **THEN** every row is collapsed

### Requirement: The quota display band sits above the roster

The page's display preferences SHALL sit in one collapsible band above the
roster, visually separated from the provider list and outside its border,
collapsed by default. The band SHALL keep the three existing controls and their
browser persistence, and opening or closing the band SHALL change no stored
value.

#### Scenario: Collapsed by default

- **WHEN** the page opens
- **THEN** the preferences band is collapsed and the roster is visible below it

#### Scenario: Opening the band

- **WHEN** the reader opens the preferences band
- **THEN** the three existing preferences are available and keep their current
  values

#### Scenario: A preference survives a reload

- **WHEN** the reader changes a preference and opens the page again
- **THEN** the changed preference is still in effect, because the band writes
  the same browser preference the page wrote before

### Requirement: Checking, empty, and failed are distinct states

While the configured set is being read the roster SHALL state that it is
checking and SHALL NOT offer adding a provider. A failed read SHALL NOT read as
an empty roster: it SHALL keep the rows of the last successful read when there
are any, state that the providers could not be loaded, and offer Retry. The
empty state SHALL appear only after a successful read that reports no configured
provider.

#### Scenario: First load

- **WHEN** the page opens and the first read has not answered
- **THEN** the roster states that it is checking which providers are configured
  and the add action is unavailable

#### Scenario: First read fails

- **WHEN** the first read fails
- **THEN** the roster states that the providers could not be loaded, offers
  Retry, and does not show the empty state

#### Scenario: A later read fails

- **WHEN** a read fails after a successful one reported rows
- **THEN** those rows stay visible and the roster states the failure with Retry

#### Scenario: Retry recovers

- **WHEN** the reader retries and the read answers
- **THEN** the roster shows the reported rows and the add action is available

### Requirement: A confirmed configuration returns one collapsed row

After a confirmed configuration the roster SHALL show the new provider exactly
once, as one collapsed row, keep every previous row, state the outcome in one
line above the list naming what was saved, and SHALL NOT expand the new row. A
further account added to an already-configured provider SHALL change that row's
stated account count and SHALL NOT add a row.

#### Scenario: A provider is added

- **WHEN** the add form confirms a provider that had no row
- **THEN** the roster shows one collapsed row for it, states what was saved, and
  keeps the previous rows

#### Scenario: An account is added to an existing provider

- **WHEN** the reader adds a second account from an expanded row
- **THEN** the row states two connected accounts and the roster still has one
  row for that provider

### Requirement: One fixed order

The roster SHALL order its rows by provider route rather than by when each was
configured: OAuth-session providers first in their current page order (Codex,
Claude, Grok, GitHub Copilot, Google Antigravity), then Cursor, then Ollama,
then the key-managed sources in their current page order (OpenCode Go, Kimi
Code, MiniMax, MiniMax CN). Adding a provider SHALL NOT reorder the rows already
shown.

#### Scenario: A later visit keeps the order

- **WHEN** the page is opened again with the same configured providers
- **THEN** the rows appear in the same order

#### Scenario: An addition lands in its group

- **WHEN** the reader adds a provider whose group sits above an existing row
- **THEN** the new row appears in its group's place instead of at the end

### Requirement: Each row is an accessible disclosure

A row's header SHALL be a button that states whether the row is expanded and
names the region it controls. Its accessible name SHALL carry the provider name
and the stated connection. Enter and Space SHALL toggle it, focus SHALL be
visible, and the header together with every control the roster adds SHALL offer
a 44 px target.

#### Scenario: Accessible name

- **WHEN** a screen reader reaches a row header
- **THEN** it states the provider, the connection, and whether the row is
  expanded

#### Scenario: Keyboard

- **WHEN** the row header has focus and the reader presses Enter or Space
- **THEN** the row toggles and its expanded state is announced

#### Scenario: Touch target

- **WHEN** a row header is rendered at any of the supported widths
- **THEN** its target is at least 44 px tall

### Requirement: The roster holds at every supported width and theme

At 390, 768, and 1280 px the heading and the add action SHALL wrap instead of
overflowing, an expanded row's content SHALL NOT scroll horizontally, and every
color SHALL resolve through an existing design token so the roster reads in both
the light and the dark theme.

#### Scenario: Narrow width

- **WHEN** the roster renders at 390 px
- **THEN** the heading and the add action wrap inside the panel and no row
  overflows it

#### Scenario: Expanded content at a narrow width

- **WHEN** a row with long values is expanded at 390 px
- **THEN** its content wraps instead of scrolling horizontally

#### Scenario: Dark theme

- **WHEN** the page renders under the dark theme
- **THEN** the roster's surfaces, borders, and text come from the theme tokens
  and every row keeps its contrast
