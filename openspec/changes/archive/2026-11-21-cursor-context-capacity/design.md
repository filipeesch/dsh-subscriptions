# Design

## Context

See `proposal.md` for the motivation. The current route, the host behavior it
interacts with, and the evidence behind the approach:

- `CursorAdapter` resolves the advertised window from the catalog entry's
  `context` parameter alone and falls back to 200 000 tokens. Its catalog cache
  lives only in memory (10 minutes for a live read, 60 seconds for the built-in
  list), so a restart has no ids and no capacity metadata.
- `CursorRuntime` requests the configured tier and, after Cursor rejects it,
  remembers the accepted tier in a per-credential in-memory map. The adapter
  never sees that value, so the route keeps announcing the rejected tier.
- DSH prices compaction from `LlmResolvedModelInfo.context.contextWindow`:
  pressure is `min(0.8 × window, window − reserved output − 65 536)`. A 200 000
  window therefore compacts near 134 000 tokens, a 1 048 576 window near
  838 000. A model switch prices the proposed route and compacts the history
  through the route that last answered; when that summarization fails, the host
  aborts the switch.
- Evidence from the reported case: Cursor's catalog lists
  `deepseek-v41-flash-1017` with only `reasoning_effort`; the public models.dev
  catalog publishes 1 048 576 for it, and the standalone `cursor-to-dsh` plugin
  already projected that value and persisted the projection.
- Constraints: the package keeps one runtime dependency (`@cursor/sdk`), tests
  are hermetic with injected gateways and fetch functions, network calls use the
  `hostFetch` seam so the host's proxy applies, route state lives under
  `~/.dsh/plugins/subscriptions/`, and the DSH support window must not move.

## Goals / Non-Goals

**Goals:**

- Announce the capacity the provider will actually apply, so the host's
  compaction pricing matches reality.
- Make the catalog, the published projection, the per-model settings, and the
  accepted tier survive a restart.
- Keep resolution shared by the request, the announcement, and the settings
  display so they cannot disagree.
- Keep the adapter thin: catalog, storage, fetch, and policy live in their own
  modules behind injected functions.

**Non-Goals:**

- Changing DSH's compaction behavior or choosing its summarization route.
- Cursor Fast tier, timing diagnostics, or a "new models" default.
- A plugin-owned settings page through the host's `plugins.row.config` slot.
- Multiple Cursor credentials, pooling, or per-credential learned tiers.
- Changing any other provider's catalog, cache, or window resolution.

## Decisions

### 1. One resolution order, shared by request, announcement, and display

Order: the effective context tier, then the capacity models.dev publishes, then
a manual per-model value, then 200 000. The effective tier is the accepted tier
(while the catalog still offers it and the configured preference matches), else
the per-model preference, else the global preference. A pure resolver returns
both the token count and its source (`tier`, `published`, `manual`, `default`)
so the card can state where a number came from.

Alternatives rejected:

- **Published before tier.** It would announce more than the tier Cursor
  applies, repeating the same class of bug with a different source.
- **Manual before tier or published.** A stale manual value would override both
  the provider's own tier and a current public capacity.
- **Resolve separately in the adapter, runtime, and RPC.** Three copies drift;
  the UI would describe a window the host does not meter.

### 2. Published capacities come from models.dev, refreshed out of band

The service fetches `https://models.dev/api.json` through `hostFetch` with a
20-second timeout and a 64 MiB response cap, projects the document onto the ids
Cursor currently lists, and persists a versioned snapshot
(`cursor-context-windows.json`). It fetches on start and when the snapshot is
older than 24 hours; a request only reads the snapshot. A failed refresh keeps
the previous projection and never fails a request. The source is on by default
and can be turned off from the card; off means no fetch and no published value.

Alternatives rejected:

- **A hardcoded capacity table.** It rots on the provider's schedule and wins
  nothing over the public catalog.
- **Scrape Cursor's model pages.** Per-model pages change without an API, and
  the reference implementation already proved models.dev covers the catalog.
