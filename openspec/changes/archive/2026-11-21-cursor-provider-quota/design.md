# Design

## Context

See `proposal.md` for the motivation and `specs/` for the behavior contract.

The current provider bootstrap compiles five OAuth providers from `PROVIDER_IDS`
plus one key-based route (`ollama-cloud`) that sits outside that union, and a
small set of usage-only sources behind
`src/providers/external-usage-controller.ts`. `src/index.ts` holds the config
schema, catalog resolution, account plumbing, the per-provider registration
switch, the RPC controller, speed, model defaults, the Ollama route, and the
tools, at 2,218 lines.

`cursor-to-dsh` (separate repository, `@cursor/sdk` 1.0.37) already implements
the Cursor conversation: one agent per DSH session, tool calls handed back to
DSH, the full transcript on a fresh agent, and per-run usage. It keeps its state
in module-level maps, reads environment variables directly, and ships its own
plugin entry, config schema, and install docs. Only the provider runtime is in
scope here.

Cursor's usage endpoints are not documented. Probes against a live enterprise
account established the working recipe:

- `POST https://api2.cursor.sh/auth/exchange_user_api_key` with the API key as a
  bearer returns an access token.
- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
  with `connect-protocol-version: 1` and `x-cursor-client-type: cli` returns the
  cycle, percent buckets, and spend limits, but only when the request carries
  `include_pooled_usage: true`. Without the flag the server omits both usage
  objects; with `personal_scope: true` it returns zeroed limits.
- On the probed account the response reported `overallLimit: 250000`,
  `overallUsed: 53713`, `overallRemaining: 196287` (cents) over a calendar-month
  cycle, matching the dashboard's "$537.13 of $2,500".
- Team- and org-scoped endpoints answer 401 for a non-admin member, and the web
  dashboard requires a session cookie the plugin does not have.

## Goals / Non-Goals

**Goals:**

- One provider runtime that owns Cursor chat, catalog, quota, and failures.
- A usage-data contract that can express both a percentage and an amount against
  a ceiling, without changing how percent-only providers behave.
- A footer bar that a reader understands at a glance and that never shows a
  number it cannot source.
- A provider bootstrap that a sixth route and a second key-based route do not
  make worse.

**Non-Goals:**

- Retiring or modifying the `cursor-to-dsh` repository; it stays a standalone
  plugin for users who do not install this one.
- Multiple Cursor keys, account pooling, or failover. The route serves one
  credential reference.
- Cursor tools (file edit, shell) inside DSH, Cursor Fast tier, or a Speed
  toggle for Cursor models.
- Reading team-wide or organization-wide Cursor spend.
- A model-row quota label; the host slot that would carry it does not exist on
  every supported DSH version (see Decisions).

## Decisions

### 1. Cursor is a key-based route outside `PROVIDER_IDS`

Cursor joins the shape `ollama-cloud` already established: a route id
(`cursor`), a credential reference read through `ctx.credentials`, a
registration inside the `credentials` injection, and a settings card.

Alternatives rejected:

- **Add `cursor` to `PROVIDER_IDS`.** That union feeds `auth.json`, token
  refresh, pool selection, and the multi-account UI; every one of those assumes
  an expiring OAuth session with a refresh token. A permanent key stored as a
  fake session would leak into all of them.
- **Usage-only source beside the existing `cursor-to-dsh` plugin.** It splits
  one provider across two installs and two configuration surfaces, and the quota
  bar would describe models the plugin does not serve.
- **Multi-account now.** The quota display only needs the selected model's
  account, and the maintenance cost of a key-shaped account type in the account
  machinery is not justified by a single credential.

The route registers unconditionally and hides its catalog until the reference
resolves, matching how the Ollama route behaves when its key is absent.

### 2. `@cursor/sdk` becomes the first runtime dependency

The SDK is the only supported way to speak Cursor's protocol; reimplementing its
connect-RPC streaming is not maintainable. It is pinned in `dependencies`,
imported lazily, and reached through an injected gateway so no test ever loads
it.

Alternatives rejected:

- **Optional peer installed by the user.** It keeps the install lean but hides
  the route behind an extra step most users cannot discover.
- **Runtime download of the SDK.** Breaks offline installs and the hermetic test
  rule.
- **Reimplement the protocol.** Large, undocumented, and the first thing to
  break.

The Agent Note that states "this package keeps zero runtime dependencies" gets
an explicit exception and its reason.

### 3. One runtime object owns Cursor state

A `CursorRuntime` instance owns the session registry, the calibrated prompt
overhead per model, remembered context tiers, and the prewarm promise. The
adapter receives it, plus a gateway for `Agent.create`, `Agent.delete`,
`Cursor.models.list`, and the attachment reader. Module-level maps from
`cursor-to-dsh` disappear.

Alternatives rejected:

- **Keep module-level state.** It survives test boundaries, cannot be reset
  between configurations, and makes the adapter's behavior depend on load order.
- **No session reuse: one agent per request.** Correct but pays a fresh Cursor
  setup on every call and loses prompt-cache reuse.

A `ctx.effect` disposer closes every agent on unload; idle timers are unref'd
and the registry caps sessions per key.

### 4. Quota comes from the exchange plus the pooled period read

The reader performs the exchange, then `GetCurrentPeriodUsage` with
`{ include_pooled_usage: true }`. It maps, in order:

1. `spendLimitUsage.overallLimit > 0` → one money window
   (`usedAmount`/`limitAmount`/`remainingAmount`, cycle as start and reset).
2. `planUsage` percent buckets with a nonzero limit → one window per bucket
   (overall, Cursor models, other models) with the amounts when disclosed.
