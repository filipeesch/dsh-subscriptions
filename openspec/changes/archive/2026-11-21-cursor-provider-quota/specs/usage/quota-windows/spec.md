# Spec Delta

## Purpose

Lets a usage window carry money as well as a percentage so displays can state
spend against a ceiling without inventing a proportion.

## ADDED Requirements

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
