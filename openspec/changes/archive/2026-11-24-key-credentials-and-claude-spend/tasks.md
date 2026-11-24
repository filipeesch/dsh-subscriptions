# Tasks

## 1. Foundations on the touched surfaces

- [x] 1.1 Move each key route's default credential reference into its route
      module (`cursor` and `ollama-cloud` export their own constant) and build
      the external usage controller's reference table from those providers
      instead of a second literal table; verify `pnpm build` and `pnpm test`
      pass with no duplicated literal left in the controller.
- [x] 1.2 Replace the source switch in the external usage controller with a
      reader map keyed by source, so a new source is a table entry; verify the
      existing external usage specs pass unchanged and a source added in a test
      needs no edit to the class.
- [x] 1.3 Split the RPC dispatch into per-domain handler modules behind an
      endpoint-to-handler map, leaving the transport (exact route, envelope,
      error mapping) in place; verify `test/rpc.spec.ts` passes without touching
      the browser callers and that every endpoint in the table answers.
- [x] 1.4 Replace `registerAuthRpc`'s positional optionals with an options
      object and update the single assembly call; verify `pnpm build`,
      `pnpm test`, and that no caller passes positional optionals.

## 2. Key credential host surface

- [x] 2.1 Add a credential service that describes, writes, and clears the key of
      a key-based route by route id, resolving the credentials service lazily
      and mapping a route the plugin does not serve to a refusal; verify unit
      tests with a fake credential seam cover describe, write, clear, and an
      unknown route.
- [x] 2.2 Read the host's masked preview through a locally declared optional
      field so the build stays on the supported floor; verify a test renders the
      card state with and without the preview.
- [x] 2.3 Add the three endpoints (`keyCredential`, `keySetCredential`,
      `keyClearCredential`) to the endpoint table and its handlers, validating
      the route id and a non-empty value from a trimmed payload with a length
      cap; verify RPC tests cover a describe, a save, a clear, an empty value,
      an unknown route, and a missing credentials service, and that no response
      carries a value.
- [x] 2.4 After a successful write or clear, invalidate that source's usage
      reading and re-announce the route so the next read and the picker use the
      new key; verify a test asserts the invalidation and the re-announcement
      happen on a save and on a clear.

## 3. Key credential card

- [x] 3.1 Add a shared credential field component (origin line, optional masked
      preview, password input, save, replace, remove, inline error) used by both
      key routes; verify component tests cover absent, environment, stored, and
      stored-without-preview states, plus a refused write.
- [x] 3.2 Mount the field on the Cursor card and validate a save through catalog
      discovery, reporting a rejected key on the card while keeping it stored;
      verify tests cover an accepted key and a rejected key.
- [x] 3.3 Mount the field on the Ollama Cloud card and state that the model
      dialog's key input overrides the stored key for one listing when filled;
      verify tests cover the stored-key path and the typed-key path.
- [x] 3.4 Add the new strings to both dictionaries (English and Chinese) with
      the origin labels derived from the seam's source layer; verify the locale
      parity check in the UI alignment spec passes.

## 4. Claude quota reader

- [x] 4.1 Map the spend block to one money window (amount spent, ceiling,
      remaining, currency, share from the reported percentage or from the
      amounts) and fall back to the flat extra-usage block with its declared
      decimals; verify reader tests cover the enterprise shape, the flat
      fallback, a declared exponent other than two, a disabled block, and an
      unusable amount.
- [x] 4.2 Report the OAuth-apps weekly bucket as its own scoped weekly window;
      verify tests cover it present, null, and absent.
- [x] 4.3 Place the money window after every plan window and set the shared
      reading's "no plan window reported" flag when neither a session nor a
      weekly window came from the endpoint; verify tests cover plan plus money,
      money only, and nothing usable.
- [x] 4.4 Extend the virtual Claude provider's usage fixture with the spend
      block, the extra-usage block, and the OAuth-apps bucket; verify the Claude
      integration spec exercises both account shapes through the fixture.

## 5. Shared window row and card states

- [x] 5.1 Extract one window row component and one label helper and wire the
      Claude/Codex account rows, the Cursor card, the Ollama card, and the
      key-only cards to them; verify the four cards render rows through the
      shared component and no card keeps its own copy.
