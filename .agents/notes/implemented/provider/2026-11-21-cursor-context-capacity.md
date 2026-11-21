# Agent Note: Cursor's advertised context capacity

Status: implemented

## Problem

DSH prices compaction from the context window an adapter advertises. The Cursor
route derived that window from the catalog's `context` parameter alone, with a
200 000-token fallback. Cursor lists some models without that parameter — for
example `deepseek-v41-flash-1017`, whose real window is 1 048 576 tokens — so
the route metered a fifth of the capacity it had. Pressure then landed near 134
000 tokens, a model switch triggered compaction the provider would never have
required, and a switch failed outright when the host summarized through a route
without balance. The tier Cursor accepted after rejecting the requested one was
also invisible to the adapter, so after a legitimate step-down the route kept
advertising the rejected, larger window.

## Decision

The advertised window resolves through one pure function shared by the request,
the announcement, and the model manager: the effective context tier's capacity,
then the capacity the public models.dev catalog publishes for the model, then a
manual per-model value, then 200 000. The advertised number is therefore the
capacity the provider will apply, and the model manager shows the same number
the host meters.

The public source is fetched out of band through the host fetch (20-second
timeout, 64 MiB cap, once on start and after 24 hours) and projected onto the
ids Cursor currently lists: ids and display names are compared ignoring case and
punctuation, entries from the model's own vendor outrank other gateways (exact
provider identities and explicit aliases, never a substring), and the capacity
most of those entries declare wins. The projection is stored in
`cursor-context-windows.json` with a version, so a rules change discards an old
snapshot instead of trusting it. A structure check separates a malformed
response from a valid catalog that matches no id; only the latter may replace
the snapshot with an empty projection. The last id set is recorded even when the
snapshot is fresh, so a withdrawn id stops being served at once and a refresh in
flight projects ids seen before it finished. A refresh failure keeps the
previous projection, and a request only reads the snapshot, so the network never
sits on the turn path. The source can be switched off; off stops both the fetch
and the serving, so a stored projection cannot keep pricing turns.

The last live catalog is stored in `cursor-catalog.json` and seeds the route at
start, so the projection has ids before the first live read completes; a failed
discovery keeps that catalog, and only the absence of both reaches the built-in
list. The accepted tier and the per-model settings live in
`cursor-settings.json`, with the plugin configuration as a baseline per field.
The card's **Manage models** dialog edits enablement, tier, and manual window,
and the card states whether the published source is on, when it refreshed, and
offers both controls.

## Alternatives considered

- **Publish before the tier.** It can advertise more than the tier Cursor
  applies, which repeats the original failure with a different source.
- **Let a manual value outrank the tier or the published capacity.** A stale
  hand-edit would override the provider's own tier and a current public value.
  Correcting a wrong published number takes switching the source off first.
- **First published match wins.** One gateway's reduced-window variant would
  become the model's capacity.
- **Match a vendor by a substring of the provider name.** A gateway whose name
  merely contains `deepseek` is not DeepSeek; exact identities and a small alias
  list are used instead.
- **Hardcode a table, or scrape Cursor's model pages.** Both rot on the
  provider's schedule; the public catalog already carries the values, and the
  reference plugin proved the projection works.
- **Fetch models.dev inside model resolution.** A third-party outage would fail
  turns or add latency to every one of them.
- **A cursor entry in `models.json`.** It would widen the provider id union into
  the auth, pool, and RPC paths and mix two catalog shapes in one validator.
- **A second private catalog cache.** It duplicates the seeding,
  stale-while-revalidate, and write-through behavior the shared cache tests, so
  the shared cache gained a type parameter instead.
- **Keep the accepted tier in memory only.** The rejected window returns after
  every restart, exactly when a rejection has already cost a run.
- **Key the accepted tier by credential.** The route serves one credential; the
  extra dimension has no consumer.
- **Configuration-only settings.** The card could not save, and the reported
  case was a user with no YAML in front of them.

## Consequences

Three small documents join the DSH home, and the route gains a third-party
dependency on models.dev that can be switched off. The projection adds one
network read on start; a failure is visible on the card and costs only the
fallback. The advertised window now changes with the provider and the public
catalog, so a wrong upstream value can force early or late compaction; the
manual field is the escape hatch (after switching the source off), and the
manager states the source of every number. The model manager is a new client
surface, and the settings document grew fields that must stay compatible with
older installs; it degrades to the configuration baseline when unreadable. The
route still serves one credential, so per-credential learned tiers remain out of
scope. Settings writes are serialized on disk and committed to memory only after
the write succeeds, so a rejected save neither changes resolution nor leaks into
a later save. The one exception is a learned tier: it is visible to the running
turn through a small in-memory overlay, and a failed write leaves it memory-only
instead of pretending the acceptance was stored. The route's registration handle
is retained, so a saved per-model setting or a changed live catalog (ids or the
picker-facing metadata) re-announces the route after the new entry is installed,
and a loaded picker re-lists without reconnecting.

## Evidence boundary

Unit tests and injected gateways prove the resolution order, the projection
rules, the disabled-source behavior, the catalog seeding, the durable accepted
tier, and the RPC contracts. They do not exercise a real Cursor account, a live
models.dev response, or the host's compaction. The review screenshots render the
shipped presentational components with fixture data; they do not prove the
mounted dialog's focus trap, scroll behavior, or a running refresh. Only a live
host run covers those, which the host E2E does for the rest of the settings
surface, not for this dialog.
