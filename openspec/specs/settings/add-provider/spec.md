# settings/add-provider Specification

## Purpose

Lets a reader add one provider to the roster from a single form: choose the
provider, configure it by that provider's own method, and confirm once.

## Requirements

### Requirement: One form with one provider selector

The add action SHALL open a form in place of the roster, holding a single
Provider selector that lists all eleven providers in one order — Claude, Codex
(ChatGPT), Cursor, GitHub Copilot, Google Antigravity, Grok (X Premium), Kimi
Code, MiniMax, MiniMax CN, Ollama, OpenCode Go — and starts with no provider
chosen. The selector SHALL mark every provider that is already configured, and a
marked provider SHALL NOT be choosable, because a further account belongs to
that provider's roster row. The form SHALL return to the roster when it closes.

#### Scenario: Every provider is listed

- **WHEN** the reader opens the form
- **THEN** the selector lists all eleven providers in the stated order

#### Scenario: Nothing chosen yet

- **WHEN** the form opens
- **THEN** no provider is chosen and no provider's fields are shown

#### Scenario: Configured providers are marked and held back

- **WHEN** a provider already has a roster row
- **THEN** the selector marks it as configured and it cannot be chosen

#### Scenario: The form replaces the roster

- **WHEN** the form is open
- **THEN** the roster is not shown, and closing the form shows it again

### Requirement: Choosing reveals fields and writes nothing

Choosing a provider SHALL reveal that provider's own fields below the selector
in the same form, without navigating away. Choosing a provider SHALL NOT write a
setting, save a credential, or start an authorization. Choosing another provider
SHALL replace the fields with the new provider's fields and discard the values
typed for the previous one.

#### Scenario: Choosing reveals that provider's fields

- **WHEN** the reader chooses Cursor
- **THEN** the fields shown below the selector are Cursor's, in the same form

#### Scenario: Switching providers

- **WHEN** the reader has typed a Cursor key and then chooses Ollama
- **THEN** the form shows Ollama's fields and the typed Cursor key is gone

#### Scenario: Choosing writes nothing

- **WHEN** the reader chooses a provider and then another
- **THEN** no setting was written, no credential was saved, and no authorization
  was started

### Requirement: Each route keeps its own method

The form SHALL offer a route only the method that route has: browser
authorization with the manual callback fallback for the OAuth-session providers,
a GitHub device code for Copilot, a masked key validated by the route's own read
for Cursor, a check of the key that Settings → Models manages for Kimi Code,
MiniMax, MiniMax CN, and OpenCode Go, and for Ollama the choice between a Cloud
key, validated by the route's own read, and a local address. The footer SHALL
carry Cancel and one primary action named for the chosen route — Save, Continue
in browser, Get device code, Check again, or Save address — and that action
SHALL stay unavailable while a field the route requires is empty.

#### Scenario: OAuth-session provider

- **WHEN** the reader chooses Claude, Codex, Grok, or Google Antigravity
- **THEN** the form offers browser authorization and a primary action that
  starts it

#### Scenario: Device code

- **WHEN** the reader chooses GitHub Copilot
- **THEN** the form offers the device-code method and a primary action that
  requests the code

#### Scenario: Masked key

- **WHEN** the reader chooses Cursor
- **THEN** the form offers one masked key field and a Save action that is
  unavailable while the field is empty

#### Scenario: Key managed elsewhere

- **WHEN** the reader chooses Kimi Code, MiniMax, MiniMax CN, or OpenCode Go
- **THEN** the form names the reference that Settings → Models must hold and
  offers a check action instead of a key field

#### Scenario: A managed key is missing

- **WHEN** the reader checks a managed-key route and Settings → Models holds no
  key
- **THEN** the form states that the key was not found, names where the key is
  set, and stays open on that provider

#### Scenario: Ollama connection shapes

- **WHEN** the reader chooses Ollama
- **THEN** the form offers a Cloud key and a local address as alternatives and
  shows the fields of the chosen one

### Requirement: A waiting authorization is visible and cancellable

While a browser authorization waits, the form SHALL state which provider it is
waiting for, offer the manual callback fallback, and offer a cancel action. A
device-code flow SHALL show the code with a copy action and a way to open the
authorization page. An attempt that fails SHALL state the failure in the form
and keep the form open. The form SHALL return to the roster only once the route
reports the configuration confirmed.

#### Scenario: Waiting for the browser

- **WHEN** the authorization started and the route has not confirmed it
- **THEN** the form states that it is waiting for that provider and offers the
  manual callback fallback and a cancel action

#### Scenario: Manual completion

- **WHEN** the reader submits a callback value the route accepts
- **THEN** the route confirms the configuration and the form returns to the
  roster

