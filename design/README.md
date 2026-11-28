# Subscription Hub design

Open the Design preview at **Settings → Subscriptions**. Review the light and
dark themes at mobile (390 px), tablet (768 px), and desktop (1280 px). The
review navigator groups screens into Overview, First provider, Additional
provider, Sign-in alternatives, and API key alternatives. The two setup journeys
list their steps in order. Named states sit under their owning screen. On the
main screen, use the `provider-list` variants for the empty, loading, and failed
status checks.

## Proposed behavior

- The roster shows only configured providers. Each row starts collapsed and
  shows the provider name and connection status as text. Expand the row for the
  existing account, usage, credential, model, and connection controls. Quota
  display preferences have a separate tinted disclosure above the roster; values
  and persistence are unchanged.
- **Add provider** opens one form with a provider selector. The selector
  includes all 11 providers and marks existing connections as configured. Add
  another account from the existing row.
- Selecting a provider reveals its fields below the selector without writing
  changes. The footer has Cancel and one primary action: Save for settings, or
  the provider’s authorization or credential-check action. The setup methods are
  browser authorization with the manual callback fallback, a GitHub device code,
  a masked key for Cursor or Ollama Cloud, a check for a key managed in
  **Settings → Models**, or an Ollama local address. Preserve the authorization
  and credential ownership of each route. Never send the saved Cloud key to a
  local destination.
- Cancel returns to the roster without saving. The primary action returns after
  configuration is confirmed. Add one collapsed row without removing other
  entries. A failed status check is not an empty roster: keep the last known
  rows if available, show an error, and let the user retry. Canceling an
  in-progress sign-in cancels that attempt without adding a row. Show a
  saved-but-unusable key as needing attention, not as a working connection.
- The Ollama local example confirms the address was saved, not that the server
  is reachable. The current Cloud route does not establish unauthenticated local
  chat; local runtime support is not demonstrated by this prototype.

## Preview limits

All examples use fictitious data. Do not enter real credentials. The prototype
does not call providers, save settings, open authorization pages, copy device
codes, or consume credits. The two Ollama success scenes simulate a save from an
empty roster and from a roster with existing providers. The kit simulates an
in-place select with an anchored list and individual form snapshots. The
first-use fixture exercises representative methods; post-save pickers are
read-only examples. The kit renders compact input and dialog-close controls;
implementation should provide a 44 px target for the new controls.

Compare the [current settings client](../src/client/SubscriptionsSection.tsx)
and [reference capture](../docs/images/subscriptions.png) for the existing
details. The journeys cover [first setup](journeys/add-first-provider.dsx),
[adding to an existing roster](journeys/add-ollama-local.dsx),
[switching provider and canceling](journeys/change-provider.dsx),
[canceling browser sign-in](journeys/add-provider-browser.dsx),
[account management](journeys/manage-codex.dsx), and
[reset confirmation](journeys/review-codex-reset.dsx).
