import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  deriveRows,
  filterRows,
  formatWindowLabel,
  listStateFor,
  parseWindowInput,
  rowCounts,
  windowNote,
  windowSourceLabel,
  withModelEdit,
  type CursorModelDraft,
  type CursorModelRowView,
} from '../src/client/cursor-manager-derive.js'
import { CursorModelsBody } from '../src/client/CursorModelsBody.js'
import {
  CursorCapacitySection,
  CursorSourceLine,
} from '../src/client/CursorCapacitySource.js'
import { CursorModelsManager } from '../src/client/CursorModelsManager.js'

const t = ((key: string, params?: Record<string, unknown>) =>
  params?.tier === undefined ? key : key + ':' + String(params.tier)) as never

const tiered: CursorModelRowView = {
  id: 'claude-sonnet-5-5',
  name: 'Claude Sonnet 5.5',
  enabled: true,
  described: true,
  window: { tokens: 1_000_000, source: 'tier', tier: '1m' },
  overridable: false,
  manualValue: 1_000_000,
}

const published: CursorModelRowView = {
  id: 'deepseek-v41-flash-1017',
  name: 'DeepSeek V4.1 Flash 1017',
  enabled: true,
  described: false,
  window: { tokens: 1_048_576, source: 'published' },
  overridable: true,
  manualValue: 1_048_576,
  publishedWindow: 1_048_576,
}

const fallback: CursorModelRowView = {
  id: 'composer-2',
  name: 'Composer 2',
  enabled: false,
  described: true,
  window: { tokens: 200_000, source: 'default' },
  overridable: true,
  manualValue: 200_000,
}

const noopHandlers = {
  onToggle: () => undefined,
  onEdit: () => undefined,
  onReset: () => undefined,
  onText: () => undefined,
  onCommit: () => undefined,
  onCancel: () => undefined,
}

