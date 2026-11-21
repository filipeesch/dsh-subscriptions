# Agent Note: Cursor as a key-based route

Status: implemented

## Problem

Cursor publishes no OpenAI-compatible chat endpoint: its models are reachable
only through `@cursor/sdk`, which runs an agent client-side and hands tool calls
back to the caller. That makes Cursor a second kind of provider for this plugin
— not an OAuth session with a refreshable token, and not a usage-only key source
whose chat route DSH already ships. Its subscription quota is also unusual: the
API key alone is rejected by the dashboard RPCs, an exchange endpoint issues the
access token they accept, and the response shape depends on the plan (percent
buckets for a personal plan, money against a ceiling for an enterprise seat).
The plugin's stated rule was zero runtime dependencies, which the SDK ends.

## Decision

Cursor ships as the second key-based route (`cursor`), outside `PROVIDER_IDS`: a
credential reference defaults to `CURSOR_API_KEY`, the adapter registers under
`ctx.inject(['credentials'])`, and the route ships no stored catalog — it lists
what Cursor reports, hides itself without a key, and falls back to a built-in
list of known ids when the catalog read fails. Only the provider runtime is
ported from `cursor-to-dsh`; its plugin entry, config schema, and environment
variables stay behind.

`@cursor/sdk` is a pinned runtime dependency, the package's first, loaded on
first use through an injected gateway so the entry module and the test suite
never import it. `CursorRuntime` owns the session registry, the calibrated
prompt overhead, the context tier that worked after a rejection, and prewarm, so
the adapter holds no module-level mutable state and a disposer closes every
agent.

Quota comes from Cursor's own RPCs, not the web dashboard (which requires a
session cookie): `POST /auth/exchange_user_api_key` with the key as a bearer,
then `POST /aiserver.v1.DashboardService/GetCurrentPeriodUsage` with
`{ include_pooled_usage: true }` and the Connect headers. Without that flag the
server omits the usage objects; with `personal_scope: true` it zeroes the limits
— both were observed while probing, so the request is fixed to the one working
shape. An enterprise response reports `spendLimitUsage.overallLimit` and
`overallUsed` in cents across a calendar-month cycle; a personal response
reports `planUsage` percentages. `GetPlanInfo` supplies the plan name.
`UsageWindow` gained optional money fields, and the percent is derived from
amounts so every existing color and pace path keeps working. When the response
carries spend but no limit, the card's optional monthly ceiling supplies one;
without either, the reader reports the spend and leaves the share unknown rather
than inventing a percentage.

The footer bar is the only surface added to the composer: the always-visible bar
replaces the pill's numbers, the native tooltip carries the amounts or
percentages, and a click opens the existing dialog. The bar follows the selected
model's account (an account-scoped model id names one) and covers Claude, Codex,
and Cursor. The model-row label slot the host offers is absent on two supported
DSH versions, and the host-contract check requires every manifest slot on every
version, so the picker gets no bar.

## Alternatives considered

- **Add Cursor to `PROVIDER_IDS`.** Every consumer of that union — the auth
  store, refresh, pools, the multi-account UI — assumes an expiring OAuth
  session. A permanent key stored as a fake session would rot through all of
  them.
- **Ship usage only, beside `cursor-to-dsh`.** It splits one provider across two
  installs and two configuration surfaces, and the bar would describe models
  this plugin does not serve.
- **Reimplement the SDK's protocol.** The connect-RPC surface is undocumented
  and would need a full agent loop; the SDK is the supported route.
- **Optional peer or on-demand download for the SDK.** A peer hides the route
  behind a step users cannot discover; a download breaks offline installs and
  the hermetic test rule.
- **Keep the port's module-level state.** It survives test boundaries, cannot
  reset between configurations, and makes behavior depend on load order.
- **Derive the ceiling as spend divided by the reported percent.** Wrong once
  bonus usage exists, and one bad reading becomes a permanently wrong ceiling.
- **Read quota from the web dashboard with the exchanged token.** It answers 401
  without a session cookie, so the RPCs are the only reachable source.
- **Register the model-label slot and narrow the support window.** The slot is
  missing before DSH 0.2.1 and the contract check covers the whole window;
  dropping versions for a display feature is a policy change, not a fix.

## Consequences

One new dependency, one provider-specific adapter and quota module, and a second
key-based route to keep working. Cursor's quota RPCs are not a published
contract, so a shape change fails the usage read and leaves chat untouched; the
reader is one module with contract tests. Session state is per process, so a
restart pays one cold Cursor setup (the prewarm hides most of it). The route
serves one credential: multiple Cursor accounts, pooling, and the Fast tier are
out of scope. In exchange the picker gains Cursor's models, the footer states
how much of the subscription is spent (money for an enterprise seat, a share for
a personal plan), and the settings card shows the plan and spend.