- **Fetch inside `resolveModel`.** It puts a third-party network call on the
  request path and turns an outage into failed turns.

### 3. Projection rules match the reference implementation

Normalize a model id by lowercasing and removing non-alphanumerics, compare on
that key and on the display name, and compare the last path segment of a
published id. When several published entries match, prefer entries whose
provider belongs to the model's own vendor (a prefix map: `claude` → anthropic,
`gpt` → openai, `gemini` → google, `grok` → xai, `kimi` → moonshot, `glm` → zai,
`deepseek` → deepseek, `muse` → meta) and take the capacity most of those
entries declare, preferring the larger value on a tie. A malformed document
reads as empty. The snapshot's version must be bumped whenever these rules
change, so a snapshot written under other rules is discarded rather than trusted
for a day.

Alternatives rejected:

- **First match wins.** One gateway's reduced-window variant would become the
  model's advertised capacity.
- **Minimum or maximum across all matches.** Minimum understates the provider's
  own window; maximum lets a third-party entry speak for the vendor.

### 4. The catalog is durable and credential-gated

The last live catalog is persisted as `cursor-catalog.json` (validated
`CursorCatalogModel[]` with a timestamp). The route seeds from it on start,
serves it while a live refresh runs (stale-while-revalidate), persists every
successful live read, and falls back to the built-in list only when neither a
live read nor a persisted catalog is available. It advertises models only while
the credential reference resolves, preserving the documented "without a key the
route offers no models" contract.

This reuses the shared `ModelCatalogCache`, generalized as
`ModelCatalogCache<T = DiscoveredModel>`; the five OAuth providers keep their
current types and behavior. The Cursor persistence implements the same
`CatalogPersistence` contract against its own document, so the shared file's
shape and validation stay untouched.

Alternatives rejected:

- **A cursor entry in `models.json`.** It would widen the provider id union into
  the auth, pool, and RPC paths and mix two catalog shapes in one validator.
- **A second private cache in the adapter.** It duplicates the seeding,
  stale-while-revalidate, and write-through behavior the shared cache already
  tests.
- **Persist only as a failure fallback.** The published projection would have no
  ids on the first request after a restart.

### 5. The accepted tier is persisted per model

`cursor-settings.json` stores `acceptedTiers[model] = { value, preference }`.
`CursorRuntime` writes it after a step-down succeeds, reads it when deciding the
request parameters, and drops it when the catalog no longer offers the value or
the preference changed. The adapter announces the accepted tier's capacity.

Alternatives rejected:

- **Memory only.** The rejected tier comes back after every restart, and the
  advertised window is wrong exactly when a rejection has already cost a run.
- **Key by credential hash.** The route serves one credential; the extra
  dimension has no consumer.

### 6. Settings override a configuration baseline, per field

`cursor-settings.json` gains
`models[id] = { enabled?, context?, contextWindow? }`, `acceptedTiers`, and
`publishedContext`. The configuration gains `cursor.contextWindows` (model →
tokens) and `cursor.models` (model → `enabled`/`context`), keeping
`cursor.context` as the global default. Resolution is per field: the stored
setting, else the configured value, else the catalog and defaults.

Alternatives rejected:

- **Configuration only.** The card could not save, which the request explicitly
  wants.
- **Settings only.** Deployments lose the ability to pin a baseline in the
  profile.
- **Reuse `provider-settings.visibleModels` for enablement.** That store, the
  pool, the auth store, and the RPC unions all key on `ProviderId`; Cursor is
  deliberately outside it.

### 7. The model manager is a dialog on the Cursor card

The card keeps its connection and quota content, gains the published source's
state (on/off, last refresh, refresh now), and a **Manage** button opening a
native dialog built like `OllamaSettingsManager`: one row per listed model with
an enable toggle, a tier selector (Auto plus the offered tiers), a manual window
field with the resolved value and a source tooltip when the field is not
editable, a catalog reload, and an explicit Save. The dialog reads one RPC
payload and saves one settings document, so a failed save keeps every edit.

