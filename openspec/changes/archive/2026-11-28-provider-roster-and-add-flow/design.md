# Design

## Context

See `proposal.md` — Why. These facts shape the approach.

- The section (`src/client/SubscriptionsSection.tsx`) owns one `statuses`
  snapshot for the five OAuth providers and renders one card per provider; then
  `CursorCard`, `OllamaCard`, and `ExternalUsageCards` each render their own
  cards and run their own reads. Eleven cards are always mounted.
- Two endpoints already answer "is this route configured": `status` for the
  OAuth providers (via `accounts`) and `externalStatus` for `cursor`,
  `ollama-cloud`, `opencode-go`, `kimi-code`, `minimax`, and `minimax-cn`.
  Neither covers the case the approved design adds: an Ollama local address with
  no Cloud key. `ollamaSettings.effective` and its `keyUsable` flag answer that
  from the same route the card already reads.
- Every write the add form needs already exists: `login`, `manual`, `cancel`,
  `keySetCredential`, `keyValidateCredential`, `ollamaSetSettings`, and
  `externalStatus`. No endpoint is added.
- The approved design is `design/` at the card's worktree: the contract in
  `design/README.md`, the roster in `design/screens/subscriptions.dsx`, the form
  in `design/screens/add-provider.dsx` with one screen per route, the Ollama
  connection choice in `design/screens/setup-ollama.dsx`, the review grouping in
  `design/preview.json`, and six journeys under `design/journeys/`. Captures:
  `subscriptions-desktop-dark-c8698413d1da.png`,
  `subscriptions-tablet-base-quota-preferences-9b639b4574f3.png`,
  `subscriptions-mobile-dark-codex-expanded-9b3b9617ed6f.png`, and
  `setup-ollama-mobile-dark-local-5f1640d77214.png` under
  `design/.cache/screenshots/`.
- The app's visual language comes from host tokens (`--dsw-alias-*`,
  `--dsw-radius-*`) applied through `providerSettingsCss` under
  `:is(.dsh-subscription-manager, .dsh-subscriptions-settings)`, plus inline
  styles in `subscription-card-styles.ts`. The design kit's `size.touch` token
  is 44 px and every control this change adds takes that height; the kit's
  `color.selected`, `color.border`, and `color.stroke` map to the host's layer
  and border aliases in both themes.

## Goals / Non-Goals

**Goals:**

- One roster whose rows are decided by a single reading of the configured set,
  so rows neither appear one by one nor turn a failed read into an empty list.
- Rows that reuse the existing card bodies, so no control, read, or validation
  path is rewritten to gain a disclosure.
- One add form that keeps every route's own method and writes nothing until its
  primary action.

**Non-Goals:**

