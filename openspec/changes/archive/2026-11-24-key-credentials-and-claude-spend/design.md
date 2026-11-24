# Design

## Context

See `proposal.md` — Why. The facts below shape the approach.

- Both key routes authenticate by _reference_: `createCredentialResolver` wraps
  `ctx.credentials.resolve`, and the seam resolves the DSH store first, then the
  process environment and `.env` files. Environment discovery therefore already
  works; what is missing is a write path and a way to _say_ where the value came
  from. `describe(ref)` answers presence, source layer, and writability, and the
  0.2 DSH line adds a provider-masked preview.
- The settings RPC mounts one exact POST route per endpoint on the shared `/api`
  channel and dispatches through a switch that grows with every endpoint;
  `registerAuthRpc` takes seven positional optionals.
- The Claude reader maps `limits[]` and the flat plan buckets. Money already
  exists on the shared window (amounts in the currency's minor unit, a ceiling,
  a remaining amount, a currency) because the Cursor route needed it, and the
  footer bar, its tooltip, and the usage dialog already render it. The settings
  card row does not: four cards carry their own copy of the row.
- A live read with an owning account confirmed the second shape: an enterprise
  seat reports every plan bucket as null, `limits` as empty, and states the
  budget in a spend block beside a flat extra-usage block. The amounts arrive in
  minor units with a declared exponent and currency, and the OAuth-apps weekly
  bucket is published.
- Compatibility floor: DSH 0.1.7-rc.2, which the devDependencies pin, exposes
  `describe`, `set`, and `unset`, but its `CredentialInfo` has no masked
  preview. The test suite is hermetic, so the live read above stays a manual
  probe rather than a test.

## Goals / Non-Goals

**Goals:**

- One credential surface that serves both key routes and keeps every credential
  value on the host.
- A Claude reading that covers both account shapes — plan windows and a dollar
  budget — and states which one the endpoint did not report.
- One window row and one label rule shared by every card that lists windows.

**Non-Goals:**

- Several keys per route, key rotation, or key provenance beyond the layer name.
- A general credential editor for arbitrary references, or one for the OAuth
  providers.
- Changing the Cursor route's authentication scheme or Ollama's stored catalog.
- Reworking the footer bar, its tooltip, or the usage dialog, which already
  state amounts.

## Decisions

### Only an operator-controlled reference is editable

The browser names a **route**, and the host resolves that route's reference —
but only when the reference is one operator configuration fixed: the Cursor
profile reference, or Ollama's default/profile reference. Ollama also accepts a
reference from a card-editable setting, and that one is refused here. Accepting
it would make the endpoint set a writer for any credential the host knows: a
browser could rename the reference to another provider's key and then read its
presence, overwrite it, or delete it.

- Alternatives: keep accepting the effective reference and rely on the route id
  — the id bounds which route, not which reference, and the settings save that
  renames it is served by the same browser.

### A stored credential stays on the configured destination

Ollama Cloud's listing takes a base URL and an optional one-time key. The base
URL is also card-editable, so a listing from any other address would send the
stored credential wherever that address points. The host therefore spends its
resolved key only when the requested address matches the operator-configured
base URL; any other address requires a key supplied with that request. The
card's own post-save validation rides the value it just stored, so it proves the
new key without the host spending the stored one.

- Alternatives: keep the previous precedence — a one-time key falling back to
  the stored one regardless of address; that is the exfiltration path the review
  named.

### Route-addressed credential endpoints

The browser names a **route** and the host resolves the reference: the Cursor
route's effective `apiKeyRef` (`config.cursor.apiKeyRef`, default
`CURSOR_API_KEY`) and the Ollama route's effective reference (stored setting,
then config, then the default). Three endpoints are added — `keyCredential`,
`keySetCredential`, `keyClearCredential` — and a route the plugin does not serve
is refused before any read or write. No response carries the value.

- Alternatives: reuse the host's `credentials` Remote namespace from the client
  — it ties the plugin to a host namespace that headless profiles and older
  lines need not mount, and the plugin already owns a channel with its own
  authentication fence; ship the reference name in the payload — it turns the
  endpoint into a writer for any credential the host knows.

### A credential service between the RPC and the seam

A small module owns `describe`/`set`/`clear` by route, resolving
`ctx.get('credentials')` per call. The RPC is assembled before the credentials
service necessarily exists, so a lazy lookup keeps assembly order free and lets
a headless profile answer a clear error. Tests provide a fake seam.

- Alternatives: call the seam straight from the handlers — the route-to-
  reference mapping would be encoded twice and each handler would carry the
  seam's error mapping; one service keeps that knowledge in one place.

### The masked preview is optional

`CredentialInfo.masked` first appears on the 0.2 line while the devDependencies
pin the floor, so the plugin reads it through a locally declared optional field
and one cast. A host that does not report it leaves the card stating the origin
alone.

### Saving validates through the route's own read

