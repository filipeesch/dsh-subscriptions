# usage/quota-windows Specification

## Purpose

Lets a usage window carry money as well as a percentage so displays can state
spend against a ceiling without inventing a proportion.

## Requirements

### Requirement: Monetary amounts on usage windows

A usage window SHALL be able to carry an amount used, a limit, a remaining
amount, and a currency alongside its percentage.

#### Scenario: Amounts without a percentage

- **WHEN** a provider reports an amount used and a limit above zero
- **THEN** the window's percentage is derived from used over limit and the
  displayed numbers come from the amounts

#### Scenario: Amounts without a limit

- **WHEN** a provider reports an amount used and no limit
- **THEN** the window carries the amount without a percentage and renders no
  proportion

### Requirement: Percent-only providers unaffected

A provider that reports only percentages SHALL produce the same windows it
produced before monetary amounts existed.

#### Scenario: Existing provider unchanged

- **WHEN** a provider reports percent windows only
- **THEN** its windows carry no monetary fields and every existing display
  renders as before

### Requirement: Freshness applies to amounts

A monetary reading SHALL follow the same observation-time, cache, and stale
rules as a percent reading.

#### Scenario: Stale reading keeps values

- **WHEN** a refresh fails after a successful monetary reading
- **THEN** the previous amounts remain visible, the reading is marked stale, and
  the observation time stays at the successful read

### Requirement: No fabricated values

A window whose amount is negative or not finite SHALL be omitted rather than
rendered as zero.

#### Scenario: Invalid amount omitted

- **WHEN** a provider returns a negative or non-numeric amount
- **THEN** that window is absent from the result

### Requirement: Window rows state what the window carries

Every settings card that lists usage windows SHALL state, for each window, the
amounts the window carries when it carries any, and the share otherwise. A
window that carries amounts SHALL state the amount spent, the ceiling when the
window carries one, and the remaining amount when the window carries one, all in
the window's currency; a remaining amount of zero SHALL be stated. A window that
carries an amount and no ceiling SHALL state the amount and that its share is
unknown; a window that states a ceiling SHALL NOT claim its share is unknown,
even when no proportion can be derived from that ceiling. A window whose
provider declares no currency SHALL still state its amounts, naming the unit as
unreported instead of hiding the numbers. A window that carries neither SHALL
state that its share is unavailable.

#### Scenario: Money row

- **WHEN** a card lists a window carrying an amount, a ceiling, and a remaining
  amount
- **THEN** the row states the amount spent, the ceiling, and the remaining
  amount in the window's currency

#### Scenario: Money without a ceiling

- **WHEN** a card lists a window carrying an amount and no ceiling
- **THEN** the row states the amount and that the share is unknown

#### Scenario: Stated zero ceiling

- **WHEN** a card lists a window whose ceiling is zero
- **THEN** the row states the zero ceiling and does not claim the share is
  unknown

#### Scenario: Percent row

- **WHEN** a card lists a window carrying only a share
- **THEN** the row states the share the used-or-remaining preference selects

#### Scenario: Stale row

- **WHEN** the reading behind a row is stale
- **THEN** the row marks the reading stale and keeps the last reported numbers

### Requirement: One label per window

The window row SHALL label a session or weekly window by its kind plus its scope
when it names one, and SHALL label a window of another kind by its scope alone,
so a provider-named lane is not prefixed with a generic kind.

#### Scenario: Scoped weekly window

- **WHEN** a weekly window names a model family
- **THEN** the row reads as the weekly kind followed by that family

#### Scenario: Provider-named lane

- **WHEN** a window names a lane that is neither a session nor a weekly kind
- **THEN** the row reads as that lane alone