- [x] 5.2 State amounts on the row (spent and ceiling in the window's currency,
      remaining when present, share unavailable when there is no ceiling) and
      keep the stale marking; verify component tests cover a money row, a money
      row without a ceiling, a percent row, and a stale row.
- [x] 5.3 Show one discreet line on the Claude card when the reading reports no
      plan window while carrying the budget; verify a test renders the line for
      that reading and its absence when a plan window exists.

## 6. Docs, notes, and verification

- [x] 6.1 Update the README feature list and `docs/cursor.md` (prerequisite and
      a section on setting the key from the card, including the environment
      origin and what removing the stored copy does); verify the prose standard,
      the 80-column wrap, and `node scripts/check-markdown-tables.mjs`.
- [x] 6.2 Add the changelog entry covering the card credential and the Claude
      budget reading; verify `npx markdownlint-cli2` passes on the changelog.
- [x] 6.3 Write the two Agent Notes — the Claude budget reading (provider) and
      the key credential card (architecture) — with alternatives and
      consequences; verify `node scripts/verify-agent-notes.mjs` passes.
- [x] 6.4 Capture the UI screenshots for the review: the credential field in its
      absent, environment, and stored states, and the Claude card with the
      budget row and the missing-plan-windows line, rendered from the shipped
      components against fixture data; verify each capture exists and is listed
      in the review notes.
- [x] 6.5 Run the full gate — `pnpm build`, `pnpm test`, `pnpm lint`,
      `pnpm format:check` — and record the commands and results for the PR.

## 7. Review fixes

- [x] 7.1 Serve credential CRUD only for a reference fixed by operator
      configuration; verify a route whose reference the browser can rename is
      refused without touching any credential, and that a renamed Ollama
      reference grants nothing.
- [x] 7.2 Keep credential material out of refusals and out of the browser: fixed
      sentences for provider failures, reference-grammar validation on the
      Ollama setting so a pasted secret cannot be stored, no configured-name
      echo; verify with a synthetic secret marker across success and error
      payloads.
- [x] 7.3 Report a committed write as committed with an unread state when the
      follow-up describe fails; verify a save is never reported as failed after
      it landed.
- [x] 7.4 Drop the caches a previous credential produced before notifying the
      picker (usage reading and the in-flight Cursor catalog) and snapshot the
      reference once per operation; verify a validation read cannot join the old
      key's fetch.
- [x] 7.5 Reload the credential field when the card's effective reference
      changes and ignore superseded lookups; verify with a remount carrying a
      new reference.
- [x] 7.6 Distinguish unusable from absent amounts in the Claude budget, keep a
      reported zero ceiling, drop a mixed-currency ceiling, clamp a reported
      share; verify each case in the reader spec.
- [x] 7.7 Set the missing-plan-window flag only on a non-empty reading, gate the
      card's note on a money row, and stop dereferencing a missing reading;
      verify the Settings page renders pending, failed, budget-only, and mixed
      readings.
- [x] 7.8 Render the remaining amount (including zero) and decide the share note
      by the ceiling, not the percentage; verify the money, zero-ceiling,
      percent modes, and stale cases.
- [x] 7.9 Preserve the legacy endpoint diagnostics across the split and pin
      them: a blank source, an unknown source, a non-object payload, a
      non-object settings payload, and a malformed settings document.
- [x] 7.10 Make the credential controls accessible: a labeled form with
      Enter-to-save, the origin described by the input, outcomes in a live
      region, environment-specific copy ("save a DSH override"), the removal
      hint, and visibly disabled actions.
- [x] 7.11 Extend the tests the review named: a layered fake seam shared by
      describe/resolve, card-level validators, section states, the injected
      reader table, and the amount edge cases.
- [x] 7.12 Reconcile the artifacts with the shipped behaviour: the two spec
      deltas, the design, both Agent Notes, the proposal, and the changelog.

- [x] 7.13 Keep a stored credential on its destination: the Ollama listing
      spends the host-resolved key only for the operator-configured base URL,
      any other address needs a key supplied with that listing, and the card's
      post-save validation rides the submitted value; verify against a loopback
      provider that receives the saved key, and a foreign address that is
      refused before any request.
