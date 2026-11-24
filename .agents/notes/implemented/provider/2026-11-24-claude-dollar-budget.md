# Agent Note: The Claude dollar budget on the usage reading

Status: implemented

## Problem

Claude's quota reader modelled only the plan: the short session window, the
weekly window, and the model-scoped weekly lanes. An enterprise seat reports
none of them — every plan bucket is null and the structured limits list is empty
— and states its ceiling and spend in a spend block beside a flat extra-usage
block. The card answered "no usage reported" for an account that was, in fact,
metered by a dollar budget. The same payload publishes the weekly OAuth-apps
lane, which the reader ignored, so the card listed one lane fewer than the
provider's own usage screen.

A live read of the endpoint by the account owner (2026-11-24) fixed the shapes:
the spend block carries each amount with its own exponent and currency plus the
share it computed, the flat block carries one decimal count for both amounts,
and the plan buckets were null. Nothing about that payload is a published
contract.

## Decision

The reader turns the budget into one money window, appended after the plan
windows. The spend block is authoritative when present: a disabled budget is
disabled, and a value it states but cannot support — an unusable spend, a
negative or non-numeric ceiling — drops the window rather than becoming a
spend-only row or being replaced by the flat block that describes the same
budget in an older shape. The flat block answers only when the spend block omits
the spend entirely. A ceiling it reports as zero stays zero, and a ceiling
stated in another currency is dropped rather than divided.

Amounts are normalized to the shared window's minor unit by dividing by the
declared exponent rather than by assuming a scale; the fallback of two decimals
is the shape observed live. The share comes from the percentage the endpoint
reported and falls back to spent-over-ceiling; the remaining amount is the one
the endpoint reported or the ceiling minus the spend, never negative and never
invented. The window carries no reset time because the endpoint discloses none,
so it draws no pace cursor.

The window goes last so the footer bar — which states the reading's first window
— keeps stating plan quota when the account reports both. It keeps the shared
colors, because for the enterprise shape it is the only quota there is.

When a reading carries a window but the payload reported no session and no
weekly window, the reading sets `planWindowsAbsent` and the card states it in
one line, gated on a money row being present. A reading with no window at all
keeps the empty state and clears the flag, so "no usage reported" and "no plan
window reported" stay apart. That is a fact only the reader can assert: the
client would have to infer it from window kinds that legitimately lack a plan
window.

The OAuth-apps bucket is mapped as its own weekly lane, scoped by name so it
stays distinguishable from the all-models weekly window.

## Alternatives considered

- **Assume the amounts are cents and skip the exponent.** The live read declares
  the exponent explicitly, and a plan may declare another one; ignoring it would
  misreport a decimal-scaled payload by powers of ten.
- **Assume the amounts are dollars and multiply by a hundred.** The live read
  already reported minor units, so this would state a hundred times the spend.
- **Read only the flat extra-usage block.** It is the older shape: one decimal
  count for both amounts, no per-amount currency, no computed share. Reading it
  as the fallback keeps an older payload working; reading it first would drop
  the unit the spend block declares.
- **Treat an unusable ceiling as an absent one.** A spend-only row is a real
  shape (a plan that reports spend and no ceiling), so letting a drifted ceiling
  become one would present broken data as that shape. Dropping the window makes
  the card state a failed read instead.
- **Mark the money window informational — no color, no bar.** The enterprise
  shape reports nothing else, so the footer bar would stay empty for the one
  account that has a budget, and the card would show a grey row beside a red one
  on a subscription account.
- **Put the budget window first.** The footer bar states the reading's first
  window, so a subscription with overage would bar the overage cap instead of
  the plan quota the person is spending. (The collapsed pill may state more than
  one window with a count; the footer bar is the single-window surface.)
- **Infer the missing plan windows in the client.** The client sees windows, not
  the payload: an enterprise reading and a broken reading look alike once the
  payload is projected. The flag costs one optional field and states a fact the
  reader knows.

## Consequences

One reader now covers both account shapes, and the card names the case where a
seat reports no plan window instead of reading as an empty snapshot. The cost is
a normalization step that must follow whatever exponent the provider declares:
the fixtures pin two decimals, a different exponent, a disabled block, and an
unusable amount, but only a live canary can confirm the provider did not change
the scale. A shape change still fails the read rather than reporting a zero,
which the card states and chat survives.