- Changing any provider route, credential rule, usage reader, or host endpoint.
- Making the roster configurable, sortable, searchable, or reorderable.
- Persisting which rows are expanded, or which provider was added last.
- Turning the prototype's anchored popover and per-state screens into
  navigation; they are kit restrictions (see `design/README.md`, "Preview
  limits").

## Visual contract

The approved design is the source for the roster and the form. These facts are
binding for the implementation and for design review.

**States to build**

- **Preferences band:** collapsed (default), expanded.
- **Roster list:** configured rows, empty, checking, failed with Retry.
- **Row:** collapsed, expanded, needs attention, several accounts.
- **Form:** nothing chosen, route chosen, disabled primary, waiting for the
  browser, manual fallback open, device code shown, key rejected, key not found,
  address saved.
- **Themes and widths:** light and dark at 390, 768, and 1280 px.

**Visual acceptance criteria**

- The preferences band is a tinted, rounded panel above the roster, outside the
  roster's border; its trigger is a full-width disclosure header at least 44 px
  tall. Opening it shows the three existing controls, each with its label and
  its hint line.
- The heading row carries `Configured providers` and a primary `+ Add provider`
  action, right-aligned on one line and wrapped on narrow widths without
  shrinking either target below 44 px.
- The roster is one bordered, rounded list. Rows are separated by a one-pixel
  divider and have no border of their own. A collapsed row shows the disclosure
  chevron, the provider name, and the connection state, nothing else.
- An expanded row indents its content with the list's inset padding and keeps
  the card's own inner composition — account block, usage header, window rows,
  meters, and actions — unchanged.
- The empty, checking, and failed states are bordered panels, not bare lines.
  Only the failed state carries Retry.
- The form is one bordered panel: the heading `Add provider`, a full-width
  Provider control, a divider, the chosen route's fields, and a footer with
  Cancel and the route's primary action.
- The Ollama form offers the Cloud and local connection choice above the fields;
  the local field carries the address and the sentence stating that saving does
  not verify reachability.
- Every color resolves through a design token so the light and dark themes both
  render, and no row or form overflows its panel at 390 px.

## Decisions

### One configured-set read decides the rows

The section performs three reads in one snapshot — `status`, `externalStatus`,
and `ollamaSettings` — and derives the configured set from them: an OAuth
provider is configured when `status` reports at least one account; Cursor and
the four key-managed sources when `externalStatus` reports `configured`; Ollama
when `externalStatus` reports a resolving Cloud key **or** `ollamaSettings`
carries a saved base URL. The snapshot is replaced only on success, so a failed
read keeps the last known rows.

- Alternatives: let each card report "configured" upward — eleven independent
  reads, rows appearing one at a time, and no way to tell a failed read from an
  empty roster; add one aggregated host endpoint — a new host surface for facts
  that two existing endpoints already carry.

### A collapsed row reads no usage

Mounting a row performs the configured-set reads only. The first expansion
mounts the provider's detail, and that detail starts the reads its card already
ran: usage for the accounts and sources, the model lists for Cursor and Ollama,
and the credential state for a key route. Nothing about the reads changes; only
when they start does.

The composer badge polls its own usage and is refreshed by the same event the
detail dispatches, so deferring the roster's reads does not change the badge.

- Alternatives: read usage for every configured provider on mount — one
  likely-unused read per configured provider on a page a reader may open only to
  collapse a row; keep the reads but hide their output — the requests still run.

### The roster is a filter over one ordered provider table

One canonical table lists every provider with its route family. The roster
renders the rows the configured set allows, in that table's order: OAuth-session
providers in their current page order, then Cursor, then Ollama, then the
key-managed sources in their current page order. The add selector renders the
same table sorted by display name, because a lookup list is searched, not
scanned by route.

- Alternatives: order rows by configuration time — the order silently changes
  with history and cannot be reproduced after a re-read; one order for both
  lists — the roster would put Ollama and Cursor between OAuth providers, which
  the approved captures do not show.

### Rows reuse the card bodies

The section's OAuth provider block becomes a detail component, and
`ExternalUsageCards` becomes one detail per source. `CursorCard` and
`OllamaCard` gain a chrome-free variant so the row supplies the container. No
read, validation, or write path moves out of those components.

- Alternatives: rewrite each card's interior into the row — four components
  rewritten for a presentational change, with the account, usage, and credential
  behavior to re-prove; keep the cards' own borders inside the row — a
  double-framed list the captures do not show.

### The add form is one table and a route registry

One `ADD_PROVIDERS` table holds the eleven providers in selector order with
their family, their label, their copy keys, and the endpoint their primary
action calls. The form renders the selector, then the chosen family's fields,
then one footer whose primary action and label come from the same table entry.

- Alternatives: one component per provider — eleven components and eleven copies
  of cancel, failure, and confirmation handling; a wizard that replaces the form
  per provider — the approved behaviour keeps the selector and the fields in one
  form and returns to the roster only on success or cancel.

### Choosing a provider is a read, not a write

Choosing updates form state only: the fields shown, the primary action, and the
focus target. No endpoint is called. Switching providers discards the typed
values because the fields belong to the outgoing route and the routes do not
share a field.

- Alternatives: save on selection — the spec and the approved journey both show
  Cancel returning with nothing written; keep typed values across a switch — two
  routes with the same visual field would leak one route's text into the other's
  save.

### Each primary action keeps its route's write path

Browser authorization calls `login` and polls `status` while busy, exactly as
the card does; the manual fallback calls `manual`; the form's cancel calls
`cancel` for the attempt it started. The Cursor key rides `keySetCredential`
followed by `keyValidateCredential`, so a rejected key is reported by the
route's own read and stays saved. The key-managed routes call `externalStatus`
and never write a key. Ollama saves through `ollamaSetSettings` for the address
and the shared credential field for the Cloud key.

- Alternatives: a new "add provider" host endpoint — it would duplicate five
  write paths and their credential rules; a plain key input in the form writing
  through the existing credential service without validation — the saved key
  would be indistinguishable from a working one.

### The Ollama connection is one route with two saved facts

Ollama has a single route with a base URL and a credential reference. The form's
Cloud and local choices write the same route's two facts: a Cloud key at the
configured address, or an address on its own. A row whose stored Cloud key
cannot be spent at the saved address states that the key is idle there — the
host already enforces that policy — and saving an address never claims the
server answered.

- Alternatives: a second local route — a new model route, a new reference, and a
  new policy for a case the existing route already covers; treat a local address
  as a connectivity check — the product has no check to run and the design
  states the opposite.

### A confirmed configuration is authoritative

The form reports the confirmation to the section with the provider it
configured. The section marks that provider configured, closes the form, and
re-reads to reconcile. A failed reconciliation keeps the confirmed row and shows
the roster's failure state, so a confirmation cannot be swallowed by a failed
read. The confirmation line above the list is set by that handoff and cleared
when the form opens again.

- Alternatives: close first and let the row appear with a later read — a reader
  who just saved sees nothing new, which the approved captures contradict; trust
  only the re-read — a transient failure would hide a provider the route
  confirmed.

### The header is a real disclosure, the selector a real control

A row header is a `button` carrying `aria-expanded` and `aria-controls`, with
the provider name and state in its text and the chevron as a presentational
icon. The provider selector is a labeled single-select control, not the
prototype's anchored list. Outcomes and failures render in a live region. The
Ollama connection choice is a two-option control labeled as a group.

- Alternatives: a `details`/`summary` element — its default marker and summary
  styling fight the captures, and it cannot be controlled from the section's
  state; the anchored popover — a prototype restriction that would add
  positioning code and a dismissal path for a form field.

### Copy lives in the existing dictionary

Every roster and form string is a `settings.subscriptions` key in both
dictionaries. The state vocabulary is per route family — accounts connected, API
key configured, local address configured, needs attention — and no string names
an internal mechanism.

- Alternatives: derive state text from provider strings — the state is this
  page's claim about the route, and the routes do not report readable status
  text; English-only strings — the locale parity check in the alignment spec
  fails.

## Risks / Trade-offs

- [The panel becomes emptier than before] → the roster is shorter by design, and
  every unconfigured provider stays reachable through the form's selector, which
  also marks what is already configured.
- [A mis-detected configured set hides a working provider] → the Ollama case is
  decided by two facts rather than one, a failed read never removes rows, and
  the empty state requires a successful read.
- [Deferred usage reads delay quota numbers] → the numbers appear on expansion,
  which is where the spec puts them; the composer badge keeps its own polling.
- [Eleven cards' behaviour re-proven through a new container] → the existing
  component, section-state, alignment, and credential specs run against the same
  components, and the roster adds coverage only for which rows appear and what a
  row states.
- [The confirmation line could read as a persistent status] → it is cleared when
  the form opens again and never repeats per row.
- [Order could drift from the approved captures] → one ordered table decides
  both the roster and the selector, pinned by a test.

## Migration Plan

- No stored setting, wire shape, or preference changes: the display preferences
  keep their browser keys and the roster writes nothing on its own.
- Visible behaviour change: unconfigured providers no longer have cards, and a
  configured provider's controls sit behind its row header. Nothing else moves.
- Rollback: revert the change. No data was written, so a revert returns the
  eleven-card page with every setting intact.
- Docs and changelog land in the same change; the support window and peer ranges
  are untouched.

## Open Questions

- The wording of a managed-key source's row. "API key configured" is accurate
  but does not say where the key lives; the expanded detail already names
  Settings → Models. Letting the collapsed line carry that location is a
  dictionary change with no effect on the specs or the task breakdown.
