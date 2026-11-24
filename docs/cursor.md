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
- A **Manage models** dialog on the Cursor card: enablement, each model's
  advertised window with the source it came from, and a manual override for a
  window nothing else describes or the public catalog gets wrong. Every change
  saves as it is made.

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
      contextWindows:
        composer-2.5: 200000
      models:
        auto-smart:
          enabled: false
      publishedContext: true
```

| Option             | Default               | Meaning                                                         |
| ------------------ | --------------------- | --------------------------------------------------------------- |
| `apiKeyRef`        | `CURSOR_API_KEY`      | DSH credential reference holding the key                        |
| `cwd`              | the session directory | Working directory for Cursor agents                             |
| `contextWindows`   | none                  | Manual advertised window per model, in tokens                   |
| `models`           | none                  | Per-model baseline: `enabled`                                   |
| `publishedContext` | `true`                | Whether the route may read published capacities from models.dev |

The requested context tier is not configurable: the route always asks for the
largest tier a model offers. A tier Cursor rejects is retried once with the next
smaller offered tier, and that accepted tier is remembered for later runs,
across restarts. The tier preference this table used to carry (`context`, and
`context` inside `models`) no longer selects anything; a profile that still
declares either key loads and ignores it.

Cursor's Fast tier stays off, so pricing and latency are the standard ones.

## Context windows

DSH meters the window the route advertises: compaction pricing uses it, so a
window smaller than the provider applies forces premature compaction and a
larger one lets a request overflow. The route resolves it in this order:

1. the capacity of the context tier the request carries (the largest offered, or
   the one Cursor accepted after a rejection while the catalog still offers it);
2. a manual value for the model, stored by the dialog or set in
   `contextWindows`;
3. the capacity the public [models.dev](https://models.dev) catalog publishes
   for the model;
4. 200 000 tokens.

A manual value outranks the published capacity because the published number is a
third-party estimate and the manual one is the reader's correction. Only the
requested tier outranks both, because that is what the provider applies.

Models Cursor lists without a context tier, such as `deepseek-v41-flash-1017`,
reach step 3 and advertise the capacity the public catalog states. The catalog
is fetched out of band (on start and when the stored projection is older than 24
hours, through the host's proxy, with a 20-second timeout and a response cap),
projected onto the ids Cursor currently lists, and stored in
`~/.dsh/plugins/subscriptions/cursor-context-windows.json`. The projection reads
the entries it can: an entry that declares no context window — an image, speech,
or transcription model — is skipped, so it cannot make the rest of the catalog
unreadable. A withdrawn id stops being served immediately, a failed refresh
keeps the previous projection, and no request waits for the network. A refresh
started in the manager reports whether it succeeded, failed, or could not run.

Turn the source off in the manager, or with `publishedContext: false`, and step
3 is skipped entirely: no fetch runs and a stored projection is not served.
Correcting a wrong published number no longer needs that switch: the manager's
pencil stores a manual value that outranks it. A remembered tier is dropped when
the catalog stops offering it.

The model catalog is stored beside it in `cursor-catalog.json`, and the
per-model settings, remembered tiers, and the source switch live in
`cursor-settings.json`. Settings win over the configuration for the same field.
The **Manage models** dialog lists each model on one line with the window the
route will advertise and the source it came from, and offers a manual override
on every row whose window does not come from a tier. Enabling, disabling, and
overriding save as the change is made; a change the route refuses restores the
stored value and states the failure in that row. Enabling or disabling a model
changes the picker only; a saved conversation keeps working.

The advertised window matters beyond display: it is the budget DSH's compaction
charges against, and a model switch compacts through the route that last
answered. If a conversation genuinely outgrows the window, give that
summarization route quota (or configure the host's compaction model) rather than
relying on a larger advertised window.

## Failures and recovery

A turn that fails before it emitted anything — no text, no reasoning, no tool
call — is replayed once: the route drops the agent and runs the same turn again
on a new one seeded with the full history. A rejected API key and rejected model
parameters are never replayed, even before output, because neither can succeed
on retry. A failure after output is not replayed either, because repeating a
half-finished run would send part of the turn twice. One adapter request
therefore makes at most three provider attempts, counting the smaller-tier
retry; the host's own retries are separate requests.

The code a failed turn reports says what may happen next. A pre-output failure
that survived the replay reports `CURSOR_UNAVAILABLE`, and the route publishes a
retry policy that lets the host repeat only that code, at most twice. A failure
after output, a rejected API key, and rejected model parameters report
`CURSOR_RUN_FAILED`, which the host's default policy does not retry.

Every failed turn records one warning on the plugin's log. The line names the
boundary (before or after output), the phase (`setup` while the agent is created
or sent to, `run` once a run exists), the cause (`credential`, `unreachable`,
`parameters`, or `local`), and a diagnostic detail drawn from the route's own
reviewed vocabulary:

```text
Cursor failed before output (phase=setup, cause=local): local store failure
Cursor failed before output (phase=run, cause=credential): credential rejected (AuthenticationError, code=unauthenticated, status=401)
```

The detail is always a fixed literal — `local store failure`,
`agent state lost`, `stream timed out`, `stream closed early`, `rate limited`,
`quota exhausted`, `transport unreachable`, `credential rejected`,
`model parameters rejected`, or `unclassified failure` — optionally followed by
allowlisted structured fields from the SDK's own error object: one of the SDK's
reviewed error class names, one of the reviewed error codes, or an HTTP status
the SDK reports as a number. Provider text is never printed, and nothing is read
out of it, because it can echo a credential or a request fragment — including a
number or a name that looks like a status or an error class. An unfamiliar
failure therefore reads `unclassified failure`, and the fix is to teach the
vocabulary about it. The sentence the conversation shows is separate and fixed.
On `dsh web`, the warning appears in the terminal that started the host.

Three consequences worth knowing. A request that fails during setup — the
credential read before any agent exists — reports `CURSOR_RUN_FAILED`, because
the route's recovery was never spent, so the host does not retry it. A run
stream that breaks is a failed delivery even when the provider still reports the
run as running, or later reports it as finished: the route reports the failure
rather than a clean stop or a tool handoff, which is how a truncated answer is
not mistaken for a complete one. A run that reports its own failure gets a
bounded moment to report the reason before the turn settles — whichever source
reported the failure, and whether or not something else woke the turn meanwhile.
A failure whose reason never arrives is reported without a replay, without a
smaller tier and without offering the host a retry, and a run that ends with a
tool call still open withholds the call while keeping any output it had already
produced. A rejection the run has already reported is enough to stop the call
from going out at all, even if the run has not formally ended yet, and a failure
the stream reports settles the turn without waiting for the run's result to
catch up. And an attachment the route cannot read leaves one fixed warning line
of its own — the request continues without the image, and the reader's exception
stays out of the log.

One failure class survives the restart boundary: a process-wide `@cursor/sdk`
state can fail every turn until DSH restarts, because the route can rebuild an
agent but not the SDK's own runtime. The warning's detail is what tells that
case apart from a transient failure.

An agent's lifetime is wall-clock time: 20 minutes unused, or 60 minutes while a
tool result is still owed. A sweep closes idle agents, and a turn never reuses
one past its budget. A suspended machine therefore does not extend an agent's
life, and a run longer than the budget keeps its agent until it ends.

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
  is set. A wrong upstream number is corrected with the manager's manual
  override, which outranks it. The requested tier is always the largest the
  model offers; the route steps down only when Cursor rejects it.

## Verification

Without a real account, unit tests cover the adapter through injected SDK and
HTTP seams, including the pre-output replay, both failure codes, the retry
policy, the redacted warning, and the wall-clock lifetime sweep. With an
account, install the plugin, store the key, open **Settings → Subscriptions**,
and check that Cursor lists models and reports a window; then send one prompt
with a tool call from the composer.

See the
[decision record](../.agents/notes/implemented/provider/2026-11-21-cursor-key-route.md)
for the endpoint probes and the alternatives, the
[capacity and manager decision](../.agents/notes/implemented/provider/2026-11-23-cursor-capacities-and-manager.md)
for why the window resolves in this order and why a manual value outranks the
published one, and the
[failure recovery decision](../.agents/notes/implemented/provider/2026-11-24-cursor-failure-recovery.md)
for why only a pre-output failure is replayed and what the warning carries.
