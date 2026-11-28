# Agent Note: The add-provider form

Status: implemented

## Problem

Adding a provider meant finding that provider's card among eleven and pressing
whichever button it offered: sign in, paste a key, fetch a device code, or check
a key that Settings → Models owns. Nothing named the providers this plugin
serves, so a reader could not tell what was addable, and the page could not say
which ones were already configured.

## Decision

The **+ Add provider** action opens one form in place of the roster. A single
selector lists all eleven providers by display name, marks the configured ones,
and refuses them — a further account belongs to that provider's row, not to a
second entry here. Choosing a provider reveals its own fields below the selector
without navigating, writing, or starting anything; the footer carries Cancel and
one primary action named for that provider: Continue in browser, Get device
code, Save, Check again, or Save address.

The OAuth attempt stays the page's, and the form owns which attempt is its own.
It asks the page to start the attempt, remembers the provider it started, and
reads the page's status, device code, terminal `detail`, and error state from
that attempt only — a provider whose status happens to hold an account cannot
confirm an attempt this form never started. The selector locks while an attempt
or a save runs, so a choice cannot abandon work in flight; a cancel that lands
while the start request is still unanswered cancels the attempt as soon as it
answers; and an abandoned form's late save verdict is dropped instead of closing
a later form. The form reports back rather than closing itself: only a
confirmation the route reported becomes a row, and the page marks that provider
configured until the next successful read reconciles it — a failed read must not
swallow a provider the route just confirmed.

The add flow always asks for browser authorization, so Claude's sign-in cannot
silently import an existing CLI credential instead of opening the browser.

Every control the form adds takes the design kit's 44 px touch size, scoped to
the form's own class so the older detail controls keep their compact geometry.
The footer keeps one right-aligned row and wraps only when the labels need it,
which is what the approved frames show at 390 px. A submitted action is
announced and painted as unavailable through `aria-disabled` rather than
`disabled`: disabling a focused button hands focus to the page body, so a reader
who submitted from the keyboard would lose their place mid-save.

Both ways out of the form hand focus back to the roster heading. The form
unmounts while the reader's focus is inside it, so without that handoff a
keyboard reader lands on the page body — on a cancel as much as on a
confirmation. `scripts/manual/focus-flow-proof.mjs` mounts the shipped page
against a fake RPC and drives it with real mouse and key input, which is how the
handoff is checked: a still cannot show focus moving.

Key routes save through the existing credential endpoints — `keySetCredential`
then `keyValidateCredential` — and a key the route rejects stays saved, with the
form stating that it must be corrected and the roster marking the provider as
needing attention when the reader leaves it. Verdicts are keyed per provider,
not held in one flag: a rejected Cursor key survives a switch to another route,
and every exit from the form — cancel or any confirmation — hands the page the
verdicts still outstanding, so closing the form cannot lose one. Key-managed
routes are only checked through `externalStatus`: their key belongs to Settings
→ Models, so the form names the reference and never writes one.

The Ollama address is written by re-sending the whole stored document, read
fresh immediately before the write, with a new `baseURL`. The host store
replaces rather than merges, so a one-field write would drop the saved model
list and the credential reference, and reusing the page's earlier snapshot could
overwrite a change saved elsewhere while this page was open. The Cloud key
travels through the credential field's route instead. Saving an address is not a
connection: the form states before the save that reachability is not checked,
and the row that follows states that an existing Cloud key is idle there, which
is the policy the host already enforces for every request that would spend it.

## Alternatives considered

**One component per provider, or a wizard that replaces the form as the choice
changes.** Eleven components and eleven copies of cancel, failure, and
confirmation handling; a wizard also loses the review's requirement that the
selector and the chosen provider's fields live in one form and return to the
roster only on success or cancel.

**A new "add provider" host endpoint.** It would duplicate five write paths and
their credential rules — including the generation binding and destination policy
the credential service already enforces — for a caller that is the same page.

**Reuse `KeyCredentialField` inside the form.** That component brings its own
submit button, origin line, and remove action, which would compete with the
footer's one primary action and offer removal for a provider that has no row
yet. The form keeps its two-call save sequence instead, and the card keeps the
field.

**Write the address as a partial settings patch.** The store replaces the whole
document, so a patch would silently clear the model list, the web switch, and a
renamed reference.

## Consequences

A rejected key's "needs attention" mark is session-local. No status read exposes
whether a saved key is usable — `externalStatus` reports that the reference
resolves — so the roster can only remember the verdict this form obtained. After
a reload the provider reads as configured until its next validation.

The form's own key save repeats part of `KeyCredentialField`'s sequence: the
commit check, the generation handoff, and the three outcomes. The duplication is
two calls and one branch, and it is what keeps the footer's single primary
action possible; the card remains the place with origin, replace, and remove.

Saving an address needs the settings document, so the form depends on the same
read that decides the rows; it is unreachable while the configured set is
unknown, which is also why the add action is withheld in the checking and failed
states.
