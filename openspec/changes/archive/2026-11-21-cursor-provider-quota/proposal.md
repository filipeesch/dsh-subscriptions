# Proposal

## Why

The plugin fronts five OAuth subscriptions plus the key-based Ollama Cloud
route, but Cursor — the editor this fork's maintainer uses beside DeepSeek
Harness — has no route here. Its models stay out of the picker, and the
subscription spend that Cursor reports is invisible. The standalone
`cursor-to-dsh` plugin proved the Cursor SDK route works, but it duplicates
packaging that belongs to this plugin and reports per-request tokens only.
Cursor's API does expose the plan's included usage and cycle spend; a member API
key cannot read it directly, because the API key must first be exchanged for an
access token and the request must ask for pooled usage. Without that, no quota
bar can show "used of ceiling" for Cursor.

## What Changes

- Add the `cursor` model route as a key-based route outside `PROVIDER_IDS`: live
  model catalog, request streaming, one Cursor agent per DSH session, DSH tool
  handoff, per-request usage accounting, and a credential reference. The runtime
  is ported from `cursor-to-dsh` and rebuilt around injected dependencies
  instead of module-level state.
- Add the Cursor quota reader: exchange the API key for an access token, then
  read the current period usage with pooled usage enabled. Map the response to
  percent windows or to a money window with used, limit, remaining, and the
  cycle; read the plan name and period when the endpoint discloses them; keep a
  configurable monthly ceiling for accounts whose response has no limit.
- Extend usage windows with optional monetary amounts so a display can state "$
  used of ceiling" without deriving a percentage from unrelated numbers;
  providers that report percentages keep behaving exactly as they do now.
- Add a footer quota bar for Claude, Codex, and Cursor after the context gauge:
  only the colored bar is always visible, a native tooltip carries the numbers
  on hover, and a click opens the existing usage dialog. It follows the selected
  model's account.
- Keep Cursor's inherited defaults: maximum context tier from the live catalog,
  hardcoded fallback catalog for known model ids absent from the live list, fast
  tier off, and the background prewarm.
- Refactor the provider bootstrap while adding the route: move provider
  registration and RPC assembly out of the 2,218-line `src/index.ts`, make the
  provider id list a single exported source, and keep Cursor session state
  inside a registry object.

## Capabilities

### New Capabilities

- `providers/cursor`: Cursor as a key-based model route — catalog, streaming,
  session and tool handoff, error semantics, context window, and its
  subscription quota source.
- `usage/quota-windows`: monetary usage windows beside the existing percent
  windows, percent derivation, freshness, and the no-fabricated-value rule.
- `usage/footer-quota-bar`: the footer bar for Claude, Codex, and Cursor — what
  is always visible, what hover and click reveal, the color rules, and which
  account it reflects.

### Modified Capabilities

None. The project has no published specs yet, so every capability above is new.

## Impact

- Code: new `src/providers/cursor/*`; `src/index.ts` split into provider
  registration and RPC modules; `src/providers/common.ts` usage types;
  `src/providers/external-usage*.ts` source list; client usage bar and badge;
  locale dictionaries; host-contract manifest entries.
- Dependencies: `@cursor/sdk` becomes the package's first runtime dependency
  (pinned). It is the only supported way to speak Cursor's protocol, so the
  long-standing "zero runtime dependencies" rule gains a documented exception.
- DSH support window unchanged. The Cursor route needs the host's Node runtime
  to satisfy the SDK's Node floor (the tested host ships Node 24).
- Tests: hermetic unit tests with an injected SDK gateway and a fake fetch; host
  E2E request fixtures for the new Cursor calls; component tests for the bar;
  screenshots for the Cursor card and the footer bar.
- Docs: README sections, `docs/cursor.md`, an Agent Note for the provider
  decision, and a CHANGELOG entry. Plugin version moves by a minor because a
  provider is added.
