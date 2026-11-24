# Spec Delta

## ADDED Requirements

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
