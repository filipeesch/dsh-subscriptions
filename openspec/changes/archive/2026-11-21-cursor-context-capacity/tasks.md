# Tasks

## 1. Foundations and refactors

- [x] 1.1 Add `src/json-file.ts` with a tolerant read and serialized atomic
      writes (temp file, rename with the Windows share-mode retry), and unit
      tests for a fresh write, an overwrite, two writes in call order, an
      unreadable document, and the retry path.
- [x] 1.2 Move `cursor-settings.ts` and `providers/catalog-store.ts` onto the
      shared helper without changing their stored shapes, and verify `pnpm test`
      and `pnpm lint` pass.
- [x] 1.3 Split `src/providers/cursor/models.ts` into `catalog.ts` (types,
      parsing, names, built-in list), `params.ts` (effort and tier mapping), and
      `context-window.ts` (resolution); update the adapter's imports and verify
      the existing Cursor specs pass unchanged.
- [x] 1.4 Generalize `ModelCatalogCache` and its snapshot/persistence types as
      `ModelCatalogCache<T = DiscoveredModel>` with no behavior change, and
      verify the five OAuth provider specs and `pnpm test` pass.
- [x] 1.5 Rewrite `test/cursor-models.spec.ts` as the three module specs,
      preserving every existing assertion, and verify `pnpm test` passes.

## 2. Window resolution

- [x] 2.1 Implement `resolveContextWindow` in `context-window.ts` returning the
      token count and its source (`tier`, `published`, `manual`, `default`) in
      that order, and unit-test each source, an invalid or zero manual value,
      and an absent catalog entry (default 200 000).
- [x] 2.2 Implement effective-tier selection in `params.ts` from the accepted
      tier and the configured preference, and unit-test the largest default, an
      exact tier, `min`, and a value the catalog no longer offers.

## 3. Published capacities

- [x] 3.1 Implement the projection helpers (`normalizeModelKey`, `lastSegment`,
      `vendorOf`, `publishedEntries`, `projectWindows`) and unit-test
      normalization, last-segment matching, vendor preference, most-declared
      values, tie-breaking, non-listed ids, and malformed documents.
- [x] 3.2 Add `published-context.ts` with the injectable fetch, the 20-second
      timeout, the 64 MiB cap, the versioned snapshot, single-flight refresh,
      `windowFor`, `fetchedAt`, `stale`, `note`, and `refresh`; unit-test
      success, malformed document, version mismatch, timeout, oversized body, a
      failed refresh keeping the previous snapshot, a disabled source, and two
      concurrent notes.
- [x] 3.3 Add the projection store (`cursor-context-windows.json`) on the shared
      helper with strict validation, and unit-test a valid round trip, a missing
      file, corrupt fields, and a version mismatch.
- [x] 3.4 Wire the source in `src/index.ts` with `hostFetch`, the persisted
      snapshot, the settings toggle, and ids fed after every catalog read;
      integration-test through the adapter with an injected fetch that a no-tier
      model advertises the published capacity while no request awaits the fetch.

## 4. Durable catalog

- [x] 4.1 Add the Cursor catalog store (`cursor-catalog.json`) validating the
      document version, timestamp, and every catalog model, and unit-test a
      valid round trip, corrupt fields, an empty document, and a version
      mismatch.
- [x] 4.2 Move the adapter onto `ModelCatalogCache<CursorCatalogModel>` with the
      Cursor persistence, seeding at construction, write-through after a live
      read, stale-while-revalidate in `resolveModel`, the fallback order live →
      persisted → built-in list, and the credential gate; update the disposal
      tests and cover restart, discovery failure, and key missing.

## 5. Settings, accepted tier, and configuration baseline

- [x] 5.1 Extend `cursor-settings.ts` with `models`, `acceptedTiers`, and
      `publishedContext`, preserving the ceiling-only document; unit-test each
      field, invalid values, an unreadable document, and two serialized writes.
- [x] 5.2 Replace the runtime's in-memory accepted-tier map with the
      settings-backed accessors: write after a successful step-down, read while
      the catalog offers the value and the preference matches, and drop a
      withdrawn or mismatched value; cover each path in the runtime spec.
- [x] 5.3 Make the adapter announce the effective tier and its capacity after a
      step-down and after a restart; adapter-test the rejection path, the
      restarted accepted tier, and a withdrawn tier.
- [x] 5.4 Add the `cursor.contextWindows` and `cursor.models` configuration
      baseline with validation, resolve per field as settings over
      configuration, and unit-test both sources plus invalid entries.
- [x] 5.5 Apply enablement in `listModels` while `resolveModel` still resolves a
      disabled model, and test the picker filter and the saved-conversation
      path.

## 6. RPC and card

