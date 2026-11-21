// Capture the Cursor card's source status and the manager's model rows from the
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
import { CursorModelsBody } from '../../lib-test/src/client/CursorModelsManager.js'
import { CursorSourceStatus } from '../../lib-test/src/client/CursorCard.js'
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

const rows = [
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    enabled: true,
    described: true,
    tierOptions: ['200k', '1m'],
    window: { tokens: 200_000, source: 'tier', tier: '200k' },
    manualWindow: { editable: false, value: 200_000 },
  },
  {
    id: 'deepseek-v41-flash-1017',
    name: 'DeepSeek V4.1 Flash 1017',
    enabled: true,
    described: false,
    tierOptions: [],
    window: { tokens: 1_048_576, source: 'published' },
    manualWindow: { editable: false, value: 1_048_576 },
    publishedWindow: 1_048_576,
  },
  {
    id: 'composer-2.5',
    name: 'Composer 2.5',
    enabled: false,
    described: true,
    tierOptions: [],
    window: { tokens: 200_000, source: 'default' },
    manualWindow: { editable: true, value: 200_000 },
  },
  {
    id: 'grok-4.7',
    name: 'Grok 4.7',
    enabled: true,
    described: true,
    tierOptions: ['256k', '500k'],
    tierOverride: '300k',
    window: { tokens: 500_000, source: 'tier', tier: '500k' },
    manualWindow: { editable: false, value: 500_000 },
  },
]

const theme = `:root {
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #f4f4f5;
  --dsw-alias-label-primary: #18181b;
  --dsw-alias-label-secondary: #3f3f46;
  --dsw-alias-label-tertiary: #71717a;
  --dsw-alias-label-dimmed: #a1a1aa;
  --dsw-alias-border-l2: #d4d4d8;
  --dsw-alias-state-success-primary: #16a34a;
}
body {
  margin: 0;
  padding: 28px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.dsh-cursor-page { width: 100%; max-width: 640px; display: grid; gap: 14px; }
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
.dsh-cursor-card button, .dsh-subscription-manager button {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: inherit;
}
.dsh-cursor-card input[type='checkbox'] { vertical-align: middle; }
.dsh-cursor-card select, .dsh-subscription-manager select, .dsh-subscription-manager input {
  font: inherit;
  font-size: 12px;
  max-width: 100%;
}
@media (max-width: 480px) {
  body { padding: 14px; }
}
`

function page(bodyHtml) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
    theme +
    providerSettingsCss +
    '</style></head><body><div class="dsh-cursor-page">' +
    bodyHtml +
    '</div></body></html>'
  )
}

function sourceCards(t, { enabled, fetchedAt, error, retained, locale }) {
  const status = renderToStaticMarkup(
    createElement(CursorSourceStatus, {
      t,
      enabled,
      ...(fetchedAt === undefined ? {} : { fetchedAt }),
      busy: false,
      onRefresh: () => undefined,
      onToggle: () => undefined,
      ...(locale === undefined ? {} : { locale }),
    }),
  )
  const errorHtml =
    error === undefined
      ? ''
      : '<p role="alert" style="margin:0;color:#b91c1c;font-size:12px">' +
        t(
          retained === true
            ? 'cursorSourceRefreshFailedRetained'
            : 'cursorSourceRefreshFailedNoCache',
          { message: error },
        ) +
        '</p>'
  return (
    '<section class="dsh-cursor-card"><h2>' +
    t('cursorTitle') +
    '</h2>' +
    '<p style="margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)">' +
    t('cursorStatus', { count: 4 }) +
    '</p>' +
    '<p style="margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)">' +
    t('cursorKeyRef', { ref: 'CURSOR_API_KEY' }) +
    '</p>' +
    status +
    errorHtml +
    '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" style="font-weight:600">' +
    t('cursorManage') +
    '</button></div>' +
    '</section>'
  )
}

function managerCard(t) {
  const body = renderToStaticMarkup(
    createElement(CursorModelsBody, {
      t,
      models: rows,
      draft: {},
      texts: {},
      invalid: [],
      disabled: false,
      onToggle: () => undefined,
      onTier: () => undefined,
      onWindow: () => undefined,
    }),
  )
  return (
    '<section class="dsh-subscription-manager"><header style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
    '<h2>' +
    t('cursorManageTitle') +
    '</h2><button type="button">' +
    t('imageClose') +
    '</button></header>' +
    '<p class="dsh-subscription-hint" style="margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)">' +
    t('cursorManageHint') +
    '</p>' +
    '<div>' +
    body +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">' +
    '<button type="button">' +
    t('cursorModelsReload') +
    '</button>' +
    '<button type="button">' +
    t('cursorCancel') +
    '</button>' +
    '<button type="button">' +
    t('cursorSave') +
    '</button></div>' +
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
  'cursor-source-en',
  page(
    sourceCards(enT, { enabled: true, fetchedAt: refreshed, locale: 'en-US' }),
  ),
  700,
  340,
)
capture(
  'cursor-source-failed-en',
  page(
    sourceCards(enT, {
      enabled: true,
      fetchedAt: refreshed,
      error: 'models.dev answered 503',
      retained: true,
      locale: 'en-US',
    }),
  ),
  700,
  420,
)
capture(
  'cursor-source-failed-nocache-en',
  page(
    sourceCards(enT, {
      enabled: true,
      error: 'models.dev answered 503',
      retained: false,
      locale: 'en-US',
    }),
  ),
  700,
  420,
)
capture(
  'cursor-source-zh-narrow',
  page(
    sourceCards(zhT, {
      enabled: false,
      fetchedAt: refreshed,
      locale: 'zh-CN',
    }),
  ),
  // Chrome's headless window has a 500 CSS px floor; a smaller width crops.
  500,
  440,
  'zh-CN',
)
capture('cursor-models-en', page(managerCard(enT)), 700, 1000)
capture('cursor-models-zh-narrow', page(managerCard(zhT)), 500, 1300, 'zh-CN')
