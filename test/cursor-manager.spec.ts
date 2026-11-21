import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CursorModelsBody,
  CursorModelsManager,
  cursorModelsPatch,
  formatWindowLabel,
  mergedManagerState,
  parseWindowInput,
  tierChoices,
  tierOptionLabel,
  tierSelectValue,
  windowSourceLabel,
  type CursorModelRowView,
  type CursorModelsView,
} from '../src/client/CursorModelsManager.js'
import { CursorSourceStatus } from '../src/client/CursorCard.js'

const t = ((key: string, params?: Record<string, unknown>) =>
  params?.tier === undefined ? key : key + ':' + String(params.tier)) as never

const tiered: CursorModelRowView = {
  id: 'claude-sonnet-5-5',
  name: 'Claude Sonnet 5.5',
  enabled: true,
  described: true,
  tierOptions: ['200k', '1m'],
  window: { tokens: 200_000, source: 'tier', tier: '200k' },
  manualWindow: { editable: false, value: 200_000 },
}

const published: CursorModelRowView = {
  id: 'deepseek-v41-flash-1017',
  name: 'DeepSeek V4.1 Flash 1017',
  enabled: true,
  described: false,
  tierOptions: [],
  window: { tokens: 1_048_576, source: 'published' },
  manualWindow: { editable: false, value: 1_048_576 },
  publishedWindow: 1_048_576,
}

const editable: CursorModelRowView = {
  id: 'composer-2',
  name: 'Composer 2',
  enabled: false,
  described: true,
  tierOptions: [],
  window: { tokens: 200_000, source: 'default' },
  manualWindow: { editable: true, value: 200_000 },
}

function viewOf(models: CursorModelRowView[]): CursorModelsView {
  return {
    provider: 'cursor',
    context: 'max',
    models,
    knownContext: { enabled: true },
    storedModels: {},
    publishedContext: true,
  }
}

test('window inputs parse strictly, format, and name their source', () => {
  assert.equal(parseWindowInput('300,000'), 300_000)
  assert.equal(parseWindowInput('1 000 000'), 1_000_000)
  assert.equal(parseWindowInput('200000'), 200_000)
  // A typo must never become a different number.
  assert.equal(parseWindowInput('1m'), null)
  assert.equal(parseWindowInput('1.5'), null)
  assert.equal(parseWindowInput('-300000'), null)
  assert.equal(parseWindowInput('0'), null)
  assert.equal(parseWindowInput(''), null)
  assert.equal(formatWindowLabel(1_000_000), '1M')
  assert.equal(formatWindowLabel(200_000), '200K')
  assert.equal(formatWindowLabel(1_048_576), '1,048,576')
  assert.equal(windowSourceLabel(t, 'tier', '200k'), 'cursorWindowTier:200k')
  assert.equal(windowSourceLabel(t, 'published'), 'cursorWindowPublished')
  assert.equal(windowSourceLabel(t, 'manual'), 'cursorWindowManual')
  assert.equal(windowSourceLabel(t, 'default'), 'cursorWindowDefault')
})

test('the saved patch includes a window-only edit from an untouched row', () => {
  const windowOnly = cursorModelsPatch({}, { 'composer-2': '300000' })
  assert.deepEqual(windowOnly.invalid, [])
  assert.deepEqual(windowOnly.models, {
    'composer-2': { contextWindow: 300_000 },
  })

  const draft = {
    'claude-sonnet-5-5': {
      enabled: false,
      context: '200k',
      contextWindow: 300_000,
    },
    'deepseek-v41-flash-1017': { contextWindow: 1_048_576 },
  }
  const saved = cursorModelsPatch(draft, {
    'claude-sonnet-5-5': '400000',
  })
  assert.deepEqual(saved.invalid, [])
  assert.deepEqual(saved.models, {
    'claude-sonnet-5-5': {
      enabled: false,
      context: '200k',
      contextWindow: 400_000,
    },
    'deepseek-v41-flash-1017': { contextWindow: 1_048_576 },
  })
  // Clearing the field removes the manual value; a blank tier stays cleared.
  const cleared = cursorModelsPatch(
    { 'claude-sonnet-5-5': { enabled: true, contextWindow: 300_000 } },
    { 'claude-sonnet-5-5': '  ' },
  )
  assert.deepEqual(cleared.models, { 'claude-sonnet-5-5': { enabled: true } })
  // Unusable text blocks the save and names the model.
  const invalid = cursorModelsPatch(
    { 'composer-2': { contextWindow: 200_000 } },
    { 'composer-2': '1.5' },
  )
  assert.deepEqual(invalid.invalid, ['composer-2'])
  assert.deepEqual(invalid.models, {})
})

test('a Reload keeps pending edits and the first read seeds them', () => {
  const first = mergedManagerState(false, undefined, viewOf([editable]))
  assert.deepEqual(first.draft, {})
  assert.deepEqual(first.texts, {})
  assert.deepEqual(first.invalid, [])

  const pending = {
    draft: { 'composer-2': { contextWindow: 300_000 } },
    texts: { 'composer-2': '300000' },
    invalid: ['composer-2'],
  }
  assert.deepEqual(
    mergedManagerState(true, pending, viewOf([editable])),
    pending,
  )

  const seeded = mergedManagerState(false, pending, {
    ...viewOf([editable]),
    storedModels: { 'composer-2': { enabled: false } },
  })
  assert.deepEqual(seeded.draft, { 'composer-2': { enabled: false } })
})