function bodyOf(
  models: CursorModelRowView[],
  draft: CursorModelDraft = {},
  texts: Record<string, string> = {},
  editing?: string,
  errors: Record<string, string> = {},
  query = '',
): string {
  const all = deriveRows(models, draft, texts, editing, errors)
  const rows = filterRows(all, query)
  return renderToStaticMarkup(
    createElement(CursorModelsBody, {
      t,
      rows,
      listState: listStateFor(all, rows.length),
      query,
      disabled: false,
      handlers: noopHandlers,
    }),
  )
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

test('one edit patches one model and clearing the last field removes it', () => {
  const once = withModelEdit({}, 'composer-2', { contextWindow: 300_000 })
  assert.deepEqual(once, { 'composer-2': { contextWindow: 300_000 } })
  // A second field keeps the first.
  const twice = withModelEdit(once, 'composer-2', { enabled: false })
  assert.deepEqual(twice, {
    'composer-2': { contextWindow: 300_000, enabled: false },
  })
  // Clearing both leaves no entry, so the model reads as untouched.
  const cleared = withModelEdit(
    withModelEdit(twice, 'composer-2', { contextWindow: undefined }),
    'composer-2',
    { enabled: undefined },
  )
  assert.deepEqual(cleared, {})
})

test('a stored manual value wins on the row and still names what it replaced', () => {
  const rows = deriveRows(
    [published],
    { 'deepseek-v41-flash-1017': { contextWindow: 900_000 } },
    {},
    undefined,
    {},
  )
  assert.equal(rows[0]?.tokens, 900_000)
  assert.equal(rows[0]?.source, 'manual')
  assert.equal(rows[0]?.replaced, 1_048_576)
  assert.equal(
    windowNote(t, rows[0]!),
    'cursorWindowManual · cursorWindowReplaces',
  )
  // Removing the override returns the row to the published capacity.
  const reverted = deriveRows([published], {}, {}, undefined, {})
  assert.equal(reverted[0]?.source, 'published')
  assert.equal(reverted[0]?.tokens, 1_048_576)
})

test('an enablement edit changes the row without touching its window', () => {
  const rows = deriveRows(
    [tiered],
    { 'claude-sonnet-5-5': { enabled: false } },
    {},
    undefined,
    {},
  )
  assert.equal(rows[0]?.enabled, false)
  assert.deepEqual(
    { tokens: rows[0]?.tokens, source: rows[0]?.source, tier: rows[0]?.tier },
    { tokens: 1_000_000, source: 'tier', tier: '1m' },
  )
})

test('the filter matches name or id and reports the empty case', () => {
  const rows = deriveRows([tiered, published, fallback], {}, {}, undefined, {})
  assert.deepEqual(
    filterRows(rows, 'deepseek').map((row) => row.id),
    ['deepseek-v41-flash-1017'],
  )
  assert.deepEqual(
    filterRows(rows, 'CLAUDE').map((row) => row.id),
    ['claude-sonnet-5-5'],
  )
  assert.equal(filterRows(rows, 'nothing').length, 0)
  assert.equal(filterRows(rows, '').length, 3)
  assert.equal(listStateFor(rows, 0), 'filter-empty')
  assert.equal(listStateFor([], 0), 'provider-empty')
  assert.equal(listStateFor(rows, 3), 'rows')
})

test('the counts state enablement and how many rows are on the default', () => {
  const rows = deriveRows([tiered, published, fallback], {}, {}, undefined, {})
  assert.deepEqual(rowCounts(rows), { enabled: 2, total: 3, fallback: 1 })
})

test('a row shows its window as a chip and offers the override only when it can', () => {
  const html = bodyOf([tiered, published, fallback])
  assert.match(html, /Claude Sonnet 5.5/)
  assert.match(html, /1M/)
  assert.match(html, /1,048,576/)
  // The tier row has no pencil; the other two do.
  assert.equal(html.match(/cursorModelOverride/g)?.length, 2)
  // The chip names its source in the accessible name and the tooltip.
  assert.match(html, /title="cursorWindowTier:1m"/)
  assert.match(html, /cursorWindowPublished/)
  assert.match(html, /cursorModelNotDescribed/)
})

test('an open field renders an input; an invalid one states the failure in the row', () => {
  const editing = bodyOf(
    [published],
    {},
    { 'deepseek-v41-flash-1017': '1.5' },
    'deepseek-v41-flash-1017',
    {
      'deepseek-v41-flash-1017': 'cursorModelWindowInvalid',
    },
  )
  assert.match(editing, /<input/)
  assert.match(editing, /aria-invalid="true"/)
  assert.match(editing, /role="alert"/)
  assert.match(editing, /cursorModelWindowInvalid/)
  assert.doesNotMatch(editing, /dsh-cursor-chip/)
})

test('a manual row offers the return to automatic', () => {
  const html = bodyOf([published], {
    'deepseek-v41-flash-1017': { contextWindow: 900_000 },
  })
  assert.match(html, /900K/)
  assert.match(html, /cursorModelResetOverride/)
})

test('an empty catalogue and an empty filter state different notes', () => {
  assert.match(bodyOf([]), /cursorModelsEmpty/)
  assert.match(
    bodyOf([tiered], {}, {}, undefined, {}, 'zzz'),
    /modelDefaultsFilterEmpty/,
  )
})

test('the source line states the source and its age', () => {
  const on = renderToStaticMarkup(
    createElement(CursorSourceLine, { t, enabled: true, locale: 'en' }),
  )
  assert.match(on, /cursorSourceOn/)
  assert.match(on, /cursorSourceNever/)
  assert.match(on, /role="status"/)
  const off = renderToStaticMarkup(
    createElement(CursorSourceLine, {
      t,
      enabled: false,
      fetchedAt: 1_700_000_000_000,
      locale: 'en',
    }),
  )
  assert.match(off, /cursorSourceOff/)
  assert.match(off, /cursorSourceUpdated/)
})

test('the capacity section states the state, the fallback count, and both controls', () => {
  const section = (
    enabled: boolean,
    busy: boolean,
    fallback: number,
    extra: Record<string, unknown> = {},
  ) =>
    renderToStaticMarkup(
      createElement(CursorCapacitySection, {
        t,
        enabled,
        busy,
        fallback,
        total: 3,
        onRefresh: () => undefined,
        onToggle: () => undefined,
        locale: 'en',
        ...extra,
      }),
    )
  const on = section(true, false, 1, { fetchedAt: 1_700_000_000_000 })
  assert.match(on, /cursorCapacityTitle/)
  assert.match(on, /cursorCapacityOn/)
  assert.match(on, /cursorCapacityFallback/)
  assert.match(on, /cursorCapacityRefresh/)
  assert.match(on, /cursorCapacityDisable/)
  assert.match(on, /cursorSourceUpdated/)

  const off = section(false, true, 0, { error: 'cursorCapacityToggleFailed' })
  assert.match(off, /cursorCapacityOff/)
  assert.match(off, /cursorCapacityAllDescribed/)
  assert.match(off, /cursorCapacityEnable/)
  assert.match(off, /role="alert"/)
  // Refresh cannot run while the source is off.
  assert.match(off, /<button[^>]*disabled[^>]*>cursorCapacityRefresh/)
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
  assert.match(html, /dsh-cursor-manager/)
  assert.match(html, /cursorManageTitle/)
  assert.match(html, /cursorModelsLoading/)
  // Autosave replaced the explicit pair: there is no Save or Cancel control.
  assert.doesNotMatch(html, /cursorSave/)
  assert.doesNotMatch(html, /cursorCancel/)
})