- [x] 7.14 Stop printing a malformed configured name: settings replies omit it,
      the key-route resolver treats it as unconfigured instead of raising an
      error that quotes it, the Cursor catalog read throws a fixed sentence, and
      the seam's grammar refuses a pasted secret as a reference; verify with a
      synthetic marker across settings, status, and catalog failures.
- [x] 7.15 Make the commit contract hold on both sides: a throwing change
      notification cannot reject a committed write, the card trusts the reported
      commit and reports an unconfirmed write as a failure, and the field
      re-reads the state and stays locked through validation.
- [x] 7.16 Bind the credential field to reference provenance: the Ollama card
      includes a settings revision in the field identity, so an override with
      the same text remounts it; verify the identity and a cache invalidation
      that drops the old in-flight read.
- [x] 7.17 Close the Claude mapper edges: an unreadable declared scale or a
      block of another shape drops the window, a balance in another currency is
      ignored and the remaining amount derived; verify each case.
- [x] 7.18 State money without a declared currency instead of hiding it, add the
      form's accessible name and one always-mounted status region, and say "if
      one is set" in both locales for the removal hint.

- [x] 7.19 Apply one credential-use policy across the host: chat, discovery, the
      listing, usage, and web spend the stored Ollama key only at the operator's
      address; a card-saved address reports the route unconfigured, no request
      carries the key, and the settings view says the stored key is idle there.
- [x] 7.20 Bind validation to the committed credential: the commit reports a
      host-side generation, the host runs the route's read, an older or mid-read
      supersession answers as its own outcome, and the client never validates a
      credential it did not store.
- [x] 7.21 Refuse a value with control characters before it becomes an
      authorization header, and report a listing failure as a fixed sentence;
      verify the serialized reply carries no synthetic marker.
- [x] 7.22 Keep the field's own mutation from remounting it: the connection
      manager's save still bumps the identity revision, while a card save keeps
      the saved-but-unusable outcome live.

- [x] 7.23 Capture the credential and the destination as one snapshot per
      request (chat, discovery, web, listing) so a Settings save between the key
      read and the request cannot pair an approved key with an unapproved
      address; add a deferred read test that moves the address while the key
      resolves.
- [x] 7.24 Refuse a value that cannot ride an authorization header on every
      usage read, and gate the usage policy by source rather than reference
      name; test the usage envelope with a synthetic marker and two sources
      sharing a reference.
- [x] 7.25 Remove the caller-supplied value from validation: the host reads the
      committed credential, runs the route read under the destination policy,
      and reports supersession when the generation moves during the read.

- [x] 7.26 Validate the token a provider exchanges for the API key before it
      rides a header, and replace any usage transport failure with a fixed
      sentence, keeping the detail in the cause; verify with a synthetic marker
      that no second request is attempted and the serialized failure omits it.
- [x] 7.27 Bind a generation to the committed reference and a host-only value
      fingerprint, so a Settings-only reference change between save and
      validation answers superseded; verify at the service and through the
      mounted channel.

- [x] 7.28 Re-check the generation, not only the reference and digest, after the
      provider read; hand the verified value to that read so the provider cannot
      resolve another key; publish a removal's identity synchronously and refine
      its environment fallback only while the removal still owns the generation;
      verify a same-value re-commit during the read and a save that overtakes a
      clear.
- [x] 7.29 Replace the 32-bit fingerprint with a process-keyed HMAC digest and
      describe the guarantee precisely, and decide cancellation in the usage
      guard by the caller's signal while keeping the raw failure out of the
      diagnostic.

- [x] 7.30 Give Cursor a validation read that spends the verified value: it
      takes the value (never the catalog cache), refuses an empty catalog, and
      the service test proves the validator received exactly the stored value;
      verify the gateway receives the value and a warm cache is not joined.
- [x] 7.31 Finish the usage guard: cancellation decided by the caller's signal,
      both branches fixed sentences, no raw failure or cause retained; verify an
      abort-named failure with a live signal and a genuinely aborted read.

- [x] 7.32 Make the validation read side-effect free: it shares the gateway
      call, timeout, and empty-result check with discovery, while warmup,
      catalog publication, and tier pruning stay in discovery; verify a
      validation released after a refresh publishes nothing and forgets no
      remembered tier.
- [x] 7.33 Qualify the idle-address state: the card states that a key check
      proves the key at the configured address, not at the saved one, and names
      the way to re-enable the route.
