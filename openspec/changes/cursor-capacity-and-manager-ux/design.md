# Design

## Context

See `proposal.md` for motivation. The state that shapes the approach:

- `PublishedContext` (`src/providers/cursor/published-context.ts`) fetches
  `https://models.dev/api.json` out of band, checks the document's shape with
  `isPublishedCatalogDocument`, projects it with `projectWindows`, and persists
  a versioned snapshot. The check walks every nested model entry through
  `isPublishedModelEntry` and treats `limit.context <= 0` as a broken response.
  `publishedEntries` already skips exactly those entries when it reads them, so
  the two halves disagree about what an unreadable document is.
- The document the endpoint serves today carries 10 211 model entries across 326
  providers; 154 of them (image, speech, and transcription models) declare
  `limit.context: 0`, so the check can never pass and no snapshot exists.
- `resolveContextWindow(input)` takes the request's tier, the published window,
  and a manual window in that order and returns `{ tokens, source }`. The
  request path, the announcement in `CursorAdapter.resolveModel`, and the
  manager's rows all call it, which is what keeps them in agreement.
- The tier preference travels from configuration and settings through
  `contextPreferenceFor` into `modelParams`, `contextTierValue`,
  `resolveContextWindow`, `CursorRuntime`, and the accepted-tier record, whose
  stored `preference` field exists only to invalidate a record when the
  preference changes.
- The manager (`src/client/CursorModelsManager.tsx`, 619 lines) holds pure
  helpers, presentation, and the dialog in one module, keeps a draft plus a
  typed-text map, and saves the whole map behind an explicit Save. `tierChoices`
  always appends the two preferences, and `manualWindow.editable` is true
  exactly when neither a tier nor a published value decided the number.
- Constraints: one runtime dependency, hermetic tests with an injected fetch,
  network through the `hostFetch` seam, all state under
  `~/.dsh/plugins/subscriptions/`, unchanged DSH support window and host
  contract, and the repository's prose standard for every string.

## Goals / Non-Goals

**Goals:**

- Make the published projection run, and keep it running when the upstream
  document contains entries this projection cannot read.
- Keep one resolution shared by the request, the announcement, and the manager,
  now with a manual value ahead of the third-party estimate.
- Give each model one readable line that states the window and its source, and
  one control that corrects a wrong number without disabling the source.
- Keep the derivation, the presentation, and the writes in separate modules so
  each is testable without a browser, a network, or a host.

**Non-Goals:**

- Normalizing Cursor's own id spellings (`glm-5p3`) or keeping a hand-written
  capacity table for models the public catalog does not describe. The manual
  override is the answer for those rows.
- Changing the matching rules (vendor preference, most-declared value) or the
  snapshot version.
- A plugin settings page through the host's `plugins.row.config` slot, grouping
  the list by family, or a "new models" default.
- Any change to DSH's compaction, to other providers' catalogs, or to the Cursor
  quota surface.

## Decisions

### 1. The document check judges shape; the projection judges entries

`isPublishedCatalogDocument` becomes `hasPublishedCatalogShape`: the document is
a non-empty object, every value is an object, and every `models` field is an
object. `isPublishedModelEntry` is deleted. `publishedEntries` keeps deciding
what it can read, and it already skips an entry without a usable capacity, so
"the endpoint answered with the catalog I asked for" and "this entry describes a
capacity" stop sharing one verdict.

`SNAPSHOT_VERSION` does not move. The rules that produce the projection are
unchanged, and no snapshot was ever written under the old check, so there is
nothing to discard.

Alternatives rejected:

- **Keep the entry check and tolerate `limit.context: 0`.** The next variation
  the endpoint introduces fails the same way for the same reason.
- **Keep the strict check and report the offending entry.** The refresh still
  fails, and the report changes nothing for the reader.
- **Read `limit.context: 0` as a known-but-zero capacity.** A text-to-speech
  model has no context window; announcing zero would be worse than announcing
  nothing.

### 2. A manual value outranks the published capacity

`resolveContextWindow` resolves the requested tier, then the manual window, then
the published capacity, then the default. The resolver keeps returning the
source it used, so the manager can name it. The published capacity stays a
third-party estimate; a value the reader typed is a deliberate correction, and
making it lose to the estimate left only one escape — switching the source off,
which costs every other model its published number.

Alternatives rejected:

- **Keep the order and add a per-model pin flag.** The pin has to be resolved,
  stored, and shown, and it produces the same number the manual value already
  would.
- **Drop the published source entirely.** It is the only automatic source for
  seven of the eleven models that advertise no tier.

### 3. No tier preference in any layer

The route always requests the largest offered tier, and the tier Cursor accepted
after a rejection still wins while the catalog offers it. That removes the
preference from configuration, settings, the adapter, and the manager.

- `params.ts`: `preferredContext` and `DEFAULT_CURSOR_CONTEXT` are deleted;
  `contextTierValue(model, accepted)` becomes `requestedTier(model, accepted)`,
  returning the accepted value when the catalog offers it and the largest
  otherwise. `offeredContextValues`, `offeredTierValue`, `offersTier`,
  `smallerContext`, and `modelParams` keep their step-down and effort behavior
  and lose only the preference argument.