Saving stores the value and then runs the read the route needs anyway: catalog
discovery for Cursor, model listing for Ollama. The card reports the outcome;
the key stays saved when validation fails, because a transient network failure
must not discard a good key. The card's own refresh then shows the route as
configured. Both cached reads are dropped before the picker is notified — the
usage reading, and the discovery that could still be in flight from the previous
key — because a forced read joins an in-flight fetch, and validating with the
old key would report success for the wrong credential.

A committed write is reported as committed even when the state read back fails:
the response carries the commit and an unread state, so a saved key is never
reported as a failed save, which would invite a second, needless write. The
service snapshots the reference once per operation, so the write and the state
it reads back describe the same reference.

- Alternatives: a dedicated ping per provider — new provider surface to maintain
  and it would prove nothing about the read the route performs; undo the save on
  failure — a dropped connection would lose a valid key.

### The Claude budget window prefers the block that carries the unit

The spend block carries each amount with its own exponent, currency, and a
reported percentage, so it is read first; the flat extra-usage block answers
only when the spend block omits the spend entirely. A value the payload states
but cannot support — a negative, a non-number, an unusable ceiling — drops the
window instead of falling back or becoming a spend-only row, because a drifted
payload must not read as a valid shape. A ceiling reported as zero stays zero, a
ceiling in another currency is dropped rather than divided, and a reported share
is clamped into the seam's 0–100 range. `remaining` is the reported balance when
the block carries money, otherwise the ceiling minus the spend when both are
known, and never invented.

- Alternatives: assume the amounts are cents — a plan may declare another
  exponent; assume dollars and multiply by a hundred — the live read shows the
  values are already minor units, so that assumption would report a hundred
  times the spend.

### Plan windows lead, the budget follows

The footer bar states the first window of the reading, so the budget window is
appended last: an account that reports both keeps the plan session quota in
front, and an account that reports only the budget still shows it. The window
keeps the shared colors (red from 90 percent) and no pace line, because the
endpoint discloses no reset for it.

- Alternatives: mark the window informational and filter it per display — two
  behaviors to test and a bar that stays empty for the enterprise shape.

### The missing plan windows are a reading state

When a reading carries a window but the payload reported neither a session nor a
weekly window, the reader sets one optional flag on the shared reading, and the
card renders one discreet line from it — gated on a money row being present, so
the line never stands alone. A reading with no window at all keeps the empty
state and clears the flag, so "no usage reported" and "no plan window reported"
stay distinguishable. Inferring either in the client from the window kinds would
guess from data that legitimately lacks the windows; the reader knows the
payload.

### One shared window row and one label rule

A single row component and a single label helper replace the copies in the
Claude/Codex account rows, the Cursor card, the Ollama card, and the key-only
cards. The rule moves into the usage capability: a session or weekly window
reads as its kind plus a scope, and any other kind reads as its scope alone.

- Alternatives: keep the copies and patch each for money — three copies of
  currency formatting, and the Claude budget row would read "Usage window ·
  Extra usage".

### Refactors on the touched surfaces

The dispatch switch splits into per-domain handler modules behind an endpoint
map while the transport stays; `registerAuthRpc` takes an options object; each
key route exports its default reference so the usage controller builds its table
from providers instead of duplicating `CURSOR_API_KEY`; and the external usage
controller's source switch becomes a reader map, so adding a source no longer
edits the class.

## Risks / Trade-offs

- [The enterprise payload may change again] → the reader distinguishes an absent
  amount from an unusable one, drops the unusable one, and pins both shapes by
  fixtures; the docs state that the shape is observed, not contracted.
- [A card-editable reference could aim credential writes elsewhere] → only
  operator-controlled references are served, a renamed reference is refused
  without touching any credential, a pasted secret cannot be stored as a
  reference at all, and no refusal repeats a value.
- [A rejected key stays stored after a failed validation] → deliberate; the card
  states the failure and offers removal, so the person can correct it in place.
- [A host without the masked preview shows less] → the origin line still tells
  the person whether the value is theirs to change; the limitation is
  documented.
- [Validation adds latency to a save] → it reuses the refresh path the card
  already runs and stays inside the existing discovery timeout.
- [One change spans two feature areas] → separate spec capabilities, separate
  task groups, and one PR that can be reverted as a unit.
- [The shared row touches four cards] → component coverage for the row and the
  existing bar, tooltip, and dialog specs pin the money behavior.

## Migration Plan

- No stored data changes: the credential store gains a value only when a person
  saves one, and the Claude reader derives everything from the endpoint.
- Visible behavior change on the Claude card: an account that previously read as
  "no usage reported" now shows the budget window and the line stating the plan
  windows were not reported.
- Rollback: revert the change. A key saved through the card remains valid
  because it lives in the DSH store under the same reference the route reads.
- Docs and changelog land in the same change; peer ranges and the support window
  are untouched, and no new host name is read.

## Open Questions

- The budget window is labelled **Extra usage** — the provider's own name, the
  one its own usage screen shows. If a different label is preferred it is a
  string change, with no effect on the reading or the specs.
