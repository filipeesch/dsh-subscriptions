# Proposal

## Why

A Cursor model with no context tier advertises whatever the public models.dev
catalog publishes for it, but that source has never worked: the projection's
shape check rejects the whole document because 154 of its entries — image,
speech, and transcription models — declare `limit.context: 0`. No snapshot was
ever stored, so `deepseek-v41-flash-1017` and every other tierless model keep
the generic 200 000-token default while the provider applies 1 048 576. DSH
prices compaction from that number, so it compacts five times earlier than the
provider requires, and the model switch that follows can fail for a reason
unrelated to the conversation.

The model manager cannot be read. It offers a context-tier selector on models
that advertise no tier, so the control is inert; the manual window field appears
in every row whose number fell back to the default, which — with a broken source
— is most rows; the number and its source sit in a dim label after an input; and
27 rows of three to five lines each, with no filter, leave the reader unable to
say what the route will advertise for one model, let alone where it came from.
The reference implementation in `cursor-to-dsh` shows the same data in two
compact lines per model, with the window as a chip and its source on a tooltip.

## What Changes

- The published-capacity projection judges the document's structure, not every
  entry: a provider map of model maps is readable, and an entry that carries no
  usable capacity is skipped instead of failing the refresh. A document that is
  not that shape still fails and keeps the previous snapshot.
- **BREAKING** The advertised window resolves the context tier first, then a
  manual value, then the published capacity, then 200 000. A manual value now
  outranks the third-party estimate, so a wrong published number is corrected on
  the card instead of by switching the source off for every model.
- **BREAKING** The context-tier preference is removed: the route always requests
  the largest offered tier, and the tier Cursor accepted after a rejection still
  wins while the catalog offers it. `cursor.context`, `cursor.models[].context`,
  and the stored `models[].context` no longer take part in resolution, and the
  accepted tier remembers only its value.
- The model manager shows one compact row per model — name and id, then the
  resolved window as a chip whose accessible name and tooltip carry its source —
  with a filter, a count of enabled models, and a reload of the catalog.
- A window whose source is not the provider's tier carries a pencil that turns
  the chip into a manual field; a saved override shows as manual while the
  tooltip keeps the source it replaced, and a second control returns the model
  to the automatic value.
- The manager autosaves: an enablement change writes on change, a typed window
  writes after a short pause, and a failed write reverts the row and states the
  failure there. The explicit Save and Cancel pair is removed.
- **BREAKING** The capacity source's controls move out of the card. The card
  states whether capacities are automatic and when they last refreshed; the
  refresh, the on/off switch, and the count of models falling back to the
  default live in a section of the manager, next to the windows they affect.
- The manager splits into pure derivation, presentation, and a container, and
  the source block leaves the card for its own component. The capacity decision
  record is archived with a successor that records the reversed precedence, the
  dropped tier preference, and the autosave.

## Capabilities

### New Capabilities

None. The behavior belongs to the route the project already specifies.

### Modified Capabilities

- `providers/cursor`: the published-capacity source accepts the entries it can
  read instead of rejecting the document; the advertised window resolves a
  manual value above the published capacity; the tier requirement is restated as
  a request of the largest offered tier with the reasoning-effort contract split
  out; the model manager shows the resolved window behind a manual override,
  autosaves each change, and owns the source's controls and status.

## Impact

- Code: `src/providers/cursor/published-context.ts` gains the entry-level
  tolerance; `params.ts`, `policy.ts`, `context-window.ts`, `model-rows.ts`,
  `adapter.ts`, and `runtime.ts` lose the tier preference; `cursor-settings.ts`
  drops the stored tier and narrows the accepted tier; `src/index.ts` drops the
  configuration keys and their wiring; `src/rpc/registration.ts` drops the tier
  from its two payloads; the client gains `cursor-manager-derive`,
  `CursorModelsBody`, and a capacity-source component, and `CursorCard` and
  `CursorModelsManager` shrink.
- Data: `cursor-settings.json` keeps reading a document that still carries
  `models[].context` or `acceptedTiers[].preference`; the first stops being read
  and written, and the second stops being read while still being written, so an
  older build can read the document after a rollback. No stored document needs
  conversion, and the projection's snapshot version does not move because its
  rules do not change.
- Configuration: **BREAKING** `cursor.context` and `cursor.models[].context` no
  longer select a tier. An existing profile that sets them stays valid when the
  host tolerates unknown keys; otherwise the keys stay accepted and ignored
  until the next major.
- Docs: `docs/cursor.md` (resolution order, the removed "turn the source off to
  correct a number" advice, the manager, and the limits), the Cursor bullet in
  `README.md`, `CHANGELOG.md`, and the capacity decision record.
- Network and dependencies: unchanged. The public catalog is still fetched out
  of band through the host's fetch, and no package is added.
- DSH support window and host contract: unchanged.
