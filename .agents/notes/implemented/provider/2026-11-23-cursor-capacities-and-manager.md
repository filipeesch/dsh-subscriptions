# Agent Note: Cursor context capacities and the model manager

Status: implemented

The advertised window and the manager that shows it were first decided in
[Cursor's advertised context capacity](../../archived/provider/2026-11-21-cursor-context-capacity.md).
That note stays frozen; this one records what replaced its precedence, its tier
setting, and its save model.

## Problem

The published-capacity source had never worked. Its structure check required
every model entry in the models.dev document to declare a usable
`limit.context`; the live document carries 10 211 entries, and 154 of them —
image, speech, and transcription models — declare `0`. One such entry failed the
whole refresh, so no projection was ever stored and every Cursor model whose
catalog entry offers no context tier kept the generic 200 000-token window.
`deepseek-v41-flash-1017` advertises 1 048 576, so DSH compacted the
conversation five times earlier than the provider would have.

The manager could not be read. It offered a context-tier selector on models that
advertise no tier, because the two preferences were always offered regardless of
what the model publishes; it showed the manual window field exactly on rows
whose number had fallen back to the default, which with a broken source was most
rows; the number and its source sat in a dim trailing label; and 27 rows of
three to five lines, with no filter, left the reader unable to say what the
route would advertise for one model or where the number came from. Correcting a
wrong published value required switching the source off for every model, because
a manual value ranked below the estimate.

## Decision

The structure check judges the document, not each entry: a non-empty object of
provider objects whose `models` field is an object. Whether an entry carries a
capacity belongs to `publishedEntries`, which skips what it cannot read. A
document of another shape still fails and keeps the previous snapshot, and the
snapshot version did not move because the projection rules did not.

The advertised window resolves the requested tier first, then a manual value,
then the published capacity, then 200 000. A manual value outranks the estimate
because the published number is third-party and the manual one is the reader's
correction; only the tier outranks both, because that is what the provider
applies.

The context tier is not configurable. The route asks for the largest tier a
model offers and reuses the tier Cursor accepted after a rejection while the
catalog still offers it. `cursor.context`, `cursor.models[].context`, and the
stored `models[].context` no longer take part in resolution, and the accepted
tier record keeps a constant `preference` only so an older build can still read
the document after a rollback.

The manager is three modules: `cursor-manager-derive` (rows, filter, counts,
window parsing and formatting, source sentences), `CursorModelsBody` (hook-free
rows), and `CursorModelsManager` (the dialog, its reads, and its writes).
`CursorCapacitySource` holds the card's one-line state and the manager's
section. A row names the model, its id, and the window as a chip whose title and
accessible name carry the source; a row whose window does not come from a tier
offers a pencil that stores a manual override, and a manual row names the value
it replaced and offers a return to the automatic value. Every change is written
as it is made — an enablement change at once, a typed window after a 500 ms
pause — and a refused write restores what the route holds and states the failure
in that row.

## Alternatives considered

- **Relax only the `limit.context: 0` case.** The next variation the endpoint
  introduces fails the refresh again for the same reason: a document rule that
  walks entries duplicates what the projection already decides per entry.
- **Normalize Cursor's id spellings, or keep a documented capacity table.** Both
  target specific models the public catalog describes under another id
  (`glm-5p3` for `glm-5.3`) or not at all (Composer). The manual override
  corrects those rows without a second source of truth to maintain.
- **Keep the manual value below the published estimate.** The only escape from a
  wrong upstream number was switching the source off for every model, which the
  reported reader could not do without losing the numbers that were right.
- **A per-model pin flag on top of the precedence.** It resolves, stores, and
  renders a second flag to reach the number a manual value already produces.
- **Keep the tier preference in configuration only.** Nothing would read it in
  the manager while `min` still contradicts "always the largest offered", which
  is the behavior a reader expects and the one that keeps compaction priced
  correctly.
- **Keep a per-model tier selector with the offered values.** The automatic
  step-down already covers a rejected tier; a selector is one more control for a
  decision the provider makes.
- **Keep Save and Cancel.** A reader changes a value and cannot tell whether the
  route uses it; autosave with a revert answers that in the row itself, which is
  where the old screen failed.
- **Keep the manual field visible and prefilled.** That is the reference
  plugin's shape, and the source of the complaint: a text box on a row nobody is
  editing.
- **A per-row disclosure for the override.** It adds a click to the common act
  of reading a number.
- **Group the list by vendor family, or sort it by name.** A filter and one
  compact line per model answer the reported "the list is too much" without
  imposing an order the catalog does not have.
- **A per-model RPC patch.** The store already replaces the `models` field
  wholesale; a second write semantic buys nothing observable.

## Consequences

The projection now runs, so the number the host meters can change with a
third-party document; the source switch still stops the fetch and the stored
projection, and the manual override is the per-model correction. A document that
is the right shape but describes nothing replaces the previous projection with
an empty one — the accepted trade of judging the document rather than each
entry. Dropping the tier preference means a profile that pinned a smaller tier
loses the pin; the automatic step-down covers a rejection, and the profile key
is ignored rather than rejected. Autosave writes the whole `models` map per
change, so two surfaces writing settings at once stay last-writer-wins, as they
already were. The accepted-tier record keeps a field nothing reads, which is the
price of a readable document after a rollback. The manager's split keeps the
rows, the presentation, and the writes separately testable, and the capacity
section leaving the card means the card no longer states a refresh failure.

## Evidence boundary

Unit tests prove the shape check against a document with a zero-capacity entry,
the projection, the resolution order with a manual value above a published one,
the legacy settings document, the tier request and its step-down, the derive
functions, every rendered row state, and the autosave, debounce, revert, and
source flows through a mounted dialog with a fake RPC. Nothing here exercised a
real Cursor account or a live models.dev document inside DSH: the capture that
found 154 unusable entries read the endpoint directly, and the screenshots
render the shipped presentational components with fixture data. The live check
of the refresh against a running host remains the operator's, recorded in the
dated verification report for this change.
