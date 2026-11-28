# Proposal

## Why

The Settings → Subscriptions page renders every provider the plugin serves: five
OAuth cards, the Cursor card, the Ollama card, and four key-managed quota cards.
A reader who configured two providers scrolls past nine cards describing routes
this installation does not use — empty account lists, "not configured"
instructions, and usage sections with nothing to report. Nothing on the page
says which providers are actually in use, and adding one is not an action: it is
whatever the first button on the right card happens to be.

## What Changes

- **A roster of the configured providers.** One bordered list with dividers
  holds one collapsed row per configured provider. A row states the provider
  name and its connection as text; expanding it reveals the controls that
  provider's card carries today — accounts, usage windows, the credential field,
  the model manager, the connection settings. Nothing is removed; every control
  survives one level down.
- **Quota display preferences above the roster.** The three display preferences
  move into a collapsible tinted band, visually separated from the list, with
  the same options and browser persistence.
- **One add-provider form.** **+ Add provider** opens a form whose single
  selector lists all eleven providers in one order, marks the configured ones
  and keeps them out of reach, and reveals the chosen provider's own fields
  below the selector without writing anything. The footer offers Cancel and one
  primary action — Save, Continue in browser, Get device code, Check again, or
  Save address — matching the chosen route. Cancel returns to the roster and
  writes nothing; a confirmed configuration returns to the roster with one new
  collapsed row and a line stating what was saved.
- **States that stay distinguishable.** Checking, empty, and failed are three
  different things. The roster states that it is checking while the configured
  set loads; the empty state appears only after a successful read reports
  nothing; a failed read keeps the last known rows, states the failure, and
  offers Retry.
- **Route ownership preserved.** Each configuration method stays with its route:
  browser authorization with the manual callback fallback, the GitHub device
  code, the masked Cursor key, a key already managed in **Settings → Models**,
  or the Ollama Cloud key and local address. Saving a local address keeps
  stating that reachability was not checked, and a stored Cloud key is never
  sent to it.

## Capabilities

### New Capabilities

- `settings/provider-roster`: the roster — which rows appear, what a collapsed
  row states, what expanding reveals, the fixed order, the loading, empty, and
  failed states, and the quota display band above the list.
- `settings/add-provider`: the form — the selector over all eleven providers,
  the per-route fields and primary action, the browser and device-code waiting
  states, cancellation, failures, and the one row a confirmed configuration
  adds.

### Modified Capabilities

None. The provider, credential, and usage capabilities keep their requirements:
the cards they describe are unchanged, rendered inside a disclosure instead.

## Impact

- **Client.** `SubscriptionsSection.tsx` becomes the roster: a list, a row, and
  the three list states, plus the quota display band. A new add-provider form
  carries the selector and the per-route fields. `CursorCard`, `OllamaCard`, and
  `ExternalUsageCards` lose their page-level card chrome and become row content.
  Both locale dictionaries gain the roster and form copy.
- **Host.** No endpoint changes. The form reuses `status`, `login`, `manual`,
  `cancel`, `ollamaSettings`, `ollamaSetSettings`, `keySetCredential`,
  `keyValidateCredential`, `cursorSettings`, `externalStatus`, and
  `externalUsage`.
- **Compatibility.** No stored-setting, wire, peer-range, or support-window
  change. The browser-local display preferences and every provider status answer
  keep their shapes.
- **Tests.** The section state spec, the external usage cards spec, the native
  UI alignment spec, and the locale parity check move to the roster and the
  form. New coverage for which rows appear, the row states, the selector and
  cancel behavior, and the loading/empty/failed distinction.
- **Docs.** The README feature list with a refreshed
  `docs/images/subscriptions.png` capture, the CHANGELOG, and one Agent Note per
  decision.
