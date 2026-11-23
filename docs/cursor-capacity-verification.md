# Cursor capacity and manager verification

Verified on 2026-11-23 on the change that made the published-capacity source
read the document it is given, moved a manual window above the published
estimate, dropped the context tier preference, and rebuilt the model manager.

## The defect, measured

The live `https://models.dev/api.json` document read on this date carried 10 211
model entries across 326 providers. The previous structure check required every
entry to declare a usable `limit.context`, and 154 entries — image, speech, and
transcription models such as `gpt-image-2`, `whisper-1`, and `step-tts-2` —
declare `0`. Because the check walked every nested entry, one of those failed
the whole refresh:

- `isPublishedCatalogDocument` returned `false` for the document, so the refresh
  reported "a document this projection cannot read";
- no snapshot was ever written:
  `~/.dsh/plugins/subscriptions/cursor-context-windows.json` did not exist,
  while `cursor-catalog.json` and `cursor-settings.json` did;
- every Cursor model whose catalog entry offers no context tier therefore
  advertised the generic 200 000-token window.

## The live refresh after the change

The shipped `PublishedContext` service was run against the live endpoint with
the ids from this machine's stored Cursor catalog. It fetched, projected, and
persisted a snapshot:

```text
outcome: {"status":"refreshed","fetchedAt":1795435878948,"windows":23}
warnings: (none)
```

The eleven models that advertise no context tier resolved as follows, with a 200
000 default applying where the public catalog describes nothing:

| Cursor model              | Advertised window | Source                   |
| ------------------------- | ----------------- | ------------------------ |
| `deepseek-v41-flash-1017` | 1 048 576         | models.dev               |
| `kimi-k3`                 | 1 048 576         | models.dev               |
| `gemini-3.8-flash`        | 1 048 576         | models.dev               |
| `gemini-3-flash`          | 1 048 576         | models.dev               |
| `grok-4.6`                | 500 000           | models.dev               |
| `glm-5p3`                 | 1 048 573         | models.dev (a gateway)   |
| `glm-5p3-flash`           | 1 048 573         | models.dev (a gateway)   |
| `composer-2`              | 200 000           | default                  |
| `composer-2.5`            | 200 000           | default                  |
| `auto-smart`, `default`   | 200 000           | default (router aliases) |

`glm-5p3` keeps a gateway's value because Cursor spells the model's own id
differently from the vendor (`glm-5.3`); the manager's manual override is the
stated correction for that row rather than a second source of truth.

## Configuration keys after the change

The host's configuration schema does not reject or strip a key the plugin no
longer declares: parsing a profile that still sets `cursor.context` and
`cursor.models[].context` returns those values in the parsed configuration, so
an existing profile loads unchanged and the values simply stop selecting a tier.
No deprecation shim is needed.

## Automated validation

- `pnpm test`: 1 361 tests, 1 360 passed, 1 skipped by design, 0 failed. The
  Cursor specs cover the document shape against a zero-capacity entry, the
  projection, the resolution order with a manual value above a published one, a
  legacy settings document, the tier request and its step-down, the derive
  functions, every rendered row state, and the autosave, debounce, revert, and
  source flows through a mounted dialog with a fake RPC.
- `pnpm lint`: clean, no warnings.
- `pnpm format:check`: clean.
- `node scripts/verify-agent-notes.mjs`: 25 notes checked, all conform.
- `npx --yes markdownlint-cli2@0.22.0`: 0 errors.
- `pnpm build`: TypeScript checking and the client bundle pass; the client
  bundle is 310.75 kB (76.17 kB gzip).

## Review captures

`scripts/manual/cursor-screens.mjs` renders the shipped presentational
components against fixture data into `.cache/cursor-screens` (gitignored):
`card-source-on-en`, `card-source-off-en`, `card-source-failed-en`,
`manager-en`, `manager-manual-override-en`, `manager-editing-en`,
`manager-failed-write-en`, `manager-filter-empty-en`, `manager-source-off-en`,
`manager-source-failed-en`, `manager-zh-narrow`, and `card-source-zh-narrow`.

The failed-write capture is what changed the row layout: the failure text was a
flex item of the row and squeezed the model name, so the row now wraps its error
onto its own line. The captures do not prove the mounted dialog's focus
behavior, its scroll behavior, or a refresh inside a running host.

## What the review round changed

The first review reproduced a regression in the new manager and this round fixed
it. The page seeds its map from the stored document the read carries, so the
first autosave keeps every model it did not touch — including one the catalog no
longer lists — and a reset can clear an override that came from the document.
Writes are queued as changes applied to the last acknowledged map, so a refused
change never rides along on the next successful one, and a read settles the
queue before it fetches, so a Reload cannot describe a document older than the
save that preceded it. Closing the dialog writes a window the reader just typed.

The accepted-tier record is normalized on every validation, so a save over a
document that predates the compatibility field still writes a document an older
build can read. The chip carries its source as text a screen reader reads, not
as an `aria-label` on a static span, and the invalid field points at its own
error. The orphaned save and cancel strings are gone from both dictionaries, and
the card's capture no longer shows a failure state the card cannot render.

## Not verified here

- The dialog inside a running DSH with a real Cursor account: pressing **Refresh
  now**, storing an override, and switching the source off are covered by the
  mounted dialog with a fake RPC, not by the host. That check remains with the
  operator.
- How the host prices compaction from the advertised window. The change makes
  the number match what the provider and the public catalog state; it does not
  observe the host's pressure threshold.
- The public catalog will move. The values above describe the document read on
  2026-11-23, and a later refresh replaces them.