#### Scenario: Device code shown

- **WHEN** the device code arrives
- **THEN** the form shows the code with a copy action and a way to open the
  authorization page

#### Scenario: The attempt fails

- **WHEN** the run reports a failure before confirming
- **THEN** the form states the failure and stays open on the chosen provider

#### Scenario: Canceling the attempt

- **WHEN** the reader cancels an authorization this form started
- **THEN** that attempt is canceled, no row is added, and the form stays open on
  the chosen provider

### Requirement: Cancel returns to the roster and writes nothing

Cancel SHALL return to the roster, add no row, and cancel an authorization this
form started. Cancel SHALL NOT itself write a setting or credential.

#### Scenario: Cancel before choosing

- **WHEN** the reader cancels with no provider chosen
- **THEN** the roster is unchanged

#### Scenario: Cancel after typing

- **WHEN** the reader types a key and cancels
- **THEN** nothing was saved and the roster is unchanged

#### Scenario: Cancel while waiting

- **WHEN** the reader cancels while a browser authorization waits
- **THEN** the attempt is canceled and no row is added

### Requirement: A confirmed configuration adds exactly one row

Once the route reports the configuration confirmed, the form SHALL close, the
roster SHALL show one new collapsed row and one line naming what was saved, and
no previously configured provider SHALL be removed or altered. A repeated
confirmation SHALL NOT add a second row for the same provider.

#### Scenario: Confirmed

- **WHEN** the route confirms the new configuration
- **THEN** the roster shows the new collapsed row and the line naming what was
  saved, with the previous rows intact

#### Scenario: Confirmed twice

- **WHEN** the same provider's confirmation arrives again
- **THEN** the roster still holds one row for it

### Requirement: A saved key that cannot be used states that

When a key route saves a key that its own read rejects, the form SHALL state
that the key was saved but cannot be used, SHALL leave the key saved, and SHALL
offer returning to the field to check or replace it. The roster row that follows
SHALL state that the provider needs attention rather than presenting it as
connected.

#### Scenario: Rejected key

- **WHEN** the reader saves a Cursor key that the route's read rejects
- **THEN** the form states that the key was saved but is unusable and offers the
  field again

#### Scenario: The key stays saved

- **WHEN** the reader closes that outcome without replacing the key
- **THEN** the key remains saved and the roster states that Cursor needs
  attention

### Requirement: A local address is a save, not a connectivity claim

Saving the Ollama local address SHALL state that the address was saved and SHALL
NOT state or imply that the server answered. Before saving, the form SHALL state
that saving the address does not check whether the server is reachable. A stored
Cloud key SHALL NOT be sent to that address, and the row SHALL state that the
Cloud key is idle there.

#### Scenario: The address is saved

- **WHEN** the reader saves a local address
- **THEN** the roster states that the address was saved and claims nothing about
  reachability

#### Scenario: The caveat comes before the save

- **WHEN** the local connection is chosen
- **THEN** the form states that saving does not check reachability

#### Scenario: A stored Cloud key at the saved address

- **WHEN** the Ollama route holds a Cloud key and the reader saves another
  address
- **THEN** the row states that the key is idle at that address and no request
  carries it

### Requirement: The form is labeled, focused, and contained

Every field SHALL have an accessible name. Choosing a provider SHALL move focus
to the first field of that provider, and closing the form — on a confirmation or
a cancel — SHALL return focus to the roster heading. Failures and outcomes SHALL
be announced without moving focus away from the control in use. Every control
this form adds SHALL offer a 44 px target, and a pending primary action SHALL
stay focusable while it reads as unavailable. The form SHALL stack its fields at
390 px, and its footer actions SHALL share one right-aligned row while their
labels fit, wrapping only when they would overflow.

#### Scenario: Accessible names

- **WHEN** a screen reader walks the form
- **THEN** every field states what it holds and which provider it configures

#### Scenario: Focus after choosing

- **WHEN** the reader chooses a provider that has a field
- **THEN** focus moves to that provider's first field, without the reader
  selecting it

#### Scenario: Focus after closing

- **WHEN** the form closes, on a confirmation or a cancel
- **THEN** focus sits on the roster heading, and the page body never takes it

#### Scenario: A pending primary action

- **WHEN** the form's primary action is submitted and its request is still
  running
- **THEN** it reads as unavailable, keeps keyboard focus, and runs nothing
  further until it answers

#### Scenario: Announced failure

- **WHEN** the route rejects the configuration
- **THEN** the failure is announced and focus stays on the control the reader
  used

#### Scenario: Narrow layout

- **WHEN** the form renders at 390 px
- **THEN** its fields stack, and its footer actions stay on one right-aligned
  row with no horizontal scrolling
