# Proposal

## Why

The Cursor route advertises, for any model whose catalog entry carries no
`context` parameter, the generic 200 000-token fallback. Cursor lists models
that way (for example `deepseek-v41-flash-1017`, whose real window is 1 048 576
tokens), so DSH meters less than a fifth of the capacity it actually has: the
host's pressure threshold lands near 134 000 tokens and a model switch triggers
compaction that the provider would never have required. In the reported case
compaction summarized through the previously answered route, that route had no
balance, and the switch failed with `402` instead of starting the turn.

The capacity exists upstream: the public models.dev catalog publishes it, and
the standalone `cursor-to-dsh` plugin already projected it onto the Cursor
catalog and persisted the projection. The route also forgets the context tier
Cursor accepted after a rejection, so after a legitimate step-down it keeps
advertising the rejected (larger) tier. This change closes both gaps and makes
the catalog and its capacity metadata survive a restart.

## What Changes

- Resolve the advertised context window by precedence: the effective requested
  tier, then the capacity the public catalog publishes, then a manual per-model
  value, then the 200 000 default. The value is what DSH meters and compacts
  against.
- Fetch the published capacities out of band from models.dev, project them onto
  the model ids Cursor lists, persist the projection, and refresh it on load and
  after 24 hours. A request never waits for the network, and a failed refresh
  keeps the previous snapshot.
- Persist the Cursor catalog under the DSH home, seed the route from it at load,
  use it when a live discovery fails, and only advertise models while the
  credential resolves. The projection has ids to work with on the first request
  after a restart.
- Persist the context tier Cursor accepted per model after a rejection, keep it
  only while the catalog still offers it and the preference still matches, and
  advertise that tier instead of the rejected preference.
- Add per-model settings — enabled, context tier, and manual window — edited
  from the Cursor card's Manage dialog and stored beside the route's other
  settings, with the plugin configuration as a baseline. Settings win per field
  over configuration, and configuration wins over the catalog.
- Add the published-capacity source's state to the card: whether it is on, when
  it last refreshed, and a control to refresh it now.
- Refactors that keep the new code out of the adapter: a shared atomic JSON
  helper, a split of `src/providers/cursor/models.ts` into catalog, parameters,
  and resolution modules, and a generic `ModelCatalogCache` reused by the Cursor
  route instead of a second private cache.

## Capabilities

### New Capabilities

None. The behavior belongs to the route the project already specifies.

### Modified Capabilities

- `providers/cursor`: the catalog becomes durable and credential-gated, the
  advertised context window resolves from the effective tier, the published
  capacity, and a manual value, the accepted tier is remembered and announced,
  and the route gains per-model settings with a configuration baseline.

## Impact

- Code: `src/providers/cursor/` gains catalog, catalog-cache, parameters,
  context-window, and published-context modules; `cursor-settings.ts` gains
  per-model settings and accepted tiers; `adapter.ts` and `runtime.ts` consume
  the resolved tier; `src/index.ts` wires the source; the RPC surface and the
  Cursor card gain model settings and source status; a shared JSON helper lands
  in `src/json-file.ts`.
- Data: two new documents under `~/.dsh/plugins/subscriptions/`
  (`cursor-catalog.json` and `cursor-context-windows.json`) plus the extended
  `cursor-settings.json`.
- Network: the route reads `https://models.dev/api.json` through the host fetch,
  on the same out-of-band terms as the catalog; no new dependency.
- DSH support window unchanged; no host contract changes.
- Tests: hermetic unit tests for the projection, resolution, both stores, the
  accepted tier, and the dialog; the Cursor adapter and runtime specs gain the
  new announcements.
- Docs: `docs/cursor.md` states the resolution order, the network source, the
  stored files, and the new settings; the route's spec delta is archived with
  the change.
