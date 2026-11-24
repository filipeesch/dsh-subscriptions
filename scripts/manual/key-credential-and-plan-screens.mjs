// Capture the key routes' credential field and the Claude card's budget reading
// from the shipped components, against fixture data, into the gitignored cache.
//
// The credential field loads its state through the plugin's RPC, so each state
// is produced by running the real component with the same fake RPC the
// component tests use. The pages are the same markup the browser renders; only
// the host data is fixed, so a reviewer can compare copy and layout without a
// credential or a running DSH. These are component fixtures: the credential
// field and the window rows render as the cards mount them, but the enclosing
// card composition is not part of a capture. Captures are review-only and are not
// added to the public screenshots manifest.
//
// Run `pnpm exec tsc -p tsconfig.test.json` first, then this script.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { KeyCredentialField } from '../../lib-test/src/client/KeyCredentialField.js'
import { UsageWindowRow } from '../../lib-test/src/client/UsageWindowRow.js'
import { PlanWindowsAbsentNote } from '../../lib-test/src/client/SubscriptionsSection.js'
import { en, zh } from '../../lib-test/src/client/locales.js'
import {
  providerSettingsCss,
  subscriptionChromeCss,
} from '../../lib-test/src/client/provider-settings-styles.js'
import { Component, settle } from '../../lib-test/test/component-harness.js'

const outDir = join(process.cwd(), '.cache', 'key-credential-screens')
mkdirSync(outDir, { recursive: true })

const chrome =
  process.env.CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function translator(dictionary) {
  return (key, params) =>
    String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) =>
      String(params?.[name] ?? ''),
    )
}

/** One fake RPC answering the credential endpoints with a fixed view. */
function credentialRpc(view) {
  return {
    async call(_channel, endpoint) {
      if (endpoint === 'subscriptions-auth.keyCredential')
        return { ok: true, value: { ...view } }
      if (endpoint === 'subscriptions-auth.keySetCredential')
        return { ok: true, value: { ...view } }
      if (endpoint === 'subscriptions-auth.keyClearCredential')
        return { ok: true, value: { ...view, configured: false } }
      throw new Error(`unexpected endpoint ${endpoint}`)
    },
  }
}

async function credentialPage(t, view, title) {
  const component = new Component(() =>
    KeyCredentialField({
      rpc: credentialRpc(view),
      t,
      route: 'cursor',
    }),
  )
  await settle(component)
  const body =
    '<section class="dsh-screen"><h2>' +
    title +
    '</h2>' +
    renderToStaticMarkup(component.tree) +
    '</section>'
  return page(body)
}

const theme = `:root {
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #f4f4f5;
  --dsw-alias-bg-layer-3: #ffffff;
  --dsw-alias-label-primary: #18181b;
  --dsw-alias-label-secondary: #3f3f46;
  --dsw-alias-label-tertiary: #71717a;
  --dsw-alias-label-dimmed: #a1a1aa;
  --dsw-alias-border-l2: #d4d4d8;
  --dsw-alias-border-l3: #d4d4d8;
  --dsw-alias-state-success-primary: #16a34a;
  --dsw-alias-state-warn-label: #b45309;
  --dsw-alias-state-error-primary: #b42318;
}
body {
  margin: 0;
  padding: 24px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.5;
}
.dsh-screen { width: 100%; max-width: 640px; display: grid; gap: 12px; }
.dsh-screen h2 { margin: 0; font-size: 15px; }
`

function page(bodyHtml) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' +
    theme +
    providerSettingsCss +
    subscriptionChromeCss +
    '</style></head><body>' +
    bodyHtml +
    '</body></html>'
  )
}

/** The Claude card's usage body for one reading. */
function claudeReading(t, windows, { absent = false } = {}) {
  const rows = windows
    .map((window) =>
      renderToStaticMarkup(
        createElement(UsageWindowRow, { window, t, observedAt: Date.now() }),
      ),
    )
    .join('')
  const note = absent
    ? renderToStaticMarkup(createElement(PlanWindowsAbsentNote, { t }))
    : ''
  return (
    '<section class="dsh-screen"><h2>' +
    'Claude · virtual-claude@example.invalid</h2>' +
    '<div style="display:grid;gap:10px">' +
    rows +
    note +
    '</div></section>'
  )
}

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

const budgetOnly = claudeReading(
  translator(en),
  [
    {
      kind: 'other',
      scope: 'Extra usage',
      usedAmount: 60_021,
      limitAmount: 60_000,
      limitSource: 'provider',
      remainingAmount: 0,
      currency: 'USD',
      usedPercent: 100,
    },
  ],
  { absent: true },
)

const planAndBudget = claudeReading(translator(en), [
  {
    kind: 'session',
    usedPercent: 12,
    resetsAt: Date.now() + 3 * HOUR,
  },
  {
    kind: 'weekly',
    usedPercent: 40,
    resetsAt: Date.now() + 4 * DAY,
  },
  {
    kind: 'weekly',
    scope: 'OAuth apps',
    usedPercent: 8,
    resetsAt: Date.now() + 4 * DAY,
  },
  {
    kind: 'other',
    scope: 'Extra usage',
    usedAmount: 300,
    limitAmount: 6_000,
    limitSource: 'provider',
    remainingAmount: 5_700,
    currency: 'USD',
    usedPercent: 5,
  },
])

const writes = [
  [
    'credential-absent.html',
    await credentialPage(
      translator(en),
      {
        route: 'cursor',
        keyRef: 'CURSOR_API_KEY',
        configured: false,
        writable: true,
      },
      'Cursor key · no key configured',
    ),
  ],
  [
    'credential-environment.html',
    await credentialPage(
      translator(en),
      {
        route: 'cursor',
        keyRef: 'CURSOR_API_KEY',
        configured: true,
        source: 'env',
        writable: true,
      },
      'Cursor key · found in the environment',
    ),
  ],
  [
    'credential-stored.html',
    await credentialPage(
      translator(en),
      {
        route: 'cursor',
        keyRef: 'CURSOR_API_KEY',
        configured: true,
        source: 'file',
        writable: true,
        masked: 'sk-…f4c2',
      },
      'Cursor key · stored in DSH',
    ),
  ],
  [
    'credential-stored-zh.html',
    await credentialPage(
      translator(zh),
      {
        route: 'cursor',
        keyRef: 'CURSOR_API_KEY',
        configured: true,
        source: 'file',
        writable: true,
        masked: 'sk-…f4c2',
      },
      'Cursor 凭据 · 已保存在 DSH（中文）',
    ),
  ],
  ['claude-budget-only.html', page(budgetOnly)],
  ['claude-plan-and-budget.html', page(planAndBudget)],
]

for (const [name, html] of writes) {
  const file = join(outDir, name)
  writeFileSync(file, html)
  const png = file.replace(/\.html$/, '.png')
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--window-size=720,300',
    `--screenshot=${png}`,
    `--virtual-time-budget=1500`,
    `file://${file}`,
  ])
  console.log(`captured ${png}`)
}
