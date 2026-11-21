# Cursor

Cursor joins the plugin as a key-based model route: `cursor`. DSH keeps the
agent loop, tools, and permissions; Cursor provides the model through the
official `@cursor/sdk` and the account's own API key. The route needs no OAuth
login and keeps no `auth.json` entry.

## What it adds

- Cursor's live model catalog in DSH's picker, with each model's advertised
  reasoning efforts. The largest offered context tier is the default. The
  catalog is stored under the DSH home, so it survives a restart and a failed
  discovery. When neither a live read nor a stored catalog is available, the
  picker falls back to a built-in list of known ids as a whole; it is not merged
  into a successful catalog.
- One Cursor agent per DSH conversation. Tool calls run in DSH, and the result
  returns to the same Cursor run; tool changes mid-conversation restart the run
  with the current tools.
- Cursor's subscription quota in **Settings → Subscriptions**, the footer quota
  bar, and the usage dialog.
- A **Manage models** dialog on the Cursor card: enablement, the requested
  context tier, and a manual window for models nothing else describes.

## Prerequisite

A Cursor API key from [cursor.com/dashboard](https://cursor.com/dashboard) →
**API Keys** (a personal or service-account key; a team admin key is not
supported), stored in DSH credentials under the reference the route reads.
`CURSOR_API_KEY` is the default; the reference is configurable.

The host's Node runtime must satisfy the SDK's Node floor (the versions in
[compatibility.md](compatibility.md) ship Node 24). The route registers even
when the key is absent: without a key it lists no models and reports a
missing-credential error on use.

## Configuration

```yaml
- id: llm-cursor
  name: dsh-subscriptions
  config:
    cursor:
      apiKeyRef: CURSOR_API_KEY
      context: max
      contextWindows:
        composer-2.5: 200000
      models:
        grok-4.7:
          context: 500k
        auto-smart:
          enabled: false
      publishedContext: true
```

| Option             | Default               | Meaning                                                               |
| ------------------ | --------------------- | --------------------------------------------------------------------- |
| `apiKeyRef`        | `CURSOR_API_KEY`      | DSH credential reference holding the key                              |
| `context`          | `max`                 | Route-wide tier: `max` (the largest offered), `min`, or an exact tier |
| `cwd`              | the session directory | Working directory for Cursor agents                                   |
| `contextWindows`   | none                  | Manual advertised window per model, in tokens                         |
| `models`           | none                  | Per-model baseline: `enabled` and `context`                           |
| `publishedContext` | `true`                | Whether the route may read published capacities from models.dev       |

A rejected context tier is retried once with the next smaller offered tier and
remembered for later runs, across restarts. Cursor's Fast tier stays off, so
pricing and latency are the standard ones.

## Context windows

DSH meters the window the route advertises: compaction pricing uses it, so a
window smaller than the provider applies forces premature compaction and a
larger one lets a request overflow. The route resolves it in this order:

1. the capacity of the context tier the request carries (the tier Cursor
   accepted after a rejection wins while the catalog still offers it);
2. the capacity the public [models.dev](https://models.dev) catalog publishes
   for the model;
3. a manual value for the model;
4. 200 000 tokens.

Models Cursor lists without a context tier, such as `deepseek-v41-flash-1017`,
reach step 2 and advertise the capacity the public catalog states. That number
is a third-party estimate, not a provider guarantee. The public catalog is
fetched out of band (on start and when the stored projection is older than 24
hours, through the host's proxy, with a 20-second timeout and a response cap),
projected onto the ids Cursor currently lists, and stored in
`~/.dsh/plugins/subscriptions/cursor-context-windows.json`. A withdrawn id stops
being served immediately, a failed refresh keeps the previous projection, and no
request waits for the network. A refresh the card starts reports whether it
succeeded, failed, or could not run.

Turn the source off on the card, or with `publishedContext: false`, and step 2
is skipped entirely: a stored projection is not served while the source is off.
That is also how a wrong published number is corrected — switch the source off,
then enter the manual value, because step 2 outranks step 3. A remembered tier
is dropped when the catalog stops offering it or the tier preference changes, so
it cannot come back by switching the preference back.

The model catalog is stored beside it in `cursor-catalog.json`, and the
per-model settings, remembered tiers, and the source switch live in
`cursor-settings.json`. Settings win over the configuration for the same field.
The **Manage models** dialog states each model's resolved window and where it
came from; a model whose window comes from its tier or the public catalog is
shown as read-only there. Enabling or disabling a model changes the picker only;
a saved conversation keeps working.

The advertised window matters beyond display: it is the budget DSH's compaction
charges against, and a model switch compacts through the route that last
answered. If a conversation genuinely outgrows the window, give that
summarization route quota (or configure the host's compaction model) rather than
relying on a larger advertised window.

## Quota

The card reads Cursor's current period usage with the same API key. What it
shows depends on the plan:

- A **personal plan** reports percentages by model bucket (Cursor models, other
  models, overall) with the plan's weekly or monthly reset.
- An **enterprise seat** reports money: the amount spent against the seat's
  included-usage ceiling, plus what remains, across the billing cycle Cursor
  reports (a calendar month on the probed account).

When Cursor reports spend without a ceiling, the card's **Monthly ceiling
(US$)** field supplies one; with neither, the card states the spend only. A
failed read keeps the previous numbers marked stale. Cursor's dashboard
endpoints are not a published contract, so a shape change shows "usage lookup
failed" and leaves chat working.

The footer bar covers Claude, Codex, and Cursor: only the colored bar is always
visible, hovering states the used and remaining share (or the amount, ceiling,
and remainder), and a click opens the full dialog.

## Limits

- One credential per route: several Cursor accounts, pooling, and failover are
  not supported.
- Team-wide and organization-wide Cursor spend is not read; a member key cannot
  reach those endpoints.
- Cursor's Fast tier and stop sequences are unsupported, and temperature and
  output caps are ignored by the vendor.
- File attachments are not forwarded; images are, when the host store can read
  them, and an unreadable or offloaded image becomes a text note.
- Usage during a tool handoff is reported when the run ends, not while the tool
  runs.
- The public capacity source is third-party data. A model neither the catalog
  nor models.dev describes keeps the 200 000-token default unless a manual value
  is set. A wrong upstream number cannot be overridden by the manual field while
  the source is on; switch the source off first.

## Verification

Without a real account, unit tests cover the adapter through injected SDK and
HTTP seams. With an account, install the plugin, store the key, open **Settings
→ Subscriptions**, and check that Cursor lists models and reports a window; then
send one prompt with a tool call from the composer.

See the
[decision record](../.agents/notes/implemented/provider/2026-11-21-cursor-key-route.md)
for the endpoint probes and the alternatives, and the
[capacity decision](../.agents/notes/implemented/provider/2026-11-21-cursor-context-capacity.md)
for why the window comes from three sources.
