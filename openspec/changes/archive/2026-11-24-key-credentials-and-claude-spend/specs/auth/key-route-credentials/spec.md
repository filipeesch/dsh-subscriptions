# Spec Delta

## Purpose

Lets a person configure the credential a key-based route authenticates with from
the Settings card, stating where the key already comes from and never exposing
its value.

## ADDED Requirements

### Requirement: Credential origin is stated

Each key-based route's Settings card SHALL state whether the route's credential
reference currently resolves and, when it does, which source layer supplies it:
the DSH store, the process environment, or a project or user environment file.
The card SHALL state a masked preview of a stored value when the host reports
one, and SHALL otherwise state the origin without any part of the value.

#### Scenario: Key stored in DSH

- **WHEN** the reference resolves from the DSH credential store
- **THEN** the card states the stored origin and, when the host reports one, the
  masked preview

#### Scenario: Key from the environment

- **WHEN** the reference resolves from the process environment or an environment
  file
- **THEN** the card states that origin, without a preview

#### Scenario: Key absent

- **WHEN** the reference resolves to nothing
- **THEN** the card states that the route has no key and offers the field

#### Scenario: Host without a masked preview

- **WHEN** the host reports no masked preview for a stored value
- **THEN** the card states the stored origin alone

### Requirement: The card writes its own route's credential

The card SHALL offer saving, replacing, and clearing the key of the route it
belongs to, addressing that route rather than a free-form reference. The host
SHALL resolve the reference from the route's effective configuration and SHALL
refuse a route the plugin does not serve. No response SHALL carry the stored
value.

#### Scenario: Save a key

- **WHEN** the person submits a non-empty value for a served key route
- **THEN** the host stores it under that route's effective reference and the
  card states the stored origin

#### Scenario: Replace a key

- **WHEN** a key is already stored and the person submits another
- **THEN** the stored value is replaced and the previous one is no longer
  resolved

#### Scenario: Clear a key

- **WHEN** the person clears the route's key
- **THEN** the host removes the DSH copy, and the card states that an
  environment source still supplies one when it does

#### Scenario: Empty value rejected

- **WHEN** the submitted value is empty
- **THEN** the request is refused and the stored key is unchanged

#### Scenario: Unserved route rejected

- **WHEN** the request names a route the plugin does not serve
- **THEN** the request is refused and no credential is read or written

#### Scenario: Value never returned

- **WHEN** any of the card's credential requests complete
- **THEN** the response carries presence, origin, writability, and at most the
  host's masked preview, never the value

### Requirement: Operator-controlled references only

The host SHALL only manage a reference fixed by operator configuration. A route
whose reference comes from a setting the browser can rename SHALL be refused,
reading and writing nothing, because following that name would aim the surface
at any credential the host knows. A refusal SHALL NOT repeat the configured
reference value, any stored value, or provider text.

#### Scenario: Operator reference manageable

- **WHEN** the route's reference comes from the profile or a built-in default
- **THEN** describe, save, and clear are served for that route

#### Scenario: Browser-renamable reference refused

- **WHEN** the route's reference comes from a card-editable setting
- **THEN** every credential request for that route is refused without reading or
  writing any credential

#### Scenario: Malformed reference

- **WHEN** the configured reference is not a valid reference name
- **THEN** the refusal names the route and never repeats the configured value

#### Scenario: Provider refusal

- **WHEN** the credential provider refuses a write or a read
- **THEN** the failure states a fixed sentence and no provider text

### Requirement: A saved key is validated

Saving a key SHALL run the route's own read — catalog discovery for a model
route, model listing where the route serves a stored catalog — and the card
SHALL report the outcome. A failed validation SHALL leave the key saved and
state the failure on the card.

#### Scenario: Valid key

- **WHEN** the saved key is accepted by the route's read
- **THEN** the card reports the route as configured and shows the read's result

#### Scenario: Invalid key

- **WHEN** the route's read rejects the saved key
- **THEN** the card reports the failure and the key remains stored for
  correction or removal, and the reported sentence carries no provider text

#### Scenario: Validation observes the saved key

- **WHEN** a read started before the save is still in flight
- **THEN** the validation reads again with the stored key instead of joining the
  earlier read

### Requirement: A stored credential only reaches the configured destination

A model listing SHALL spend the host-resolved credential only when the address
it lists matches the operator-configured base URL. Any other address SHALL
require a key supplied with that request, because the base URL is also
card-editable and a stored credential must not be sent to an address the browser
chose.

#### Scenario: Configured destination

- **WHEN** the card lists models from the operator-configured address without a
  key
- **THEN** the host-resolved key authenticates the request

#### Scenario: Another destination

- **WHEN** any request would spend the stored key at another address
- **THEN** it is refused and no credential leaves the host; a key typed for an
  explicit listing at that address is used instead

#### Scenario: The address changes while a key resolves

- **WHEN** a settings save moves the address between the key read and the
  request
- **THEN** the request is built from the snapshot taken together, so the key
  never reaches the new address

#### Scenario: Address saved from the card

- **WHEN** the card saves an address other than the configured one
- **THEN** the status and usage reads report the route as unconfigured, the
  settings view states the stored key is idle, and no request carries it

### Requirement: A malformed configured name is not printed back