- `policy.ts`: `contextPreferenceFor` is deleted. `enabledFor`,
  `manualWindowFor`, and `publishedContextEnabled` stay.
- `cursor-settings.ts`: `CursorModelSettings` loses `context`, which the
  validator drops on read; `CursorAcceptedTier` stops requiring `preference`,
  and `acceptedTier(modelId)` no longer invalidates a record when a preference
  changes. The store keeps writing a constant `preference` on the record so an
  older build can still read the document after a rollback, and nothing in this
  build reads it.
- `adapter.ts` and `runtime.ts`: the `contextPreference` dependency is removed
  and both read `requestedTier` from the catalog entry and the accepted tier.
- `src/index.ts`: `cursor.context` and `cursor.models[].context` leave the
  schema and the wiring; `src/rpc/registration.ts` drops `context` from
  `settings()` and the tier fields from `models()`.

Alternatives rejected:

- **Keep the preference behind configuration only.** Nothing would read it in
  the manager, and `min` contradicts "always the largest".
- **Keep a per-model tier selector with the offered values.** The account step
  down already covers a rejected tier, and the selector is one more control for
  a decision the provider makes.

### 4. The manager is three modules with one write path

`CursorModelsManager.tsx` splits along the responsibilities it already mixes:

- `cursor-manager-derive.ts` — pure: the row view type, the filtered list, the
  enabled count, the default-fallback count, the window parse and format
  helpers, and the source sentences. `mergedManagerState` and
  `cursorModelsPatch` disappear with the explicit save.
- `CursorModelsBody.tsx` — hook-free presentational rows and sections, so a test
  renders one row without a host, the same way `ProviderModelEditor` and the
  reference implementation's views are built.
- `CursorModelsManager.tsx` — the dialog, the catalog fetch, the autosave, and
  the revert on failure.

`CursorCapacitySource.tsx` takes the source block out of `CursorCard.tsx`, which
keeps one status line and the button that opens the manager.

Each change writes the whole `models` map through the existing
`cursorSetSettings` call: the store already replaces that field wholesale, and a
per-model patch would add a second write semantic for the same result. A toggle
writes immediately; a typed window writes 500 ms after typing stops, so a word
is one write and not eight.

Alternatives rejected:

- **Autosave without debounce.** One serialized file write per keystroke.
- **Keep Save and Cancel.** The reader changes a value and cannot tell whether
  the route uses it; the reference's autosave with a revert on failure answers
  that in the row itself.
- **A per-model RPC patch.** New store semantics with no observable gain.

### 5. One line per model, and the source on the value

A row names the model, its id, and the window as a single value; the source sits
on the value's title and in its accessible name instead of a separate dim label.
A row whose window does not come from a tier carries a pencil that swaps the
value for a field; a saved override shows as manual and still names the source
it replaced, and a second control returns the model to the automatic value. A
tiered row has no pencil, because the tier decides what the provider applies.

The source sentences come from one function used by the chip, the title, and the
tests, so the words on screen and the words in the spec cannot drift. The filter
reuses `modelListState` from `model-filter.ts`, which already tells an empty
provider from a filter that matched nothing.

Alternatives rejected:

- **Keep the field visible and prefill it.** That is the reference's shape and
  the source of the complaint: a text box on a row nobody is editing.
- **A per-row disclosure.** An extra click for the common act of reading a
  number.

### 6. Verification follows the layers

- Pure functions: the shape check (a real-shaped document with a zero-context
  entry), the projection, the resolver's four-step order, the settings validator
  with a legacy document, and the derive module.
- The service with an injected fetch: the readable document with unusable
  entries projects and persists; a document of the wrong shape still fails and
  keeps the previous snapshot.
- The adapter and runtime through their existing fakes: the largest tier is
  requested, the accepted tier is reused and dropped when withdrawn, and a
  configured tier is ignored.
- The dialog: a component test for a row's chip, pencil, and failed write, a
  mount test for autosave and the debounce, and a screenshot of the real
  components.

## Risks / Trade-offs

- **models.dev keeps drifting** → an entry the projection cannot read is
  skipped, its row falls back to the default or a manual value, and the source
  stays named on the value.
- **A manual override hides a later upstream correction** → the chip still names
  the source it replaced and one control returns the model to the automatic
  value.
- **Removing a configuration key the host validates strictly** → confirm how the
  host treats a key the schema no longer declares before removing it; if it
  rejects them, keep the keys declared and ignore them, and document them as
  deprecated.
- **Autosave writes more often** → a toggle writes one small document, the typed
  field is debounced, and every write is serialized and atomic.
- **Two surfaces write settings at once** → last writer wins, as it already does
  for the ceiling and the source switch.
- **Rollback after an upgrade** → the document stops carrying `models[].context`
  (optional for the older build) and keeps an `acceptedTiers[].preference`, so
  an older build still validates it instead of resetting the file.
- **A profile pinned to `min` loses that pin** → the step-down still answers a
  rejected tier, and the migration note states the change.
- **27 rows are still 27 rows** → compact rows and a filter; grouping was
  considered and declined.

## Migration Plan

No stored document changes shape: `models[].context` is ignored on read and not
written again, `acceptedTiers` keeps an object per model, and the projection
document is rebuilt by the next refresh. The plugin version moves by a minor.
Rollback reverts the code; the documents stay readable in both directions.