- [x] 6.1 Add `cursorModels`, `cursorSetSettings`, and `cursorRefreshContext` to
      `auth/rpc.ts` and `rpc/registration.ts`, building rows from the adapter's
      cached catalog with the resolved window and source; cover the row shape,
      validation refusals, and refresh status in `test/rpc.spec.ts`.
- [x] 6.2 Update `CursorCard` with the published source's state (on/off, last
      refresh, refresh now) and a **Manage** button; component-test the on, off,
      never-refreshed, and both failed-refresh states (retained and no cache),
      and mount the card in jsdom to open the dialog and observe a failed
      refresh (`test/cursor-manager-mount.spec.ts`).
- [x] 6.3 Add `CursorModelsManager.tsx` following the Ollama manager: one row
      per model with enable, tier, manual window with the resolved value and a
      source tooltip, a catalog reload, and explicit Save/Cancel; component-test
      each control, an invalid window, a saved change, and a failed save keeping
      the edits, and mount the dialog in jsdom to exercise tier inheritance over
      stored and YAML values, a failed Save keeping the edits, and a failed
      Reload keeping the rows.
- [x] 6.4 Add every new label, hint, and error to both dictionaries in
      `src/client/locales.ts` (the `en`/`zh` pair; `locale/*.json` holds only
      the package metadata), and verify both dictionaries carry the same keys
      and `pnpm test` passes.
- [x] 6.5 Capture the Cursor card's source status (on, off, failed refresh) and
      the manager's rows (editable, tiered, published, withdrawn tier) in
      English and Chinese at desktop and narrow widths from the shipped
      components against fixture data, into the gitignored
      `.cache/cursor-screens/` directory. The captures stay review-only until
      the screenshots manifest selects one.

## 7. Docs, evidence, and release

- [x] 7.1 Update `docs/cursor.md` with the resolution order, the models.dev
      source and its toggle, the stored files, the per-model settings, and the
      consequence that DSH prices compaction from the advertised window; verify
      `node scripts/check-compat-docs.mjs`,
      `node scripts/check-markdown-tables.mjs`, and `pnpm format:check`.
- [x] 7.2 Write the Agent Note for the published-capacity decision, its
      alternatives, and the projection rule; verify
      `node scripts/verify-agent-notes.mjs`.
- [x] 7.3 Plan the `GET https://models.dev/api.json` request in
      `scripts/host-e2e-fixture.mjs` (or disable the source in the E2E profile),
      and verify `bash scripts/host-e2e.sh` passes.
- [x] 7.4 Add the CHANGELOG entry and bump the plugin version by a minor; verify
      `node scripts/render-release-compat.mjs` and
      `node scripts/check-compat-docs.mjs` pass.
- [x] 7.5 Run the full gate: `pnpm build`, `pnpm test`, `pnpm lint`,
      `pnpm format:check`, `node scripts/check-host-exports.mjs --all`,
      `node scripts/check-host-contract.mjs --all`, `bash scripts/host-e2e.sh`,
      and `bash scripts/boot-smoke.sh` with `PLUGIN_SOURCE` set to the packed
      tarball; record each result.

## Verification record (7.5)

Recorded on 2026-11-21 in the worktree `cursor-model-low-context` (Node
`v24.21.0`, DSH `0.2.2-rc.5`):

- `pnpm build`: pass.
- `pnpm test`: 1,355 tests, 1,354 passed, 1 skipped, 0 failed, including the
  mounted card/dialog tests (`test/cursor-manager-mount.spec.ts`).
- `pnpm lint`: pass; `pnpm format:check`: pass.
- `openspec validate cursor-context-capacity --strict`: valid.
- `node scripts/verify-agent-notes.mjs`, `node scripts/check-compat-docs.mjs`,
  `node scripts/check-markdown-tables.mjs`,
  `node scripts/render-release-compat.mjs`: pass.
- `node scripts/check-host-exports.mjs --all`: pass for all four versions in the
  window; `node scripts/check-host-contract.mjs --all`: pass (21 entries).
- `bash scripts/boot-smoke.sh` with the packed 0.5.0 tarball: pass.
- `bash scripts/host-e2e.sh`: pass.

Environment notes for those commands: the corporate npm registry does not mirror
every `@deepseek-ai` transitive package for `0.2.2-rc.5`, so the host checks and
the host E2E ran with `npm_config_registry=https://registry.npmjs.org`; the host
E2E is written against English/Chinese host labels while this machine's OS
locale is Portuguese, so it ran with `CHROME_BIN` set and a temporary
`locale.preference: en` patch (the tracked harness was not modified). The host
runs cover plugin boot, the settings surface, and the Cursor route's boot path;
they do not open the model manager dialog. The review stills in
`.cache/cursor-screens/` render the shipped presentational components against
fixture data (English and Chinese, desktop and narrow, retained and no-cache
refresh failures); the mounted jsdom tests cover dialog interaction, not the
real browser's focus trapping or scrolling.