A settings read SHALL omit a configured reference that is not a reference name,
because such a value may be a secret someone pasted into configuration, and a
status lookup SHALL treat that name as unconfigured instead of raising an error
that quotes it.

#### Scenario: Pasted secret as a reference

- **WHEN** configuration holds a value that is not a reference name
- **THEN** the settings read reports no reference and the status lookup reports
  the route as unconfigured, with no value in either reply

### Requirement: A committed write is reported as committed

A save or a removal SHALL report whether the store write landed. When the state
read back after it fails, the response SHALL report the committed write and an
unread state rather than a failed operation, so a saved key is not written
again.

#### Scenario: Write lands, state unreadable

- **WHEN** the store write commits and the following describe fails
- **THEN** the response reports the commit with the state unread, and the card
  states that the key was saved or removed without its state, re-reads the
  state, and keeps the controls locked until it answers

#### Scenario: Notification fails

- **WHEN** the change notification after a commit throws
- **THEN** the response still reports the commit, and the card's refresh is left
  to its own read

#### Scenario: Write not committed

- **WHEN** the response reports that the store write did not land
- **THEN** the card reports the failure instead of presenting the key as saved

### Requirement: Validation is bound to the committed credential

A validation SHALL name the generation of the committed credential it checks and
SHALL NOT carry a value. The host SHALL record, with that generation, the
reference and a host-only digest of the committed value, and SHALL refuse to
answer when the generation, the reference, or the digest has changed — a
Settings save can move the reference without writing the credential, and the
same value can be committed again in a later generation. It SHALL resolve and
verify the committed credential once, hand that value to the route's read, and
re-check the generation and identity after the read. A superseded validation
SHALL be reported as its own outcome, never as a pass or a failure of this
writer's key.

The route's read SHALL run on the host, so a provider's error text cannot reach
the browser, and SHALL spend the value it was handed: a read that resolves the
stored credential again, joins a read made with another value, or treats an
absent value as a successful empty reply SHALL NOT be used. That read SHALL
leave no lasting effect — it SHALL NOT warm the provider, publish a catalog, or
forget a remembered tier — because it can be superseded after it was already
spent.

#### Scenario: Another writer replaces the key

- **WHEN** a validation names an older generation
- **THEN** the answer is superseded, with no read and no verdict

#### Scenario: The key changes during the read

- **WHEN** the generation moves while the route's read runs
- **THEN** the answer is superseded and the outcome is not reported as success

#### Scenario: A caller pairs the wrong value

- **WHEN** a validation request tries to name its own key
- **THEN** no such request is served: the host always reads the committed one

#### Scenario: The reference moves in Settings

- **WHEN** a Settings save changes the route's reference after a commit
- **THEN** that generation answers superseded, without running the route's read

#### Scenario: A route read with the wrong credential

- **WHEN** a validation read would reuse the stored credential, a cached result,
  or an empty reply
- **THEN** that read does not count: the validation spends the verified value
  and an empty catalog is a failure

#### Scenario: A superseded validation leaves nothing behind

- **WHEN** a validation is overtaken while its provider read runs
- **THEN** the read warms nothing, publishes no catalog, and forgets no
  remembered tier

#### Scenario: The same value is committed again

- **WHEN** a later commit stores the value an earlier generation validated
- **THEN** the earlier generation answers superseded, because a verdict belongs
  to the write it checked

#### Scenario: A clear is overtaken by a save

- **WHEN** a save commits while a removal is still resolving its fallback
- **THEN** the removal publishes no identity for the newer generation, and the
  saved credential validates

### Requirement: A value that cannot ride a header is refused

A credential value carrying control characters SHALL be refused before it is
stored or spent — on a save, on a listing, on every usage read, and on a token a
provider exchanges for it — because a transport error that quotes such a header
would carry the value. A transport failure inside a usage read SHALL be reported
as a fixed sentence, so no header value can reach the reply, and cancellation
SHALL be decided by the caller's signal rather than by the failure's shape. A
listing failure SHALL be reported as a fixed sentence; the provider's message
stays out of the reply.

#### Scenario: Control characters

- **WHEN** a submitted or stored value contains a control character
- **THEN** the request is refused, no header is built, and no request is
  attempted

#### Scenario: Listing failure

- **WHEN** the provider answers with an error or the transport fails
- **THEN** the reply states a fixed sentence and no provider text

### Requirement: A renamed reference reaches the field

The card SHALL reload the credential field when the route's effective reference
changes, so the field never edits one reference while stating another.

#### Scenario: Reference changes

- **WHEN** the route's effective reference changes while the card is open
- **THEN** the field reloads and states the new reference

### Requirement: Writes reach the next read without a restart

A save or clear SHALL be visible to the next usage read and the next model
listing of that route, without restarting the host.

#### Scenario: Usage follows the new key

- **WHEN** a key is saved and the route's usage is read again
- **THEN** the read uses the new key rather than a previously cached reading

#### Scenario: Cleared key unconfigures the route

- **WHEN** the stored key is cleared and nothing else supplies the reference
- **THEN** the route and its card report the key as absent

### Requirement: Only key-based routes carry the field

OAuth-session providers SHALL keep their existing account controls and SHALL NOT
show the credential field.

#### Scenario: OAuth provider card

- **WHEN** the settings page renders an OAuth-session provider
- **THEN** its card shows sign-in and account controls only
