// Capture the Cursor card's source line and the model manager's rows from the
// shipped components, against fixture data, into the gitignored cache.
//
// The pages are the same markup the browser renders; only the host data is
// fixed, so a reviewer can compare layout, copy, and failure states without an
// account or a running DSH. The captures are review-only: they are not added to
// the public screenshots manifest. Run
// `pnpm exec tsc -p tsconfig.test.json` first, then this script.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CursorModelsBody } from '../../lib-test/src/client/CursorModelsBody.js'
import {
  CursorCapacitySection,
  CursorSourceLine,
} from '../../lib-test/src/client/CursorCapacitySource.js'
import { cursorManagerCss } from '../../lib-test/src/client/cursor-manager-styles.js'
import {
  deriveRows,
  filterRows,
  listStateFor,
} from '../../lib-test/src/client/cursor-manager-derive.js'
import { en, zh } from '../../lib-test/src/client/locales.js'
import { providerSettingsCss } from '../../lib-test/src/client/provider-settings-styles.js'

const outDir = join(process.cwd(), '.cache', 'cursor-screens')
mkdirSync(outDir, { recursive: true })

function translator(dictionary) {
  return (key, params) =>
    String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) =>
      String(params?.[name] ?? ''),
    )
}

const hosts = [
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    enabled: true,
    described: true,
    window: { tokens: 1_000_000, source: 'tier', tier: '1m' },
    overridable: false,
    manualValue: 1_000_000,
  },
  {
    id: 'grok-4.7',
    name: 'Grok 4.7',
    enabled: true,
    described: true,
    window: { tokens: 500_000, source: 'tier', tier: '500k' },
    overridable: false,
    manualValue: 500_000,
  },
  {
    id: 'deepseek-v41-flash-1017',
    name: 'DeepSeek V4.1 Flash 1017',
    enabled: true,
    described: false,
    window: { tokens: 1_048_576, source: 'published' },
    overridable: true,
    manualValue: 1_048_576,
    publishedWindow: 1_048_576,
  },
  {
    id: 'glm-5p3',
    name: 'GLM 5.3',
    enabled: true,
    described: false,
    window: { tokens: 1_048_573, source: 'published' },
    overridable: true,
    manualValue: 1_048_573,
    publishedWindow: 1_048_573,
  },
  {
    id: 'composer-2.5',
    name: 'Composer 2.5',
    enabled: false,
    described: true,
    window: { tokens: 200_000, source: 'default' },
    overridable: true,
    manualValue: 200_000,
  },
]

const theme = `:root {
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #f4f4f5;
  --dsw-alias-bg-layer-3: #ffffff;
  --dsw-alias-label-primary: #18181b;
  --dsw-alias-label-secondary: #3f3f46;
  --dsw-alias-label-tertiary: #71717a;
  --dsw-alias-label-dimmed: #a1a1aa;
  --dsw-alias-label-primary-foreground: #ffffff;
  --dsw-alias-border-l2: #d4d4d8;
  --dsw-alias-border-l3: #d4d4d8;
  --dsw-alias-border-l4: #d4d4d8;
  --dsw-alias-interactive-bg-hover: #f4f4f5;
  --dsw-alias-interactive-bg-active: #e4e4e7;
  --dsw-alias-state-success-primary: #16a34a;
  --dsw-alias-state-error-primary: #b42318;
  --dsw-alias-button-primary-fill: #18181b;
  --dsw-alias-button-primary-hover: #3f3f46;
}
body {
  margin: 0;
  padding: 28px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.5;
}
.dsh-cursor-page { width: 100%; max-width: 720px; display: grid; gap: 14px; }
.dsh-cursor-card, .dsh-subscription-manager {
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  padding: 18px;
  display: grid;
  gap: 10px;
  min-width: 0;
  box-sizing: border-box;
}
.dsh-cursor-card h2, .dsh-subscription-manager h2 { margin: 0; font-size: 15px; }
.dsh-cursor-card h3 { margin: 0; font-size: 13px; }
.dsh-cursor-card p, .dsh-subscription-manager p { margin: 0; }
@media (max-width: 480px) {
  body { padding: 14px; }
}
`

function page(bodyHtml) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
    theme +
    providerSettingsCss +
    cursorManagerCss +
    '</style></head><body><div class="dsh-cursor-page">' +
    bodyHtml +
    '</div></body></html>'
  )
}

/** The card's one status line, on its own and beside a failure notice. */
function card(t, { enabled, fetchedAt, locale, error, retained }) {
  const line = renderToStaticMarkup(
    createElement(CursorSourceLine, {
      t,
      enabled,
      ...(fetchedAt === undefined ? {} : { fetchedAt }),
      ...(locale === undefined ? {} : { locale }),
    }),
  )
  const failure =
    error === undefined
      ? ''
      : renderToStaticMarkup(
          createElement(
            'p',
            { role: 'alert' },
            t(
              retained === true
                ? 'cursorSourceRefreshFailedRetained'
                : 'cursorSourceRefreshFailedNoCache',
              { message: error },
            ),
          ),
        )
  return (
    '<section class="dsh-cursor-card"><h2>' +
    t('cursorTitle') +
    '</h2>' +
    '<p class="dsh-subscription-hint">' +
    t('cursorStatus', { count: 27 }) +
    '</p>' +
    '<p class="dsh-subscription-hint">' +
    t('cursorKeyRef', { ref: 'CURSOR_API_KEY' }) +
    '</p>' +
    line +
    failure +
    '<div><button type="button" style="font-weight:600">' +
    t('cursorManage') +
    '</button></div>' +
    '</section>'
  )
}

