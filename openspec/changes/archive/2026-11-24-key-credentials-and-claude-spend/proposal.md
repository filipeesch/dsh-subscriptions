# Proposal

## Why

Two gaps in the same settings surface make a working provider look broken.

The Cursor route authenticates with a DSH credential reference, and the plugin
never writes one. The Cursor card prints a fixed instruction naming
`CURSOR_API_KEY`, and the only ways to satisfy it are exporting an environment
variable or editing the credential store outside DSH. A reader who pastes a key
into the card gets nothing: no host path accepts it, and the card cannot even
say whether a key was found in the environment or in the store behind the
reference.

Claude's quota is read from the OAuth usage endpoint, but the reader models only
the plan windows (`five_hour`, `seven_day*`, `limits[]`). An account metered by
a dollar budget — an enterprise seat — reports those windows as null and states
its quota only in the `spend` and `extra_usage` blocks the reader ignores, so
the card says "no usage reported" while the endpoint reported a ceiling and the
spend against it. The same payload carries the weekly OAuth-apps lane, which the
reader also ignores, so a subscription account sees one lane fewer than Claude
Code's own `/usage` screen shows.

## What Changes

- **In-card credential for key routes.** The Cursor and Ollama Cloud cards state
  where the key currently comes from — the DSH store, the environment, a project
  or user `.env`, or nowhere — show a masked preview when the host supplies one,
  and offer save, replace, and remove. A saved key is validated by the route's
  own read (catalog discovery for Cursor, model listing for Ollama Cloud); a
  failed validation is reported on the card and the key stays saved. Removing a
  key clears only the DSH copy and says so when an environment variable still
  supplies one.
- **One host credential service for the two key routes**, with three RPC
  endpoints keyed by route id. Only a reference fixed by operator configuration
  is served: a route whose reference the browser can rename is refused, so the
  surface can never be aimed at another credential. A pasted secret cannot be
  stored as a reference, no refusal repeats a name or a value, a committed write
  is reported as committed even when its state cannot be read back, and a save
  is validated by a read that cannot join the previous key's in-flight fetch. A
  host that does not report a masked preview still states the origin.
- **Claude's dollar budget.** Map the `spend` block to one money window placed
  last, normalized by the exponent and currency the endpoint declares, falling
  back to `extra_usage` only when the spend block omits the spend. A value the
  payload states but cannot support drops the window instead of becoming a
  spend-only reading; a zero ceiling stays zero. Read the `seven_day_oauth_apps`
  weekly lane. Record when a non-empty reading carries no plan window, so the
  card can state that instead of presenting a lane as the whole reading.
- **Amounts in the settings card rows.** One shared window row and label serve
  the Claude, Codex, Cursor, and key-only cards, so a money window reads as
  "used / limit" in its currency and a percent window keeps its share. A window
  that carries neither states that its share is unavailable.
- **Refactors on the touched surfaces.** Split the RPC dispatch into per-domain
  handlers, give `registerAuthRpc` an options object, derive every key reference
  from one exported source, and replace the external usage reader's source
  switch with a reader map so a new source no longer edits the controller.

## Capabilities

### New Capabilities

- `auth/key-route-credentials`: reading, writing, and clearing the credential a
  key-based route authenticates with, from the Settings card, with origin and
  masked preview and with no value ever leaving the host.
- `providers/claude`: Claude's subscription quota reader — plan windows, the
  OAuth-apps weekly lane, the dollar budget an enterprise seat reports, and the
  reading state when the endpoint reports no plan window.

### Modified Capabilities

- `usage/quota-windows`: a window row states the amounts the window carries, on
  every settings card, instead of only a share.

## Impact

- **Host.** A new credential service for the two key routes; the RPC endpoint
  table and its dispatch; provider assembly and RPC assembly; the Claude usage
  reader; the external usage controller; the key-reference constants of the
  Cursor and Ollama routes; one optional field on `ProviderUsage` for the "no
  plan window reported" state.
- **Client.** A shared credential field and a shared window row with one label
  helper; the Cursor card, the Ollama card and its model dialog, the
  subscriptions section, the key-only cards, and the locale dictionaries
  (English and Chinese).
- **Compatibility.** The DSH floor (0.1.7-rc.2) already exposes `describe`,
  `set`, and `unset` on the credential seam, so no shim is needed. The masked
  preview first appears on the 0.2 line, so it is read as an optional field and
  the card degrades to the origin. Peer ranges and the support window are
  unchanged, and no new host name is read.
- **Tests.** Claude reader fixtures for the spend and extra-usage shapes, the
  OAuth-apps lane, the exponent, the disabled block, and the ordering; RPC
  coverage with a fake credential provider for describe, write, clear, an
  unknown route, a missing credentials service, and a host without `masked`;
  component coverage for the credential field and the shared window row.
- **Docs.** The README feature list, the Cursor doc's prerequisite and a new
  card section, the changelog, and one Agent Note per decision.
