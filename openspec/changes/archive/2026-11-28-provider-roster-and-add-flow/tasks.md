# Tasks

## 1. One provider table and the configured set

- [x] 1.1 Add one ordered provider table covering the eleven providers: id,
      route family (OAuth session, Cursor key, Ollama connection, managed key),
      display name, copy keys, and the endpoint each writes through. Derive the
      roster order (OAuth page order, Cursor, Ollama, managed-key page order)
      and the selector order (display name) from that table; verify a test pins
      both orders and no second list of providers is introduced.
- [x] 1.2 Replace the section's per-provider state with one configured-set read
      (`status`, `externalStatus`, `ollamaSettings`) that keeps the last
      successful answer and exposes checking, configured, and failed. Derive
      Ollama's configured state from a resolving Cloud key or a saved base URL,
      and mark a route whose stored key cannot be spent as needing attention;
      verify section-state tests cover configured-only rows, the Ollama local
      case, the idle Cloud key, a failed first read, a failed read after
      success, and Retry.
- [x] 1.3 Build the roster list, its heading row with the add action, and the
      empty, checking, and failed panels as bordered states; verify the add
      action is unavailable while the configured set is checking or failed, and
      that a successful read reporting nothing shows the empty state instead of
      the failed one.

## 2. Rows and their detail

- [x] 2.1 Extract the OAuth provider block into a row detail that keeps its
      reads and actions unchanged: usage with refresh, add account, the manual
      fallback, the device code, cancel, and the account manager; verify the
      section-state spec still covers the pending read, the failed read, and the
      missing-plan-window note through the row.
- [x] 2.2 Turn the external usage cards into one detail per source, keeping its
      usage read, refresh, loading, error, unsupported, empty, and stale states;
      verify the external usage spec passes against the per-source detail.
- [x] 2.3 Give `CursorCard` and `OllamaCard` a chrome-free variant for use
      inside a row, leaving their reads, validation, and writes untouched;
      verify the Cursor manager, Cursor bar, Ollama settings, and key-credential
      specs pass unchanged.
- [x] 2.4 Make each row a disclosure: a header button carrying
      `aria-expanded`/`aria-controls` and a 44 px target, a region that holds
      the detail, rows collapsed on first render, expansion independent per row,
      and no usage read before the first expansion; verify component coverage of
      the toggle, the accessible name, the deferred read, and two rows expanded
      at once.
- [x] 2.5 State each row's connection as text from the same snapshot — the
      account count for an OAuth provider, the saved API key for a key route,
      the Cloud key or local address for Ollama, the managed key for a managed
      source, and needs attention when the stored credential cannot be used;
      verify a collapsed row shows no account name, expiry, quota value, or
      action.

## 3. The preferences band

- [x] 3.1 Move the three display preferences into a tinted collapsible band
      above the roster, outside the list's border and collapsed by default,
      keeping the controls, the hint copy, and the browser keys; verify the
      alignment spec renders the band collapsed, that opening it keeps the
      current values, and that a changed value survives a reload.

## 4. The add-provider form

- [x] 4.1 Build the form shell: the `Add provider` heading, one Provider select
      over the eleven providers in selector order, the configured entries marked
      and unchoosable, a divider, and a footer with Cancel and the route's
      primary action. Opening the form replaces the roster; verify a test covers
      the full list, the marked entries, no initial choice, and the roster
      hidden while the form is open.
- [x] 4.2 Add the per-route fields through the table's family: browser
      authorization for the OAuth providers with the manual callback fallback, a
      GitHub device code for Copilot, one masked key for Cursor, a check naming
      the reference for the managed keys, and the Cloud key or local address
      choice for Ollama. The primary action's label and write come from the same
      entry and stay unavailable while a required field is empty; verify each
      family renders its own fields and action, and that choosing writes
      nothing.
- [x] 4.3 Implement the waiting states: start `login`, poll `status` only while
      busy, state which provider is awaited, offer the manual fallback, show the
      device code with copy and open, cancel the attempt through `cancel`, and
      report a failed attempt in the form. The form returns to the roster only
      on a confirmation; verify the browser wait, the manual completion, the
      device code, the attempt cancel returning to the form, and a reported
      failure.
- [x] 4.4 Wire the save paths: Cursor through `keySetCredential` followed by
      `keyValidateCredential`, reporting a saved-but-unusable key and offering
      the field again; Ollama's address through `ollamaSetSettings` and its
      Cloud key through the shared credential field; the managed keys through
      `externalStatus` only, with a missing key keeping the form open. Cancel
      writes nothing; verify each path and that cancel during and after typing
      adds no row.
- [x] 4.5 Hand the confirmation to the section: mark the provider configured,
      close the form, reconcile with a re-read, show one outcome line above the
      list naming what was saved, and keep the confirmed row when the
      reconciliation fails. Clear the line when the form opens again; verify one
      row per provider, the previous rows intact, and no second row on a
      repeated confirmation.
- [x] 4.6 Make the form usable: an accessible name on every field, focus moved
      into the chosen provider's first field, focus returned to the roster
      heading whenever the form closes, outcomes and failures announced in a
      live region, a 44 px target on every control the form adds, a pending
      action that stays focusable while it reads as unavailable, and at 390 px
      stacked fields with the footer actions on one right-aligned row; verify
      the labels and focus behaviour in the component harness and the geometry
      and focus behaviour in a browser probe.

## 5. Copy

- [x] 5.1 Add the roster and form strings to both locale dictionaries, keeping
      the state vocabulary per route family and naming no internal mechanism;
      verify the alignment spec's locale parity check passes and the Ollama copy
      keeps the statement that saving an address does not check reachability.

## 6. Tests

- [x] 6.1 Cover the roster: which rows appear, the fixed order, the row states,
      expansion independence, the deferred usage read, and the preferences band.
- [x] 6.2 Cover the form: the selector's list and marks, choosing and switching
      writing nothing, cancel from each stage, the waiting and device-code
      states, the confirmed row plus outcome line, the unusable key, the address
      caveat, and the managed key that is missing.
- [x] 6.3 Move the existing section, external-usage, and alignment specs onto
      the new containers without weakening what they already pin.

## 7. Docs, evidence, and the gate

- [x] 7.1 Update the README feature list for the roster and the form, and
      recapture `docs/images/subscriptions.png` from the shipped components.
- [x] 7.2 Add the changelog entry covering the collapsed roster and the add
      form, and verify `npx markdownlint-cli2` passes on it.
- [x] 7.3 Write the Agent Notes for the roster's configured-set read and the add
      form's route registry, with the alternatives and consequences the design
      records; verify `node scripts/verify-agent-notes.mjs` passes.
- [x] 7.4 Capture the changed UI for review at 390, 768, and 1280 px in both
      themes: the roster collapsed and expanded, the empty, checking, and failed
      states, the form before and after a choice, the Ollama connection choice,
      and the device-code and manual-fallback states.
- [x] 7.5 Run the full gate — `pnpm build`, `pnpm test`, `pnpm lint`,
      `pnpm format:check` — and record the commands and results for the pull
      request.