3. `GetPlanInfo` → plan name and whether the included period is monthly or
   weekly; used only to label and to place the reset, never to compute spend.
4. A configured monthly ceiling, when the response carries spend but no limit.

A reading is cached with an observation time and marked stale on a failed
refresh, reusing the semantics every other usage fetcher already has.

Alternatives rejected:

- **Derive the ceiling as spend ÷ percent.** Wrong whenever bonus usage is in
  play, and it turns one bad reading into a permanently wrong ceiling.
- **Recompute spend from the usage-events endpoint.** A cycle held 1,901 events
  and the endpoint pages 1,000 at a time; the account-wide sum is useful for a
  diagnostic, not for every card refresh, and the period read already reports
  the same money.
- **Read the web dashboard endpoints.** They require a session cookie; a bearer
  token answers 401.

### 5. Money lives on the existing usage window

`UsageWindow` gains optional `usedAmount`, `limitAmount`, `remainingAmount`, and
`currency`; `usedPercent` stays the single input for fill, color, and pace. A
money window derives its percentage as `usedAmount / limitAmount` when the limit
is positive.

Alternatives rejected:

- **A parallel `SpendWindow` type.** Every meter, badge, dialog, and tooltip
  would need a second code path.
- **Format money as an opaque `scope` string.** It cannot feed the bar or the
  color rules.

### 6. The bar lives in the footer, not beside model names

The host exposes `conversation.input.model.label` for inline model labels, but
that slot is absent on `0.1.7-rc.2` and `0.2.0-rc.2`, and the host-contract
check requires every slot in the manifest to exist on every version in the
support window. The composer's stats row already hosts the usage pill through a
documented anchor and is available across the window, so the bar replaces the
pill's numbers there and sits after the context gauge.

Alternatives rejected:

- **Register the label slot as optional in the contract.** It changes the
  contract checker to serve one feature and still leaves the bar missing on two
  supported versions.
- **Narrow the support window.** A policy change for a display feature.
- **A custom popover on hover.** The stats row entry is a host-rendered pill; a
  native `title` and the existing dialog's click path need no new host surface.

The bar resolves its account from the selected model id when it names one
(`__account:<account>:<model>`) and falls back to the provider's default
account. A shared, cached loader reads usage per provider/account so rendering
rows never fans out into per-row RPCs.

### 7. Split the provider bootstrap

`src/index.ts` keeps `apply()` and the config schema; provider construction
moves to a `providers/registration.ts` (one builder per provider, the
per-provider switch gone), the RPC controller assembly moves to
`rpc/registration.ts`, and both key-based routes (Ollama Cloud and Cursor) share
a `providers/key-route.ts` helper. The provider id list becomes one exported
tuple consumed by the store, the RPC, and the client.

Alternatives rejected:

- **Leave `index.ts` as it is.** Adding Cursor and a second key route to a
  2,218-line function makes the file worse at the moment it grows.
- **Rewrite the bootstrap wholesale.** Too much risk for a change that must also
  prove a new provider.

The split is mechanical: move code, keep exports, run the suite between moves.
Public exports from the package entry stay identical.

### 8. Testing follows the existing layers

- Unit tests inject a fake Cursor gateway and a fake fetch; the suite's network
  guard never sees the SDK.
- Quota fixtures cover the enterprise money window, personal percent windows, a
  response with no limit, a configured fallback ceiling, and a failed refresh.
- Component tests cover the bar's placement, tooltip content, click path, color
  thresholds, stale label, and account selection.
- Host E2E plans the Cursor requests in its fixture and asserts the bar renders
  in the stats row.
- Screenshots for the Cursor card and the footer bar join `screenshots.json`.

## Risks / Trade-offs

- **Undocumented Cursor RPCs change without notice** → the quota reader is one
  module with contract tests and a fixed, user-facing "usage unavailable"
  message on shape drift; a failure never blocks chat.
- **The SDK's platform packages or bundled ripgrep are missing after install** →
  the route reports a clear load error instead of crashing the host; the boot
  smoke and host E2E install the packed tarball and cover it.
- **Agent leakage across sessions** → a registry with a per-key cap, unref'd
  idle timers, disposal on unload, and tests asserting the count returns to
  zero.
- **The split of `index.ts` introduces regressions in unrelated providers** →
  mechanical moves in separate commits, the full suite and host E2E between
  them, and no public export changes.
- **The account-level ceiling stays invisible for some enterprise accounts** →
  the card exposes a monthly ceiling the user can set; the bar then shows the
  spend against it, and without one it shows spend only.
- **Money formatting differs by locale** → the UI formats with the host's locale
  and the window's currency; the data layer stores cents as integers.
- **A second runtime dependency changes install behavior** → documented in the
  README and the Agent Note; no peer range moves, so the support window is
  unchanged.

## Migration Plan

No user data or configuration migrates. Existing installs keep every route and
setting; the Cursor card appears only when the plugin is updated, and it stays
inactive until `CURSOR_API_KEY` resolves. Rollback is deleting the route
registration and the dependency; stored quotas are not persisted. Plugin version
moves by a minor (new provider), and `docs/compatibility.md` gains no window
change.

## Open Questions

- The exact `@cursor/sdk` version to pin is settled during apply by checking the
  newest published version whose agent/streaming API matches what the runtime
  uses; `cursor-to-dsh` pins 1.0.37 and 1.4.2 exists.
- Whether the Cursor card should also show active usage grants (promo credits)
  and their remaining amounts is deferred; the endpoint reports them, but it is
  display-only and does not affect the bar.
