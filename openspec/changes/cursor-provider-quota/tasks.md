# Tasks

## 1. Provider bootstrap split

- [x] 1.1 Move the per-provider construction switch out of `src/index.ts` into
      `src/providers/registration.ts`, exporting one builder per provider that
      returns the adapter, its usage fetcher, and its registration handle; keep
      `src/index.ts` behavior identical and verify `pnpm build && pnpm test`
      passes.
- [x] 1.2 Move the RPC controller assembly out of `src/index.ts` into
      `src/rpc/registration.ts`, passing the same collaborators in; verify the
      package entry's exported names are unchanged and `pnpm test` passes.
- [x] 1.3 Introduce `src/providers/ids.ts` as the single provider id source and
      make `auth/store.ts`, `auth/rpc.ts`, `provider-settings.ts`, and the
      client unions consume it; verify `pnpm build`, `pnpm test`, and
      `node scripts/check-host-exports.mjs --all` pass.
- [x] 1.4 Extract the key-route registration shared by Ollama Cloud and Cursor
      into `src/providers/key-route.ts` and move Ollama onto it; verify the
      Ollama specs and `bash scripts/host-e2e.sh` still pass.

## 2. Cursor provider runtime

- [x] 2.1 Add `@cursor/sdk` to `dependencies`, pinned to the newest published
      version whose agent create/send/stream/usage API matches the port, and
      install it; verify `pnpm install --frozen-lockfile`, `pnpm build`, and
      `pnpm test` pass with the lockfile updated.
- [x] 2.2 Add `src/providers/cursor/models.ts` mapping the live catalog to model
      info and reasoning efforts, resolving the largest offered context tier by
      default, and carrying the hardcoded fallback catalog; verify unit tests
      cover name disambiguation, effort mapping, and the fallback.
- [x] 2.3 Add `src/providers/cursor/transcript.ts`, `prompt.ts`, and `reply.ts`
      porting request reading, transcript rendering, fingerprints, token
      estimates, and the stream-chunk terminal contract; verify unit tests cover
      the image note, argument parsing, and the estimate.
- [x] 2.4 Add `src/providers/cursor/runtime.ts` owning the session registry, the
      incremental/rebuild decision, tool-result handoff, context-tier retry,
      overhead calibration, prewarm, idle close, and the disposal hook; verify
      unit tests with a fake gateway cover incremental send, divergence,
      auxiliary isolation, tier fallback, and close-all.
- [x] 2.5 Add `src/providers/cursor/adapter.ts` implementing model listing,
      model resolution, streaming, image loading through the host attachment
      store, disjoint usage buckets, and error codes outside the host's retry
      set; verify integration tests through `stream()` cover text, thinking,
      tool use, error, and cancellation.
- [x] 2.6 Add `src/providers/cursor/sdk.ts` as the gateway around
      `Agent.create`, `Agent.delete`, `Cursor.models.list`, and the platform
      ripgrep path, imported only on demand; verify tests never import it and a
      missing SDK surfaces a load error instead of a crash.

## 3. Cursor route wiring, settings, and card

- [x] 3.1 Add the `cursor` config block (`apiKeyRef` defaulting to
      `CURSOR_API_KEY`, context preference, working directory) to the config
      schema and resolve the key through `ctx.credentials`; verify the route
      stays empty without a key and serves models with one.
- [x] 3.2 Add `src/providers/cursor-settings.ts` persisting the optional monthly
      ceiling in US dollars under the DSH home with atomic writes and
      validation; verify unit tests cover a valid save, an invalid value, and a
      corrupt file.
- [x] 3.3 Register `cursor` as an external usage source and expose the Cursor
      settings through the RPC channel; verify `pnpm test` covers the status,
      usage, and settings endpoints.
- [x] 3.4 Add the Cursor card to Settings → Subscriptions showing connection
      state, the credential reference, the model count, the usage rows with
      money or percentage, the cycle, and the monthly ceiling field; verify
      component tests cover connected, disconnected, money, percent, and error
      states.

## 4. Quota data model

- [x] 4.1 Extend `UsageWindow` with `usedAmount`, `limitAmount`,
      `remainingAmount`, and `currency`, deriving `usedPercent` when a limit is
      positive and omitting invalid amounts; verify unit tests cover derivation,
      amounts without a limit, and invalid values.
- [x] 4.2 Add `src/providers/cursor/quota.ts` performing the API-key exchange,
      the pooled period read, the money/percent mapping, and the plan-info read,
      with the configured ceiling fallback; verify fixtures cover the enterprise
      money window, personal percentages, no limit, fallback ceiling, and a
      failed refresh marking the reading stale.
- [x] 4.3 Add a money formatting helper used by the card, the dialog, and the
      tooltip that formats cents with the host locale and the window currency;
      verify unit tests cover whole amounts, decimals, and an absent currency.

## 5. Footer quota bar

- [x] 5.1 Add a shared cached usage loader for the bar keyed by provider and
      account, refreshed by the existing usage refresh event, so rendering rows
      never issues per-row requests; verify unit tests cover caching, a failed
      refresh, and refresh invalidation.
- [x] 5.2 Add the quota bar to the composer stats row after the context gauge
      for Claude, Codex, and Cursor only, resolving the selected model's account
      from an account-scoped model id and falling back to the provider default;
      verify component tests cover placement, account selection, and absent
      providers.
- [x] 5.3 Implement the always-visible bar with no persistent numbers, a native
      tooltip carrying used/remaining or amount/ceiling/remaining plus the reset
      time, and a click that opens the existing usage dialog; verify component
      tests cover each tooltip shape, a missing reset time, and the click path.
- [x] 5.4 Apply the existing quota colors and the used-or-remaining preference
      to the bar and its tooltip, keeping stale readings colored and labeled;
      verify component tests cover the red threshold, the pace lead, and the
      stale label.

## 6. Evidence and docs

- [x] 6.1 Plan the Cursor requests in `scripts/host-e2e-fixture.mjs` and add the
      host-contract entries the new client code reads; verify
      `node scripts/check-host-contract.mjs --all` and
      `bash scripts/host-e2e.sh` pass.
- [x] 6.2 Write the Agent Note recording the key-route decision, the runtime
      dependency exception, the quota endpoints, and the session model; verify
      `node scripts/verify-agent-notes.mjs` passes.
- [x] 6.3 Write `docs/cursor.md`, the README sections for the route and the bar,
      and the CHANGELOG entry; verify `node scripts/check-compat-docs.mjs`,
      `node scripts/check-markdown-tables.mjs`, and `pnpm format:check` pass.
- [x] 6.4 Capture the Cursor card and footer bar screenshots from the real
      components (headless Chrome) into the gitignored `.cache/cursor-screens/`
      directory for the reviewer; committing them to `docs/assets/` is deferred
      to the review outcome.
- [x] 6.5 Bump the plugin version to the next minor in `package.json` and state
      the new provider in the release notes draft; verify
      `node scripts/render-release-compat.mjs` still renders the compatibility
      section.
- [x] 6.6 Run the full local gate: `pnpm build`, `pnpm test`, `pnpm lint`,
      `pnpm format:check`, `node scripts/check-host-exports.mjs --all`,
      `node scripts/check-host-contract.mjs --all`, and
      `bash scripts/boot-smoke.sh` with `PLUGIN_SOURCE` set to the packed
      tarball; record each result.
