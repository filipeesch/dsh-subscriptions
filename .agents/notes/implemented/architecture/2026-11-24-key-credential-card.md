# Agent Note: Key-route credentials in the card

Status: implemented

## Problem

A key-based route authenticates by a DSH credential reference, and the plugin
only ever read that reference. Nothing in the plugin wrote one: the Cursor card
printed a fixed sentence naming `CURSOR_API_KEY`, and the only ways to satisfy
it were exporting an environment variable or editing the credential store
outside DSH. The card could not even say whether a key was found in the
environment or in the store behind the reference. The Ollama Cloud card had the
same gap plus a one-time key field in its model dialog that was never stored.

## Decision

One credential surface serves both key routes, and the browser addresses a
**route**, never a reference: the request names `cursor` or `ollama-cloud`, and
the host resolves that route's effective reference. Only an operator-controlled
reference is served: the Cursor profile reference, or Ollama's default/profile
reference. Ollama can also take its reference from a card-editable setting, and
that one is refused, because following it would let the browser rename the
target and then read, overwrite, or delete any credential the host knows. A
pasted secret cannot even be stored as a reference: the setting validates the
reference grammar, and no refusal repeats a configured name.

The surface is a small service over the credential seam with `describe`, `set`,
and `clear`. It resolves the seam per call rather than holding it, because the
RPC is assembled before the credentials service necessarily exists and a
headless profile must answer a clear refusal instead of failing at boot. The
masked preview is read through a locally declared optional field: the supported
floor (DSH 0.1.7-rc.2) declares `CredentialInfo` without it, while the 0.2 line
reports one, so the card states the origin alone on the floor.

A save stores the value and then runs the route's own read — catalog discovery
for Cursor, model listing for Ollama Cloud. A failed read is reported on the
card with a fixed sentence and the key stays saved: undoing it would let one
transient failure discard a valid key, and the route's own error text stays out
of the browser. After a write or a removal the service notifies its owner, which
drops that source's cached usage reading and the catalog a previous credential
produced — a forced read otherwise joins the in-flight fetch started with the
old key — and re-announces the route so the picker re-lists.

A write and the state read back describe one snapshotted reference, and a
committed write whose state cannot be read is reported as committed with an
unread state instead of a failed operation, so a saved key is never written
twice in response.

One client component renders the field for both routes, and the route's
validation is passed in by the card that owns it, so the shared surface holds no
provider knowledge.

## Alternatives considered

- **Reuse the host's `credentials` Remote namespace from the client.** It ties
  the card to a host surface this plugin does not own, one headless profiles and
  older supported lines need not mount, and it has no contract here to test
  against. The plugin already owns an authenticated channel with its own tests.
- **Send the credential reference in the payload.** Any reference the host could
  resolve would become writable from the browser. Addressing a route keeps the
  writable set to the references this plugin serves.
- **Follow the route's effective reference, including a card-set one.** The
  card's connection settings are served by the same browser, so that reference
  is not an operator statement: it would turn credential CRUD into a writer for
  any name the host resolves. Refusing it costs managing a renamed reference
  from this field, which is the setting that renamed it.
- **Undo the save when validation fails.** A rejected key and a dropped
  connection look alike at that point, so a network failure would discard a good
  key. Keeping it turns the card into the place to correct it.
- **A dedicated ping per provider.** New provider surface to maintain, and it
  would prove nothing about the read the route actually performs — the catalog
  read is the thing that has to accept the key.
- **Hold the credential seam at construction.** The RPC is assembled before the
  service is guaranteed to exist; a held reference would either force assembly
  order or crash a profile that has no provider.
- **Wait for every host to report a masked preview.** The useful fact today is
  where the value comes from, which the origin states; the preview is an
  improvement the newer hosts add.

## Consequences

Configuring a key route no longer requires leaving DSH, and the two key routes
share one implementation and one set of tests. Removal is DSH-only by
construction: an environment variable keeps supplying the reference afterwards,
which the card states instead of pretending the key is gone. On the oldest
supported hosts the card cannot show a preview, so the origin line carries the
whole message. A save now costs one extra route read, bounded by the discovery
timeout the card already used.