test('tier choices name the preferences and flag only a withdrawn value', () => {
  const choices = tierChoices({ ...tiered, tierOverride: '500k' })
  assert.deepEqual(choices.options.at(-1), {
    value: '500k',
    kind: 'withdrawn',
  })
  // Smallest/largest are preferences, not withdrawn wire tiers.
  assert.deepEqual(
    choices.options.filter(
      (choice) => choice.kind === 'min' || choice.kind === 'max',
    ),
    [
      { value: 'min', kind: 'min' },
      { value: 'max', kind: 'max' },
    ],
  )
  // A configured tier the catalog still offers is matched case-insensitively.
  assert.deepEqual(
    tierChoices({ ...tiered, tierOverride: '1M' }).options.map(
      (choice) => choice,
    ),
    [
      { value: '200k', kind: 'tier' },
      { value: '1m', kind: 'tier' },
      { value: 'min', kind: 'min' },
      { value: 'max', kind: 'max' },
    ],
  )
  assert.equal(
    tierOptionLabel(t, { value: 'min', kind: 'min' }),
    'cursorModelContextMin',
  )
  assert.equal(
    tierOptionLabel(t, { value: '500k', kind: 'withdrawn' }),
    '500k · cursorModelTierWithdrawn',
  )
})

test('the tier select keeps an explicit clear instead of the stored value', () => {
  const stored = { ...tiered, tierOverride: '200k' }
  // No change: the stored value is selected.
  assert.equal(tierSelectValue(stored, {}), '200k')
  // Explicit clear wins, even for a stored override and a YAML baseline.
  assert.equal(tierSelectValue(stored, { [stored.id]: { context: '' } }), '')
  assert.equal(
    tierSelectValue(
      { ...stored, tierOverride: 'max' },
      { [stored.id]: { context: '' } },
    ),
    '',
  )
  // A differently cased stored value selects the offered spelling.
  assert.equal(tierSelectValue({ ...stored, tierOverride: '1M' }, {}), '1m')
  // Clearing only (no other edit) still survives the patch builder.
  const patch = cursorModelsPatch({ [stored.id]: { context: '' } }, {})
  assert.deepEqual(patch.models, {})
})

test('the model body renders tier, window source, and the invalid alert', () => {
  const html = renderToStaticMarkup(
    createElement(CursorModelsBody, {
      t,
      models: [tiered, published, editable],
      draft: {},
      texts: {},
      invalid: ['composer-2'],
      disabled: false,
      onToggle: () => undefined,
      onTier: () => undefined,
      onWindow: () => undefined,
    }),
  )
  assert.match(html, /Claude Sonnet 5.5/)
  assert.match(html, /<select/)
  assert.match(html, /200K/)
  assert.match(html, /cursorWindowTier/)
  assert.match(html, /1,048,576/)
  assert.match(html, /cursorWindowPublished/)
  assert.match(html, /cursorModelNotDescribed/)
  // The editable row shows an input with help and error association.
  assert.match(html, /cursorModelWindowFor/)
  assert.match(html, /aria-describedby="cursor-window-help-composer-2/)
  assert.match(html, /role="alert"/)
  assert.match(html, /aria-invalid="true"/)
})

test('an empty catalog renders the empty note', () => {
  const html = renderToStaticMarkup(
    createElement(CursorModelsBody, {
      t,
      models: [],
      draft: {},
      texts: {},
      invalid: [],
      disabled: false,
      onToggle: () => undefined,
      onTier: () => undefined,
      onWindow: () => undefined,
    }),
  )
  assert.match(html, /cursorModelsEmpty/)
})

test('the source status states on/off, freshness, and both controls', () => {
  const on = renderToStaticMarkup(
    createElement(CursorSourceStatus, {
      t,
      enabled: true,
      busy: false,
      onRefresh: () => undefined,
      onToggle: () => undefined,
    }),
  )
  assert.match(on, /cursorSourceOn/)
  assert.match(on, /cursorSourceNever/)
  assert.match(on, /role="status"/)
  assert.match(on, /cursorSourceRefresh/)
  assert.match(on, /cursorSourceDisable/)
  assert.doesNotMatch(on, /<button[^>]*disabled/)

  const off = renderToStaticMarkup(
    createElement(CursorSourceStatus, {
      t,
      enabled: false,
      fetchedAt: 1_700_000_000_000,
      busy: true,
      onRefresh: () => undefined,
      onToggle: () => undefined,
    }),
  )
  assert.match(off, /cursorSourceOff/)
  assert.match(off, /cursorSourceUpdated/)
  assert.match(off, /cursorSourceEnable/)
  // Refresh cannot run while the source is off.
  assert.match(off, /<button[^>]*disabled[^>]*>cursorSourceRefresh/)
})

test('the manager dialog opens in its loading state', () => {
  const html = renderToStaticMarkup(
    createElement(CursorModelsManager, {
      rpc: {} as never,
      t,
      onClose: () => undefined,
      onSaved: () => undefined,
    }),
  )
  assert.match(html, /<dialog/)
  assert.match(html, /cursorManageTitle/)
  assert.match(html, /cursorModelsLoading/)
})

test('an enablement-only edit leaves the tier on screen unchanged', () => {
  const row = { ...tiered, tierOverride: '200k' }
  // Toggling only enablement must not turn a stored/YAML tier into Auto.
  assert.equal(tierSelectValue(row, { [row.id]: { enabled: false } }), '200k')
})
