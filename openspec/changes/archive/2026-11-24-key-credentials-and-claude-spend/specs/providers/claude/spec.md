# Spec Delta

## Purpose

Reports the Claude subscription's plan windows and the dollar budget an
enterprise seat states, so the settings card, the footer bar, and account
selection can state the quota the provider actually reported.

## ADDED Requirements

### Requirement: Plan windows from the usage endpoint

The reader SHALL map the plan buckets the usage endpoint reports — the short
rolling session window, the weekly window, and any model-scoped weekly window —
onto usage windows with their reported share and reset time. It SHALL read the
endpoint's structured limits list when it carries usable entries, and fall back
to the flat plan buckets otherwise. A bucket that is absent, null, or unusable
SHALL be omitted rather than rendered as zero.

#### Scenario: Session and weekly windows

- **WHEN** the endpoint reports a session window and a weekly window
- **THEN** the reading carries one window of each kind with its share and reset
  time

#### Scenario: Model-scoped weekly lanes

- **WHEN** the endpoint reports a weekly lane for a model family
- **THEN** the reading carries a weekly window scoped to that family

#### Scenario: Structured list wins

- **WHEN** the structured limits list carries usable entries
- **THEN** the reading is built from it and the flat buckets are not read

#### Scenario: Unusable bucket omitted

- **WHEN** a bucket carries no usable share
- **THEN** no window is produced for that bucket

### Requirement: OAuth-apps weekly lane

The reader SHALL report the weekly bucket the endpoint publishes for OAuth
applications as its own weekly window, scoped so it stays distinguishable from
the all-models weekly window.

#### Scenario: Lane reported

- **WHEN** the endpoint reports a usable OAuth-apps weekly bucket
- **THEN** the reading carries a weekly window naming that lane

#### Scenario: Lane absent

- **WHEN** the endpoint reports the bucket as null or omits it
- **THEN** the reading carries no window for it

### Requirement: Dollar budget window

The reader SHALL report one money window for an account metered by a spend
ceiling, using the block that reports the budget and its spend. The window SHALL
carry the amount spent, the ceiling when one is declared, the remaining amount
when the endpoint reports one or both amounts are known, and the currency. The
amounts SHALL be stated in the currency's minor unit, normalized by the exponent
the endpoint declares. The share SHALL come from the percentage the endpoint
reports, and from the amounts when it reports none. A budget that is disabled,
or whose amounts are negative or not finite, SHALL be omitted rather than
rendered as zero, and the ceiling SHALL never be invented.

#### Scenario: Enterprise budget

- **WHEN** the account reports a ceiling and the spend against it
- **THEN** the reading carries one money window with used, ceiling, remaining,
  currency, and the share derived when the endpoint reports none

#### Scenario: Subscription with overage

- **WHEN** a plan reports its plan windows and an enabled overage budget
- **THEN** the reading carries both the plan windows and the money window

#### Scenario: Declared exponent

- **WHEN** the endpoint declares an amount exponent other than two
- **THEN** the amounts are normalized to the currency's minor unit before they
  reach the window

#### Scenario: Disabled budget omitted

- **WHEN** the reported budget is disabled
- **THEN** no money window is produced

#### Scenario: Unusable amounts omitted

- **WHEN** the reported spend or ceiling is negative or not finite
- **THEN** no money window is produced

#### Scenario: Spend without a ceiling

- **WHEN** the account reports spend and no ceiling
- **THEN** the window states the amount and no share is invented

### Requirement: Plan windows lead, budget follows

The reading SHALL place the money window after every plan window, so a display
that states a single window — the footer bar — keeps stating the plan quota when
the account reports both.

#### Scenario: Both shapes present

- **WHEN** the reading carries plan windows and the budget window
- **THEN** the plan session window is first and the money window is last

#### Scenario: Budget only

- **WHEN** the account reports no plan window and only the budget
- **THEN** the money window is the reading's only window

### Requirement: Reading states when no plan window was reported

When a reading carries a window but the endpoint reported no session and no
weekly window, the reading SHALL state that no plan window was reported. Such a
reading SHALL count as a successful reading and SHALL NOT be presented as "no
usage reported"; the settings card SHALL state the missing plan windows in one
discreet line. A reading that carries no window at all keeps the empty state
instead, so the two cases stay distinguishable.

#### Scenario: Enterprise account

- **WHEN** the endpoint reports no plan window and reports the budget
- **THEN** the card shows the money window and one line saying the plan windows
  were not reported

#### Scenario: Nothing usable reported

- **WHEN** the endpoint reports neither a plan window nor a usable budget
- **THEN** the reading carries no windows, states no missing plan window, and
  the card states that no usage was reported

### Requirement: Unusable and absent amounts are distinguished

An amount the payload states but cannot support SHALL drop the budget window: it
SHALL NOT become a spend-only reading, and it SHALL NOT be replaced by the older
block that describes the same budget. Only a block that omits the amount
entirely lets the next block answer. A ceiling the payload reports as zero SHALL
stay zero, without a derived share. A ceiling stated in a currency other than
the spend's SHALL be dropped rather than divided.

#### Scenario: Unusable spend

- **WHEN** the spend block states an amount that is negative or not a number
- **THEN** no budget window is produced, even when the flat block is usable

#### Scenario: Unusable ceiling

- **WHEN** the spend block states a ceiling that is negative or not a number
- **THEN** no budget window is produced

#### Scenario: Reported zero ceiling

- **WHEN** the flat block reports a ceiling of zero
- **THEN** the window carries the zero ceiling and no derived share

#### Scenario: Mixed currencies

- **WHEN** the ceiling is stated in another currency than the spend
- **THEN** the window states the spend and carries no ceiling

#### Scenario: Unusable declared scale

- **WHEN** a block declares a scale that is not a whole number within range
- **THEN** the budget window is dropped instead of assuming two decimals

#### Scenario: Block of another shape

- **WHEN** the spend or extra-usage block is present but not an object
- **THEN** the budget window is dropped instead of reading the block as absent

#### Scenario: Balance in another currency

- **WHEN** the reported balance is stated in another currency than the spend
- **THEN** the balance is ignored and the remaining amount is derived from the
  ceiling

#### Scenario: Reported share outside the range

- **WHEN** the endpoint reports a share above a hundred
- **THEN** the window carries a share clamped to a hundred

### Requirement: Freshness follows the shared reading rules

A later failed read SHALL leave the last successful reading served and marked
stale, with its observation time unchanged.

#### Scenario: Failed refresh

- **WHEN** a read fails after a successful one
- **THEN** the previous windows remain visible, marked stale
