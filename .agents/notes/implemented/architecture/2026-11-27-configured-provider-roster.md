# Agent Note: The configured-provider roster

Status: implemented

## Problem

The Subscriptions page rendered all eleven provider cards at once: five
OAuth-session cards, the Cursor card, the Ollama card, and four key-managed
usage cards. A reader who configured two providers scrolled past nine cards
describing routes this installation does not use — empty account lists, "not
configured" instructions, and usage sections with nothing to report — and
nothing on the page said which providers were actually in use. Adding a provider
was not an action: it was whichever button happened to sit first on the right
card.

## Decision

The page renders one roster: a bordered list of the providers this installation
is configured for, one collapsed row each, in a fixed route-family order —
OAuth-session providers in their page order, then Cursor, then Ollama, then the
key-managed sources in theirs. A row states the provider and one connection in
text and expands to the detail that provider's card carried.

Which providers have a row comes from one configured-set read, not from each
card reporting upward. The page asks three endpoints together — `status` for the
OAuth accounts, `externalStatus` for Cursor and the key-managed sources, and
`ollamaSettings` for the address a key cannot travel to — and commits the answer
only when all three succeed. A partial answer is a failed read: the rows of the
last successful snapshot stay exactly as they were, so a reconciliation that
answers one half and fails the other can neither drop a known row nor invent
one. The empty state appears only after a successful read that reports nothing,
a failure is stated whether or not rows exist, and adding a provider needs both
a snapshot and a read that is not currently failing.

Ollama is configured when either its Cloud key resolves or a base URL is stored.
The second half is why `ollamaSettings` belongs in the read: `externalStatus`
reports the Cloud key alone, so a local address would otherwise leave the
provider looking unconfigured. When an address is saved and the Cloud key is not
spendable there, the page describes that credential — a read that proves a key
is stored without spending it — so the row states a Cloud key idle at that
address instead of passing the address off as a working connection.

Reads overlap — a poll tick, an action, and a Retry can all be in flight — so
each answer carries a ticket and only the newest of its kind may publish.
Without that a slow answer that predates a removal would resurrect the removed
row.

The OAuth state moves through its own path. `pollStatus` reads `status` alone
and publishes the accounts, the pollers' settling, and the attempt a form is
judged by; a changed account set then asks for a full read. So a sign-in attempt
is confirmed even while the roster's other halves fail, and a failed poll is its
own error line, cleared by the next successful poll, rather than a verdict on
the last full read. A poller stops only when its provider is no longer busy: an
account already connected must not stop a second one being added.

A confirmation from the add form can outlive the read that would reconcile it,
so the OAuth row counts the confirmed accounts when the snapshot is behind — a
provider the route just confirmed never vanishes from the list.

A row's detail mounts only when the row expands. A collapsed roster performs no
usage read; expanding a row starts the reads its card performed on mount. The
composer badge polls its own usage and is refreshed by the same event, so
deferring the roster's reads does not change it.

The display preferences moved into their own tinted disclosure above the list,
with the same options and the same browser keys, so the band's controls survive
the reorganization unchanged.

## Alternatives considered

**Let each card report its configured state upward.** Eleven independent reads,
rows appearing one at a time as their answers landed, and no way to tell a
failed read from an empty roster — the two states this page had to keep apart.

**Add one aggregated host endpoint that answers the configured set.** A new host
surface for facts two existing endpoints already carry, plus a wire shape to
keep current, when the page needs a snapshot rather than a contract.

**Keep every card and collapse it visually.** The page would still read as
eleven providers, which is the problem: the reader cannot tell which ones matter
without expanding each.

**Read usage for every configured provider when the page opens.** One
likely-unused read per configured provider on a page a reader may open only to
collapse a row. The readings appear where the spec puts them — on expansion.

## Consequences

The page's claim about "configured" is only as current as its last successful
read. A provider configured outside DSH — an Ollama base URL set in the profile
rather than on this page — has no row, because the row is derived from the
stored connection document; the deployment default is not the page's fact to
report.

The roster's rows are derived in `src/client/provider-roster.ts` and rendered by
`src/client/ProviderRoster.tsx`, which holds no state. Its detail for one
OAuth-session provider is a function the page calls during render
(`OAuthProviderDetail`), so the existing component tests keep seeing the account
row inside the page's tree; the Cursor, Ollama, and key-managed details are hook
components mounted as children, and their tests mount them directly.

An unconfigured provider is one expansion away in the add form, which also marks
what is already configured — so the page lost a card per unused provider without
losing the way to find it.

The rows and the details share one refresh: a credential saved or removed inside
an expanded row, and a key the route later accepts, report back to the page,
which re-reads the configured set. Without that report a row would outlive the
key it describes, which is the one way this page can lie. A rejected key's mark
is still session-local — no read exposes a key's validity — so it is dropped
only when the route itself accepts the key or the row leaves the roster.
