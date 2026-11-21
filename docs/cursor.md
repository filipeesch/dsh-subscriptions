# Cursor

Cursor joins the plugin as a key-based model route: `cursor`. DSH keeps the
agent loop, tools, and permissions; Cursor provides the model through the
official `@cursor/sdk` and the account's own API key. The route needs no OAuth
login and keeps no `auth.json` entry.

## What it adds

- Cursor's live model catalog in DSH's picker, with each model's advertised
  reasoning efforts. The largest offered context tier is the default, and a
  model the catalog does not list keeps a built-in entry when it is one the
  plugin knows.
- One Cursor agent per DSH conversation. Tool calls run in DSH, and the result
  returns to the same Cursor run; tool changes mid-conversation restart the run
  with the current tools.
- Cursor's subscription quota in **Settings → Subscriptions**, the footer quota
  bar, and the usage dialog.

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
    apiKeyRef: CURSOR_API_KEY
    context: max
```

| Option      | Default               | Meaning                                                                    |
| ----------- | --------------------- | -------------------------------------------------------------------------- |
| `apiKeyRef` | `CURSOR_API_KEY`      | DSH credential reference holding the key                                   |
| `context`   | `max`                 | Context tier: `max` (the largest offered), or an exact tier such as `300k` |
| `cwd`       | the session directory | Working directory for Cursor agents                                        |

A rejected context tier is retried once with the next smaller offered tier and
remembered for the process. Cursor's Fast tier stays off, so pricing and latency
are the standard ones.

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

## Verification

Without a real account, unit tests cover the adapter through injected SDK and
HTTP seams. With an account, install the plugin, store the key, open **Settings
→ Subscriptions**, and check that Cursor lists models and reports a window; then
send one prompt with a tool call from the composer.

See the
[decision record](../../.agents/notes/implemented/provider/2026-11-21-cursor-key-route.md)
for the endpoint probes and the alternatives.