Alternatives rejected:

- **The reference plugin's own settings page.** It needs the host's
  `plugins.row.config` slot, which this repository does not use and its host
  contract does not cover.
- **Autosave.** The repository's existing manager saves explicitly; two save
  semantics in one card would be worse than the small extra click.

### 8. Three refactors keep the new code out of the adapter

- A shared `src/json-file.ts` provides serialized, atomic JSON writes with the
  Windows rename retry. The new stores use it, and this change migrates
  `cursor-settings.ts` and `catalog-store.ts`, the two stores it already
  touches. The remaining stores keep their helpers and move in a later change.
- `src/providers/cursor/models.ts` splits into `catalog.ts` (types, parsing,
  names, built-in list), `params.ts` (effort and tier mapping), and
  `context-window.ts` (resolution). The adapter imports the new modules; the
  public package entry is unchanged.
- `ModelCatalogCache` becomes generic instead of gaining a second cache.

Alternatives rejected:

- **Leave the helper duplicated.** A fifth copy of the same temp-file dance for
  the two new documents is the wrong direction.
- **Migrate every store at once.** It widens a behavior change with unrelated
  file IO risk.
- **Skip the split.** The adapter would own catalog parsing, projection
  plumbing, and window policy at once.

### 9. Verification follows the existing layers

- Pure functions (projection, resolution, settings validation, catalog
  validation) are unit-tested without I/O.
- The service is tested with an injected fetch: success, malformed document,
  version mismatch, timeout, oversized body, disabled source, and a failed
  refresh keeping the previous projection.
- The adapter is tested through `listModels`/`resolveModel` with a fake gateway
  and persistence: cold seed, restart, discovery failure, credential gate, and a
  no-tier model advertising the published capacity.
- The runtime is tested for the accepted tier: written after a step-down, used
  while offered, dropped when withdrawn, ignored when the preference changed.
- The RPC and the dialog are component-tested; the dialog gets screenshots from
  the real components, captured against a stub.

## Risks / Trade-offs

- **models.dev drifts or publishes a wrong capacity** → the projection ignores
  malformed entries, prefers the model's own vendor, keeps the previous snapshot
  on failure, and a manual value remains available; the card states the source
  so a wrong number is diagnosable.
- **A model without a tier still has no authoritative source** → the route
  advertises the default 200 000, which is the pre-change behavior; the manual
  window and the settings field are the escape hatch.
- **Persisted state goes stale** → every live catalog read replaces it, the TTL
  refreshes on the first read after it, and discovery failure keeps the last
  known catalog by design; a withdrawn model can stay selectable until a live
  read succeeds.
- **A settings file is unreadable or invalid** → the store degrades to the
  configuration baseline and defaults, keeps the file for manual recovery, and
  the next save overwrites it, matching the existing Cursor settings store.
- **Cross-process writes** → writes are serialized in-process and land
  atomically; separate processes stay last-writer-wins, as every store in this
  package.
- **Refactor churn in shared modules** → the split is mechanical, the cache
  gains only a type parameter with a default, and the suite runs between steps.
- **A genuinely large switch still compacts** → out of scope: the host
  summarizes through the last answered route. The docs state that the advertised
  window is what the host meters, and the operator can configure the
  summarization route.
- **Two plugins register `cursor`** → the host rejects the second with
  `DUPLICATE_ADAPTER`; removing `cursor-to-dsh` from the profile is part of
  adopting this route, not of the code.

## Migration Plan

No stored document changes shape in a way that needs conversion: the settings
document gains optional fields, the catalog and projection documents are new and
written lazily, and a missing or unreadable document degrades to the current
behavior. Existing configuration keeps working; `cursor.contextWindows` and
`cursor.models` are optional additions, and users of `cursor-to-dsh` copy the
same keys into the `cursor` block. Rollback removes the new fields and files;
nothing depends on the new shape when the code is reverted. The plugin version
moves by a minor, and no DSH support window or host contract changes.