/** The manager, composed from the same pieces the dialog composes. */
function manager(
  t,
  {
    draft = {},
    texts = {},
    editing,
    errors = {},
    query = '',
    enabled = true,
    fetchedAt,
    sourceError,
    sourceNotice,
  },
) {
  const all = deriveRows(hosts, draft, texts, editing, errors)
  const rows = filterRows(all, query)
  const body = renderToStaticMarkup(
    createElement(CursorModelsBody, {
      t,
      rows,
      listState: listStateFor(all, rows.length),
      query,
      disabled: false,
      handlers: {
        onToggle: () => undefined,
        onEdit: () => undefined,
        onReset: () => undefined,
        onText: () => undefined,
        onCommit: () => undefined,
        onCancel: () => undefined,
      },
    }),
  )
  const fallback = all.filter((row) => row.source === 'default').length
  const section = renderToStaticMarkup(
    createElement(CursorCapacitySection, {
      t,
      enabled,
      ...(fetchedAt === undefined ? {} : { fetchedAt }),
      busy: false,
      fallback,
      total: all.length,
      ...(sourceError === undefined ? {} : { error: sourceError }),
      ...(sourceNotice === undefined ? {} : { notice: sourceNotice }),
      onRefresh: () => undefined,
      onToggle: () => undefined,
    }),
  )
  return (
    '<section class="dsh-subscription-manager dsh-cursor-manager"><header style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
    '<h2>' +
    t('cursorManageTitle') +
    '</h2><button type="button">' +
    t('imageClose') +
    '</button></header>' +
    '<p class="dsh-subscription-hint">' +
    t('cursorManageHint') +
    '</p>' +
    '<div class="dsh-cursor-toolbar"><input placeholder="' +
    t('modelDefaultsFilterPlaceholder') +
    '" aria-label="' +
    t('modelDefaultsFilterPlaceholder') +
    '"><button type="button">' +
    t('cursorModelsReload') +
    '</button></div>' +
    '<p class="dsh-cursor-summary">' +
    t('cursorModelsSummary', {
      enabled: all.filter((row) => row.enabled).length,
      total: all.length,
    }) +
    '</p>' +
    '<div class="dsh-cursor-list">' +
    body +
    '</div>' +
    section +
    '</section>'
  )
}

const chrome =
  process.env.CHROME_BIN ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((path) => existsSync(path))
if (!chrome) throw new Error('Chrome is not installed; set CHROME_BIN')

function capture(name, html, width, height, lang = 'en-US') {
  const htmlPath = join(outDir, name + '.html')
  writeFileSync(htmlPath, html)
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--lang=' + lang,
      '--window-size=' + width + ',' + height,
      '--screenshot=' + join(outDir, name + '.png'),
      'file://' + htmlPath,
    ],
    { stdio: 'ignore' },
  )
  console.log('captured', join(outDir, name + '.png'))
}

const enT = translator(en)
const zhT = translator(zh)
const refreshed = 1_765_000_000_000

capture(
  'card-source-on-en',
  page(card(enT, { enabled: true, fetchedAt: refreshed, locale: 'en-US' })),
  760,
  300,
)
capture(
  'card-source-off-en',
  page(card(enT, { enabled: false, locale: 'en-US' })),
  760,
  300,
)
capture(
  'card-source-failed-en',
  page(
    card(enT, {
      enabled: true,
      fetchedAt: refreshed,
      error: 'models.dev returned a document this projection cannot read',
      retained: true,
      locale: 'en-US',
    }),
  ),
  760,
  340,
)
capture('manager-en', page(manager(enT, { fetchedAt: refreshed })), 760, 700)
capture(
  'manager-manual-override-en',
  page(
    manager(enT, {
      fetchedAt: refreshed,
      draft: { 'deepseek-v41-flash-1017': { contextWindow: 900_000 } },
    }),
  ),
  760,
  700,
)
capture(
  'manager-editing-en',
  page(
    manager(enT, {
      fetchedAt: refreshed,
      editing: 'glm-5p3',
      texts: { 'glm-5p3': '1 000 000' },
    }),
  ),
  760,
  700,
)
capture(
  'manager-failed-write-en',
  page(
    manager(enT, {
      fetchedAt: refreshed,
      errors: {
        'composer-2.5': enT('cursorModelWriteFailed', {
          model: 'Composer 2.5',
          message: 'write failed',
        }),
      },
    }),
  ),
  760,
  760,
)
capture(
  'manager-filter-empty-en',
  page(manager(enT, { fetchedAt: refreshed, query: 'zzz' })),
  760,
  560,
)
capture(
  'manager-source-off-en',
  page(
    manager(enT, {
      enabled: false,
      sourceNotice: enT('cursorCapacityDisabledRefresh'),
    }),
  ),
  760,
  700,
)
capture(
  'manager-source-failed-en',
  page(
    manager(enT, {
      fetchedAt: refreshed,
      sourceError: enT('cursorSourceRefreshFailedRetained', {
        message: 'models.dev answered 503',
      }),
    }),
  ),
  760,
  760,
)
capture(
  'manager-zh-narrow',
  page(manager(zhT, { fetchedAt: refreshed })),
  500,
  900,
  'zh-CN',
)
capture(
  'card-source-zh-narrow',
  page(card(zhT, { enabled: false, locale: 'zh-CN' })),
  500,
  340,
  'zh-CN',
)
