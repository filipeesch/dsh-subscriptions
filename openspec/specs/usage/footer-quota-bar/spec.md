# usage/footer-quota-bar Specification

## Purpose

Shows, in the composer footer, how much of the selected model provider's
subscription quota is spent, with the numbers available on hover and in the
existing usage dialog.

## Requirements

### Requirement: One bar after the context gauge

The composer footer SHALL show at most one quota bar, placed after the context
gauge, for the provider of the selected model when that provider reports usage.
The bar SHALL be offered for Claude, Codex, and Cursor.

#### Scenario: Supported provider selected

- **WHEN** the selected model belongs to Claude, Codex, or Cursor and that
  provider reports usage
- **THEN** the footer shows the bar after the context gauge

#### Scenario: No usage to show

- **WHEN** the selected model's provider reports no usage, has no credential, or
  the read failed
- **THEN** no bar appears

#### Scenario: Other providers

- **WHEN** the selected model belongs to any other provider
- **THEN** no bar appears

### Requirement: Only the bar is always visible

Without interaction the footer SHALL show the bar and the provider's identity
only; no numeric value SHALL be persistently visible.

#### Scenario: No persistent numbers

- **WHEN** the bar renders
- **THEN** no percentage or monetary figure is displayed until the user hovers
  or opens the dialog

### Requirement: The selected model's account

The bar SHALL reflect the account the selected model is bound to, and the
provider's default account when the selection names none.

#### Scenario: Model bound to one account

- **WHEN** the selected model id names an account
- **THEN** the bar shows that account's usage

#### Scenario: Model without an account binding

- **WHEN** the selected model is not bound to an account
- **THEN** the bar shows the provider's default account

### Requirement: Hover reveals the numbers

Hovering the bar SHALL reveal the used and remaining share, or the amount used,
ceiling, and remaining when the window carries money, plus the reset time when
the provider discloses one.

#### Scenario: Percent window

- **WHEN** the window carries a percentage
- **THEN** the tooltip states the used share, the remaining share, and the reset
  time when known

#### Scenario: Monetary window

- **WHEN** the window carries amounts
- **THEN** the tooltip states the amount used, the ceiling, and the remaining
  amount

#### Scenario: No reset time

- **WHEN** the provider discloses no reset time
- **THEN** the tooltip omits that line rather than naming a fabricated time

### Requirement: Click opens the full dialog

Activating the bar SHALL open the existing usage dialog that lists every
provider and account reporting usage.

#### Scenario: Dialog opens

- **WHEN** the user activates the bar
- **THEN** the usage dialog opens with all reporting providers and accounts

### Requirement: Fill and color describe usage

The bar fill SHALL represent the used share of the window and SHALL follow the
existing quota colors: green below the pace threshold, orange when used leads
elapsed time by the configured margin, and red at 90 percent or more. A stale
reading SHALL keep its last color and be marked stale.

#### Scenario: High usage

- **WHEN** the used share reaches 90 percent
- **THEN** the bar is red regardless of elapsed time

#### Scenario: Usage ahead of time

- **WHEN** the used share leads elapsed time by the configured margin but stays
  below 90 percent
- **THEN** the bar is orange

#### Scenario: Stale reading

- **WHEN** the last reading is stale
- **THEN** the bar keeps its last color and the tooltip marks the reading stale

### Requirement: Preference affects numbers only

The tooltip values SHALL follow the existing used-or-remaining preference, while
the fill and color always describe usage.

#### Scenario: Remaining preference

- **WHEN** the preference asks for remaining values
- **THEN** the tooltip leads with the remaining share and the fill still shows
  usage
