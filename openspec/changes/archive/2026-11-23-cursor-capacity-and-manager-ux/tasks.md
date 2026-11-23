# Tasks

## 1. Read the public catalog instead of refusing it

- [x] 1.1 Replace `isPublishedCatalogDocument` and `isPublishedModelEntry` in
      `src/providers/cursor/published-context.ts` with a shape-only check
      (non-empty object of provider objects whose `models` is an object), and
      verify with a unit test in `test/cursor-published-context.spec.ts` that a
      document carrying `limit.context: 0` passes while a `models` field that is
      null or an array fails.
- [x] 1.2 Verify the service projects the readable entries of such a document
      and persists the snapshot, and that a wrong-shaped document still fails
      and keeps the previous one, by extending the injected-fetch tests in
      `test/cursor-published-context.spec.ts`.

## 2. Resolve the window without a tier preference

- [x] 2.1 In `src/providers/cursor/params.ts`, delete `preferredContext` and
      `DEFAULT_CURSOR_CONTEXT`, replace `contextTierValue` with
      `requestedTier(model, accepted)` (accepted tier while offered, else the
      largest), and drop the preference argument from `modelParams`; verify
      `test/cursor-params.spec.ts` covers the largest tier, an accepted tier, a
      withdrawn tier, and a model with no tier.
- [x] 2.2 Delete `contextPreferenceFor` from `src/providers/cursor/policy.ts`
      and verify `test/cursor-policy.spec.ts` covers enablement, the manual
      window, and the source switch without it.
- [x] 2.3 Reorder `resolveContextWindow` in
      `src/providers/cursor/context-window.ts` to tier, manual, published,
      default; verify `test/cursor-context-window.spec.ts` asserts a manual
      value above a published one and a tier above a manual one.
- [x] 2.4 In `src/providers/cursor-settings.ts`, drop `context` from
      `CursorModelSettings` and its validation, make `CursorAcceptedTier` accept
      a record without `preference`, and keep writing a constant `preference` so
      an older build can still read the document; verify
      `test/cursor-settings.spec.ts` reads a document that carries both legacy
      fields and reports no corruption.
- [x] 2.5 Remove the `contextPreference` dependency from
      `src/providers/cursor/adapter.ts` and `src/providers/cursor/runtime.ts`,
      resolving the tier from the catalog entry plus the accepted tier; verify
      `test/cursor-provider.spec.ts` and `test/cursor-stream.spec.ts` announce
      the largest tier, reuse the accepted one, and still step down on a
      rejection.
- [x] 2.6 Rebuild `src/providers/cursor/model-rows.ts` on the new resolution:
      drop `tierOverride` and `tierOptions`, add the override flags the manager
      needs, and keep the published value for the source sentence; verify
      `test/cursor-model-rows.spec.ts`.
- [x] 2.7 Update `test/cursor-test-helpers.ts` and every spec that passes a tier
      preference, and verify `pnpm test` compiles and passes the Cursor specs it
      touches.

## 3. Configuration, RPC, and stored state

- [x] 3.1 Confirm how the host treats a configuration key the schema no longer
      declares, by validating a profile that still sets `cursor.context` against
      the plugin config; if the key is rejected, keep it declared and ignored.
      Record the finding in the design or the verification report.
- [x] 3.2 Remove `context` from `Config.cursor` and `models[].context` from
      `Config.cursor.models` in `src/index.ts` (or mark them deprecated per
      3.1), and verify with `pnpm exec tsc` and the plugin's config tests.
- [x] 3.3 Remove `cursorContextFor` and `cursorContext` from `src/index.ts` and
      stop passing a preference to the adapter; drop `context` from `settings()`
      and the tier fields from `models()` in `src/rpc/registration.ts`; verify
      the manager mount and RPC specs pass.

## 4. The model manager

- [x] 4.1 Add `src/client/cursor-manager-derive.ts` with the row view, the
      filtered list (reusing `modelListState`), the enabled and default counts,
      the window parse and format helpers, and the source sentences; verify with
      unit tests for the filter, both counts, the parse, and every source
      sentence.
- [x] 4.2 Add `src/client/CursorModelsBody.tsx` with hook-free rows: name, id,
      window chip carrying the source in its title and accessible name, pencil,
      manual field, return-to-automatic control, and the row's failure text;
      verify component tests render a tier row, a published row, a manual row,
      and a failed write.
- [x] 4.3 Add `src/client/CursorCapacitySource.tsx` with the source state, the
      refresh, the switch, and the count of models on the default, and reduce
      `CursorCard.tsx` to one status line plus the button that opens the
      manager; verify the mount test asserts the card's line and the manager's
      two controls.
- [x] 4.4 Rewrite `CursorModelsManager.tsx` as the container: fetch, filter
      input, enabled summary, catalog reload, autosave with a 500 ms debounce on
      the typed window, revert plus a row error on a failed write, and no Save
      or Cancel; verify mount tests cover a toggle write, a debounced write, a
      failed write that reverts, and a reload that keeps the filter.
- [x] 4.5 Replace the tier and window-hint strings in `src/client/locales.ts`
      with the chip, pencil, reset, filter, summary, and source-section copy in
      `en` and `zh`; verify the locale parity assertion in
      `test/account-manager-ui.spec.ts` still covers every key.
- [x] 4.6 Delete what the new manager no longer uses (`mergedManagerState`,
      `cursorModelsPatch`, the typed-text map, the tier helpers, and the
      source-status component in `CursorCard.tsx`) and verify `pnpm lint`
      reports no unused export.

## 5. Screenshots

- [x] 5.1 Update `scripts/manual/cursor-screens.mjs` to the new module paths and
      fixture rows (tier, published, manual, default, and a failed write), run
      it, and attach the captures for review.

## 6. Docs and the decision record

- [x] 6.1 Update `docs/cursor.md`: the resolution order with the manual value
      above the published capacity, the source switch's narrowed meaning, the
      manager's rows and autosave, and the limits; remove the advice to switch
      the source off before correcting a number.
- [x] 6.2 Update the Cursor bullet in `README.md` and add the `CHANGELOG.md`
      entry; verify `pnpm format:check` and the markdown lint rules.
- [x] 6.3 Move
      `.agents/notes/implemented/provider/2026-11-21-cursor-context-capacity.md`
      to `.agents/notes/archived/provider/` and write the successor note
      recording the reversed precedence, the dropped tier preference, the
      document acceptance rule, and the autosave; verify with
      `node scripts/verify-agent-notes.mjs`.
- [x] 6.4 Add a dated verification report under `docs/` with the evidence for
      this change: the 154 unusable entries in 10 211, the refresh succeeding
      against the live endpoint, and what each tierless model now advertises.

## 7. Integration verification

- [x] 7.1 Run `pnpm format:check` and `pnpm lint` and verify both are clean.
- [x] 7.2 Run `pnpm test` and verify the full suite passes.
- [x] 7.3 Run `pnpm build` and verify the build succeeds with the client bundle
      emitted.
- [ ] 7.4 With a real account, open Settings → Subscriptions → Cursor, press
      Refresh capacities, and verify it reports a refresh time instead of a
      failure and that a model with no tier now shows the published capacity;
      record the outcome in the verification report.
