# Spec Delta

## MODIFIED Requirements

### Requirement: Live catalog with a known fallback

The route SHALL list the models Cursor's catalog reports for the account,
including display names and the reasoning efforts each model advertises, and
SHALL disambiguate display names shared by more than one model. It SHALL persist
the last reported catalog, SHALL seed itself from that catalog on start, and
SHALL advertise models only while the credential reference resolves to a
non-empty key.

#### Scenario: Live catalog

- **WHEN** the catalog read succeeds
- **THEN** the picker lists exactly the reported models with their advertised
  reasoning efforts and the route persists the catalog for later runs

#### Scenario: Shared display name

- **WHEN** two reported models carry the same display name
- **THEN** each label appends its model id so the entries stay distinguishable

#### Scenario: Catalog unavailable

- **WHEN** the catalog cannot be read and no catalog was persisted
- **THEN** the route offers a built-in list of known model ids and retries the
  live catalog on a later read

#### Scenario: Restart seeded from the persisted catalog

- **WHEN** the plugin starts with a persisted catalog and a key that resolves
- **THEN** the route lists the persisted models before a live read completes and
  refreshes them in the background

#### Scenario: Discovery failure after a persisted read

- **WHEN** the catalog cannot be read and a catalog was persisted
- **THEN** the route keeps serving the persisted models instead of the built-in
  list

#### Scenario: Key missing

- **WHEN** the configured credential reference resolves to nothing
- **THEN** the route lists no models even when a catalog was persisted

### Requirement: Context tier and reasoning mapping

The route SHALL request a context tier for every model that offers one, SHALL
advertise the capacity of the tier it actually requests, and SHALL map DSH's
selected reasoning effort onto the Cursor parameters the model advertises. The
tier SHALL default to the largest offered and SHALL be selectable globally and
per model.

#### Scenario: Maximum context advertised

- **WHEN** a model reports several context tiers and nothing else selects one
- **THEN** the resolved model advertises the largest tier's capacity and the
  request carries that tier

#### Scenario: Configured tier advertised

- **WHEN** configuration or per-model settings select an offered tier
- **THEN** the resolved model advertises that tier's capacity and the request
  carries it

#### Scenario: Effort mapping

- **WHEN** a model advertises effort values and DSH selects a level
- **THEN** the request carries the closest advertised value, or reasoning is
  turned off when the model allows it

#### Scenario: Tier rejection

- **WHEN** Cursor rejects the chosen context tier and the run emitted nothing
- **THEN** the route retries once with the next smaller offered tier, reuses
  that tier for later runs of the same model, and advertises the accepted tier's
  capacity

#### Scenario: Accepted tier remembered across restarts

- **WHEN** a tier was accepted after a rejection and the plugin restarts with
  the same preference
- **THEN** the route requests the accepted tier and advertises its capacity
  instead of the rejected one

#### Scenario: Accepted tier withdrawn

- **WHEN** the catalog no longer offers the remembered tier
- **THEN** the route forgets it, requests the configured tier, and advertises
  that tier's capacity

## ADDED Requirements

### Requirement: Published context capacities

When a listed model's catalog entry offers no context tier and no manual window
is set, the route SHALL advertise the capacity the public models.dev catalog
publishes for that model. It SHALL project only the ids Cursor currently lists,
SHALL prefer the capacity the model's own vendor publishes when candidates
disagree, and SHALL keep the last successful projection when a refresh fails. A
refresh SHALL run outside the request path, and no request SHALL wait for the
network.

#### Scenario: Advertised from the public catalog

- **WHEN** a listed model offers no context tier, no manual window is set, and
  the projection describes the model
- **THEN** the resolved model advertises the published capacity

#### Scenario: Projection follows the listed ids

- **WHEN** the public catalog describes models Cursor does not list
- **THEN** the projection keeps only capacities for the ids Cursor lists

#### Scenario: Disagreement between entries

- **WHEN** entries from several providers describe one model with different
  capacities
- **THEN** the entries published by the model's own vendor win, and the value
  most of those entries declare wins among them

#### Scenario: Refresh failure

- **WHEN** a refresh fails after a successful projection
- **THEN** the route keeps advertising the previous capacities and the failure
  does not fail a request

#### Scenario: Cold start

- **WHEN** the plugin starts before any projection exists
- **THEN** model listing and resolution proceed without waiting for the fetch

#### Scenario: Source disabled

- **WHEN** the published-capacity source is disabled
- **THEN** no fetch runs and a model with no tier and no manual window
  advertises the default capacity

#### Scenario: Source state on the card

- **WHEN** the Cursor card renders
- **THEN** it states whether the published-capacity source is on, when it last
  refreshed, and offers a control to refresh it now

#### Scenario: Manual refresh

- **WHEN** the card requests a refresh
- **THEN** the route fetches the public catalog out of band and the card then
  reflects the new refresh time, or the retained previous projection when the
  fetch failed

### Requirement: Manual context window

The route SHALL accept a manual window per model, stored with the route's
settings and supplied as a baseline by the plugin configuration, and SHALL use
it only when the model offers no context tier and the public catalog does not
describe the model. A stored value SHALL win over the configuration for the same
model.

#### Scenario: Manual value used

- **WHEN** a model offers no tier, the public catalog does not describe it, and
  a manual window is set
- **THEN** the resolved model advertises the manual value

#### Scenario: More authoritative sources win

- **WHEN** a model offers a context tier or the public catalog describes it, and
  a manual window is also set
- **THEN** the resolved model advertises the tier or the published capacity
  instead of the manual value

#### Scenario: Settings over configuration

- **WHEN** the stored settings and the configuration both set a manual window
  for one model
- **THEN** the stored value is advertised

#### Scenario: Invalid stored value

- **WHEN** a stored or configured manual window is not a positive integer
- **THEN** the route ignores it and resolves the model through the remaining
  sources

### Requirement: Per-model settings and enablement

The route SHALL persist per-model settings — enablement, context tier, and
manual window — SHALL accept a configuration baseline for each, and SHALL offer
them on the Cursor card. A stored setting SHALL win over the configuration for
the same field, and a saved change SHALL apply without a plugin restart.

#### Scenario: Disabled model leaves the picker

- **WHEN** a model is disabled in the settings
- **THEN** the route stops listing it in the picker, and a saved conversation
  that selected it still resolves the model

#### Scenario: Configuration baseline

- **WHEN** the configuration sets a model's enablement, tier, or window and the
  settings carry no value for that field
- **THEN** the route applies the configured value

#### Scenario: Settings override the baseline

- **WHEN** the settings and the configuration set different values for one field
- **THEN** the route applies the stored value

#### Scenario: Settings survive a restart

- **WHEN** the plugin restarts after a settings save
- **THEN** the route applies the saved enablement, tier, and windows

#### Scenario: Model manager shows the resolution

- **WHEN** the Cursor card's model manager opens
- **THEN** each listed model shows its resolved window, where that window came
  from, and the controls for enablement, tier, and manual window

#### Scenario: Corrupt settings

- **WHEN** the stored settings document is unreadable or invalid
- **THEN** the route falls back to the configuration baseline and the defaults
  without failing the route
