/**
 * Capture the configured-provider roster and the add-provider form from the
 * shipped components, against fixture data, into the gitignored cache.
 *
 * The page reads which providers are configured through the plugin's RPC, so
 * each state is produced by running the real section with a fake RPC, the same
 * way its tests do. The pages are the markup the browser renders; only the host
 * data is fixed, so a reviewer can compare copy, order, and layout without a
 * credential or a running DSH. These are review-only captures and are not added
 * to the public screenshots manifest.
 *
 * Run `pnpm exec tsc -p tsconfig.test.json` first, then this script.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubscriptionsSection } from '../../lib-test/src/client/SubscriptionsSection.js'
import { AddProviderForm } from '../../lib-test/src/client/AddProviderForm.js'
import { ProviderRoster } from '../../lib-test/src/client/ProviderRoster.js'
import { configuredRows } from '../../lib-test/src/client/provider-roster.js'
import { en } from '../../lib-test/src/client/locales.js'
import { providerSettingsCss } from '../../lib-test/src/client/provider-settings-styles.js'
import {
  Component,
  nodes,
  settle,
  text,
} from '../../lib-test/test/component-harness.js'

const outDir = join(process.cwd(), '.cache', 'provider-roster-screens')
mkdirSync(outDir, { recursive: true })

// The page announces a refresh to the composer badge after a read; the capture
// only needs the call to land somewhere.
if (globalThis.window === undefined) {
  globalThis.window = {
    dispatchEvent: () => true,
    open: () => undefined,
  }
}

const chrome =
  process.env.CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function translator(dictionary) {
  return (key, params) =>
    String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) =>
      String(params?.[name] ?? ''),
    )
}

const LIGHT = [
  ':root {',
  '  --dsw-alias-bg-layer-1: #ffffff;',
  '  --dsw-alias-bg-layer-2: #f4f4f5;',
  '  --dsw-alias-bg-layer-3: #ffffff;',
  '  --dsw-alias-label-primary: #18181b;',
  '  --dsw-alias-label-secondary: #3f3f46;',
  '  --dsw-alias-label-tertiary: #71717a;',
  '  --dsw-alias-label-dimmed: #a1a1aa;',
  '  --dsw-alias-label-primary-foreground: #ffffff;',
  '  --dsw-alias-border-l2: #e4e4e7;',
  '  --dsw-alias-border-l3: #d4d4d8;',
  '  --dsw-alias-border-l4: #e4e4e7;',
  '  --dsw-alias-state-success-primary: #16a34a;',
  '  --dsw-alias-state-warn-label: #b45309;',
  '  --dsw-alias-state-error-primary: #b42318;',
  '  --dsw-alias-button-primary-fill: #2563eb;',
  '  --dsw-alias-button-primary-hover: #1d4ed8;',
  '  --dsw-alias-brand-primary: #2563eb;',
  '  --dsw-alias-state-business-primary: #2563eb;',
  '  --dsw-alias-interactive-bg-hover: #f4f4f5;',
  '  --dsw-alias-interactive-bg-active: #e4e4e7;',
  '  --dsw-alias-settings-card-fill: #ffffff;',
  '  --dsw-alias-settings-card-stroke: #e4e4e7;',
  '  --dsw-alias-bg-skeleton: rgba(0, 0, 0, 0.04);',
  '  --dsw-focus-ring-color: #2563eb;',
  '  --dsw-radius-panel: 16px;',
  '  --dsw-radius-md: 8px;',
  '  --dsw-radius-sm: 6px;',
  '  --dsw-radius-lg: 16px;',
  '  --dsw-radius-xl: 20px;',
  '  --dsw-elevation-prominent: 0 20px 70px #0004;',
  '}',
].join('\n')

const DARK = [
  ':root {',
  '  --dsw-alias-bg-layer-1: #232324;',
  '  --dsw-alias-bg-layer-2: #2c2c2e;',
  '  --dsw-alias-bg-layer-3: #3a3a3c;',
  '  --dsw-alias-label-primary: #f9fafb;',
  '  --dsw-alias-label-secondary: #c6cbd4;',
  '  --dsw-alias-label-tertiary: #adb2b8;',
  '  --dsw-alias-label-dimmed: #6b6f76;',
  '  --dsw-alias-label-primary-foreground: #0f1115;',
  '  --dsw-alias-border-l2: #ffffff33;',
  '  --dsw-alias-border-l3: #ffffff40;',
  '  --dsw-alias-border-l4: #ffffff26;',
  '  --dsw-alias-state-success-primary: #4ade80;',
  '  --dsw-alias-state-warn-label: #fbbf24;',
  '  --dsw-alias-state-error-primary: #f25a5a;',
  '  --dsw-alias-button-primary-fill: #79aaff;',
  '  --dsw-alias-button-primary-hover: #93bbff;',
  '  --dsw-alias-brand-primary: #79aaff;',
  '  --dsw-alias-state-business-primary: #79aaff;',
  '  --dsw-alias-interactive-bg-hover: #ffffff14;',
  '  --dsw-alias-interactive-bg-active: #ffffff24;',
  '  --dsw-alias-settings-card-fill: #2c2c2e;',
  '  --dsw-alias-settings-card-stroke: #ffffff1f;',
  '  --dsw-alias-bg-skeleton: rgba(255, 255, 255, 0.08);',
  '  color-scheme: dark;',
  '  --dsw-focus-ring-color: #79aaff;',
  '  --dsw-radius-panel: 16px;',
  '  --dsw-radius-md: 8px;',
  '  --dsw-radius-sm: 6px;',
  '  --dsw-radius-lg: 16px;',
  '  --dsw-radius-xl: 20px;',
  '  --dsw-elevation-prominent: 0 20px 70px #00000066;',
  '}',
].join('\n')

const SHELL = [
  'body {',
  '  margin: 0;',
  '  padding: 24px;',
  '  background: var(--dsw-alias-bg-layer-1);',
  '  color: var(--dsw-alias-label-primary);',
  "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
  '  font-size: 13px;',
  '  line-height: 1.5;',
  '}',
  '.dsh-screen { width: 100%; max-width: 640px; display: grid; gap: 12px; }',
  '.dsh-screen > * { min-width: 0; }',
  '.dsh-screen h2 { margin: 0; font-size: 15px; font-weight: 500; }',
].join('\n')

// Headless Chrome clamps its window to 500 CSS px wide, so a 390 px capture
// would show a 500 px layout cropped. The narrow page instead centres a 390 px
// containing block in that minimum window, and the capture script crops the
// image back to the block, so the component lays out at the audited width.
const NARROW_CANVAS = 500
const NARROW_CONTENT = 390

// The audited width comes from the file name; only the theme changes the page.
function page(bodyHtml, options = {}) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' +
    (options.dark === true ? DARK : LIGHT) +
    SHELL +
    providerSettingsCss +
    '</style></head><body>' +
    bodyHtml +
    '</body></html>'
  )
}

/** A page whose component sees a 390 px containing block inside the minimum window. */
function narrowPage(bodyHtml, options = {}) {
  const canvas = options.dark === true ? '#232324' : '#ffffff'
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>' +
    (options.dark === true ? DARK : LIGHT) +
    SHELL +
    providerSettingsCss +
    'html, body { margin: 0; padding: 0; width: ' +
    NARROW_CANVAS +
    'px; background: ' +
    canvas +
    '; }' +
    '.dsh-narrow { box-sizing: border-box; width: ' +
    NARROW_CONTENT +
    'px; margin: 0 auto; padding: 24px; }' +
    '</style></head><body><div class="dsh-narrow">' +
    bodyHtml +
    '</div></body></html>'
  )
}

const t = translator(en)

function statusOf(accounts) {
  return {
    busy: false,
    accounts: accounts.map((key, index) => ({ key, isDefault: index === 0 })),
  }
}

/** A fresh five-hour window 22% elapsed, matching the approved still. */
function pacedWindow(kind, usedPercent, durationMs, elapsedShare) {
  const now = Date.now()
  return {
    kind,
    usedPercent,
    startsAt: now - Math.round(durationMs * elapsedShare),
    resetsAt: now + Math.round(durationMs * (1 - elapsedShare)),
    windowDurationMs: durationMs,
  }
}

const CONFIGURED = {
  codex: {
    busy: false,
    clientVersion: { version: '9.9.9', source: 'npm' },
    accounts: [
      {
        key: 'codex-demo',
        isDefault: true,
        plan: 'plus',
        expiresAt: Date.UTC(2100, 0, 1, 0, 0),
      },
    ],
  },
  claude: statusOf([]),
  grok: statusOf([]),
  copilot: statusOf([]),
  antigravity: statusOf([]),
}

const USAGE = {
  ok: true,
  value: {
    supported: true,
    plan: 'plus',
    windows: [
      pacedWindow('session', 11, 5 * 3_600_000, 0.22),
      pacedWindow('weekly', 86, 7 * 86_400_000, 0.72),
    ],
    // A banked grant: the row states one is available and when it expires.
    resetCredits: [
      { id: 'codex-reset-1', expiresAt: Date.now() + 30 * 86_400_000 },
    ],
  },
}

/** One fake RPC: three scripted read answers, and renderable defaults elsewhere. */
function fakeRpc({ status, external, usage }) {
  return {
    async call(_channel, endpoint) {
      if (endpoint === 'subscriptions-auth.status')
        return status === undefined
          ? { ok: true, value: { providers: CONFIGURED } }
          : await status()
      if (endpoint === 'subscriptions-auth.externalStatus')
        return external === undefined
          ? { ok: true, value: { 'kimi-code': { configured: true } } }
          : await external()
      if (endpoint === 'subscriptions-auth.ollamaSettings')
        return {
          ok: true,
          value: {
            provider: 'ollama-cloud',
            settings: {},
            effective: {
              baseURL: 'http://localhost:11434',
              apiKeyRef: 'OLLAMA_API_KEY',
              web: false,
            },
            models: [],
            configOverridesModels: false,
            keyUsable: true,
          },
        }
      if (endpoint === 'subscriptions-auth.usage')
        return usage === undefined ? USAGE : await usage()
      if (endpoint === 'subscriptions-auth.keySetCredential')
        return {
          ok: true,
          value: {
            committed: true,
            generation: 1,
            view: {
              route: 'cursor',
              keyRef: 'CURSOR_API_KEY',
              configured: true,
              source: 'file',
              writable: true,
              masked: 'sk-…9f2c',
            },
          },
        }
      if (endpoint === 'subscriptions-auth.keyValidateCredential')
        return { ok: true, value: { outcome: 'invalid' } }
      if (endpoint === 'subscriptions-auth.keyCredential')
        return {
          ok: true,
          value: {
            route: 'cursor',
            keyRef: 'CURSOR_API_KEY',
            configured: true,
            source: 'file',
            writable: true,
            masked: 'sk-…9f2c',
          },
        }
      return { ok: true, value: {} }
    },
  }
}

function findRow(component, label) {
  const header = nodes(component.tree).find(
    (node) =>
      node.type === 'button' &&
      node.props['aria-expanded'] !== undefined &&
      text(node).includes(label),
  )
  if (header === undefined) throw new Error('no ' + label + ' row')
  return header
}

async function sectionBody({ rpc, expand, attention }) {
  const component = new Component(() => SubscriptionsSection({ rpc, t }))
  await settle(component)
  if (attention === true) {
    // Open the form and let it hand the page its rejected-key verdict, the way
    // the real flow does when the reader leaves a key the route cannot use.
    buttonIn(component, en.rosterAdd).props.onClick()
    await settle(component)
    const form = nodes(component.tree).find(
      (node) => node.type === AddProviderForm,
    )
    if (form === undefined) throw new Error('no add form')
    form.props.onNeedsAttention('cursor')
    form.props.onCancel()
    await settle(component)
  }
  if (typeof expand === 'string') {
    findRow(component, expand).props.onClick()
    await settle(component)
  }
  return renderToStaticMarkup(component.tree)
}

function screen(title, body) {
  return (
    '<section class="dsh-screen"><h2>' + title + '</h2>' + body + '</section>'
  )
}

function formProps(overrides) {
  return {
    rpc: overrides.rpc ?? fakeRpc({}),
    t,
    configured: new Set(overrides.configured ?? ['codex']),
    ollamaSettings: {
      provider: 'ollama-cloud',
      settings: {},
      effective: {
        baseURL: 'http://localhost:11434',
        apiKeyRef: 'OLLAMA_API_KEY',
        web: false,
      },
      models: [],
      configOverridesModels: false,
      keyUsable: true,
    },
    statuses: overrides.statuses ?? {},
    deviceCodes: overrides.deviceCodes ?? {},
    errors: {},
    copiedCode: undefined,
    onStartLogin: () => undefined,
    onCancelAttempt: () => undefined,
    onManualSubmit: () => undefined,
    onCopyDeviceCode: () => undefined,
    onCancel: () => undefined,
    onConfirmed: () => undefined,
    onNeedsAttention: () => undefined,
  }
}

async function formBody({ choose, after }) {
  const component = new Component(() => AddProviderForm(formProps({})))
  await settle(component)
  if (choose !== undefined) {
    nodes(component.tree)
      .find((node) => node.type === 'select')
      .props.onChange({ currentTarget: { value: choose } })
    await settle(component)
  }
  if (after !== undefined) await after(component)
  // The settings panel supplies the scope class the native control styles hang
  // on; without it the capture would show an unstyled form.
  return (
    '<div class="dsh-subscriptions-settings">' +
    renderToStaticMarkup(component.tree) +
    '</div>'
  )
}

function buttonIn(component, label) {
  return nodes(component.tree).find(
    (node) => node.type === 'button' && text(node) === label,
  )
}

const writes = []
const add = (name, html) => writes.push([name, html])

const rosterConfigured = screen(
  'Settings · Subscriptions · configured providers',
  await sectionBody({ rpc: fakeRpc({}) }),
)
const rosterExpanded = screen(
  'Settings · Subscriptions · one row expanded',
  await sectionBody({ rpc: fakeRpc({}), expand: 'Codex' }),
)
const rosterEmpty = screen(
  'Settings · Subscriptions · nothing configured',
  await sectionBody({
    rpc: fakeRpc({
      status: async () => ({
        ok: true,
        value: {
          providers: {
            codex: statusOf([]),
            claude: statusOf([]),
            grok: statusOf([]),
            copilot: statusOf([]),
            antigravity: statusOf([]),
          },
        },
      }),
      external: async () => ({ ok: true, value: {} }),
    }),
  }),
)
const rosterChecking = screen(
  'Settings · Subscriptions · checking',
  await sectionBody({
    rpc: fakeRpc({
      status: () => new Promise(() => {}),
      external: () => new Promise(() => {}),
    }),
  }),
)
const rosterFailed = screen(
  'Settings · Subscriptions · the read failed',
  await sectionBody({
    rpc: fakeRpc({
      status: async () => ({ ok: false, error: { message: 'offline' } }),
      external: async () => ({ ok: false, error: { message: 'offline' } }),
    }),
  }),
)

// The needs-attention state comes from the form's verdict rather than from the
// configured set, so it renders the roster view directly with that verdict.
const attentionRows = configuredRows({
  statuses: CONFIGURED,
  routes: {
    configured: {
      cursor: { configured: true },
      'kimi-code': { configured: true },
    },
    ollama: {},
  },
  attention: new Set(['cursor']),
})
const rosterAttentionRetained = screen(
  'Settings · Subscriptions · a rejected key stays saved, and the row says so',
  await sectionBody({
    rpc: fakeRpc({
      external: async () => ({
        ok: true,
        value: {
          cursor: { configured: true },
          'kimi-code': { configured: true },
        },
      }),
    }),
    attention: true,
  }),
)
const rosterAttention = screen(
  'Settings · Subscriptions · a saved key the route cannot use',
  renderToStaticMarkup(
    // The scope class is what the settings panel puts around the section; the
    // roster's own controls inherit the native styling from it.
    createElement(
      'div',
      { className: 'dsh-subscriptions-settings' },
      ProviderRoster({
        t,
        rows: attentionRows,
        phase: 'ready',
        expanded: new Set(),
        onToggle: () => undefined,
        onAdd: () => undefined,
        onRetry: () => undefined,
        renderDetail: () => null,
      }),
    ),
  ),
)

const bandOpen = screen(
  'Settings · Subscriptions · quota display preferences',
  (await sectionBody({ rpc: fakeRpc({}) })).replace(
    '<details>',
    '<details open>',
  ),
)

add('roster-configured-1280-light', rosterConfigured)
add('roster-configured-768-light', rosterConfigured)
add('roster-configured-390-light', rosterConfigured)
add('roster-configured-1280-dark', rosterConfigured)
add('roster-configured-390-dark', rosterConfigured)
add('roster-expanded-1280-light', rosterExpanded)
add('roster-expanded-390-dark', rosterExpanded)
add('roster-empty-1280-light', rosterEmpty)
add('roster-checking-1280-light', rosterChecking)
add('roster-failed-1280-light', rosterFailed)
add('roster-attention-1280-light', rosterAttention)
add('roster-attention-390-dark', rosterAttention)
add('roster-attention-retained-1280-light', rosterAttentionRetained)
add('roster-attention-retained-390-dark', rosterAttentionRetained)
add('roster-preferences-768-light', bandOpen)

const formEmpty = screen(
  'Settings · Subscriptions · add a provider',
  await formBody({}),
)
const formCursor = screen(
  'Add provider · Cursor',
  await formBody({ choose: 'cursor' }),
)
const formOllamaLocal = screen(
  'Add provider · Ollama local server',
  await formBody({
    choose: 'ollama',
    after: async (component) => {
      buttonIn(component, en.addConnectionLocal).props.onClick()
      await settle(component)
    },
  }),
)
const formManaged = screen(
  'Add provider · a key Settings → Models owns',
  await formBody({ choose: 'kimi-code' }),
)
const formCursorRejected = screen(
  'Add provider · a key the route cannot use',
  await formBody({
    choose: 'cursor',
    after: async (component) => {
      const input = nodes(component.tree).find(
        (node) => node.type === 'input' && node.props.type === 'password',
      )
      if (input === undefined) throw new Error('no key field')
      input.props.onChange({ target: { value: 'sk-not-a-real-key' } })
      await settle(component)
      buttonIn(component, en.addSave).props.onClick()
      await settle(component)
    },
  }),
)

add('form-empty-1280-light', formEmpty)
add('form-cursor-1280-light', formCursor)
add('form-cursor-768-light', formCursor)
add('form-cursor-390-light', formCursor)
add('form-cursor-390-dark', formCursor)
add('form-cursor-rejected-1280-light', formCursorRejected)
add('form-cursor-rejected-390-dark', formCursorRejected)
add('form-ollama-local-1280-light', formOllamaLocal)
add('form-ollama-local-390-light', formOllamaLocal)
add('form-ollama-local-390-dark', formOllamaLocal)
add('form-managed-1280-light', formManaged)

// The waiting and device-code states need the page's attempt state, so they
// mount the form with the status the page would pass down, then start the
// attempt the form owns.
async function waitingBody({ provider, statuses, deviceCodes }) {
  const component = new Component(() =>
    AddProviderForm(
      formProps({
        statuses: statuses ?? {},
        deviceCodes: deviceCodes ?? {},
      }),
    ),
  )
  await settle(component)
  nodes(component.tree)
    .find((node) => node.type === 'select')
    .props.onChange({ currentTarget: { value: provider } })
  await settle(component)
  const primary =
    provider === 'copilot' ? en.addGetDeviceCode : en.addContinueBrowser
  buttonIn(component, primary).props.onClick()
  await settle(component)
  return (
    '<div class="dsh-subscriptions-settings">' +
    renderToStaticMarkup(component.tree) +
    '</div>'
  )
}

add(
  'form-waiting-browser-390-dark',
  screen(
    'Add provider · waiting for the browser',
    // A browser-only provider, with the manual fallback open: the shape a
    // headless reader meets.
    (
      await waitingBody({
        provider: 'claude',
        statuses: { claude: { busy: true, accounts: [] } },
      })
    ).replace('<details>', '<details open>'),
  ),
)
add(
  'form-device-code-1280-light',
  screen(
    'Add provider · GitHub device code',
    await waitingBody({
      provider: 'copilot',
      statuses: { copilot: { busy: true, accounts: [] } },
      deviceCodes: {
        copilot: {
          userCode: 'ABCD-1234',
          verificationUrl: 'https://github.com/login/device',
        },
      },
    }),
  ),
)

// The docs screenshot: the settings section alone, in the light theme, at the
// width the settings panel gives it. No capture title — the page is the subject.
const docsWidth = 608
const docsHeight = 420
const docsFile = join(outDir, 'docs-subscriptions.html')
const docsSection = await sectionBody({ rpc: fakeRpc({}) })
writeFileSync(
  docsFile,
  page(docsSection, {})
    .replace(
      '</style>',
      'html, body { width: ' +
        docsWidth +
        'px; } body { display: flex; align-items: center; min-height: ' +
        docsHeight +
        'px; box-sizing: border-box; }</style>',
    )
    .replace('<body>', '<body style="padding: 24px">'),
)
const docsPng = join(outDir, 'docs-subscriptions.png')
execFileSync(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=2',
  '--window-size=' + docsWidth + ',' + docsHeight,
  '--screenshot=' + docsPng,
  '--virtual-time-budget=1500',
  'file://' + docsFile,
])
console.log('captured ' + docsPng)

for (const [name, body] of writes) {
  // A still labeled expanded must actually show its open row: a generator that
  // silently stops expanding would otherwise ship a collapsed picture as proof.
  if (/-expanded-/.test(name)) {
    if (!body.includes('aria-expanded="true"'))
      throw new Error(name + ': labeled expanded but no row is open')
    for (const marker of [
      'CLI 9.9.9 · latest on npm',
      '5-hour window',
      'Weekly',
      '1 available',
    ]) {
      if (!body.includes(marker))
        throw new Error(name + ': the open row is missing ' + marker)
    }
  }
  const narrow = /-390-/.test(name)
  const dark = /-dark$/.test(name)
  const file = join(outDir, name + '.html')
  writeFileSync(
    file,
    narrow ? narrowPage(body, { dark }) : page(body, { dark }),
  )
  const png = join(outDir, name + '.png')
  // The capture width comes from the file name, so one fixture serves the
  // three audited widths without a second source for the size.
  const width = narrow ? NARROW_CANVAS : /-768-/.test(name) ? 768 : 1280
  const height = narrow ? 1400 : /-768-/.test(name) ? 1100 : 900
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--window-size=' + width + ',' + height,
    '--screenshot=' + png,
    '--virtual-time-budget=1500',
    'file://' + file,
  ])
  if (narrow) {
    // Crop the centred 390 px block out of the 500 px window at 2x.
    execFileSync('sips', [
      '-c',
      String(height * 2),
      String(NARROW_CONTENT * 2),
      png,
    ])
  }
  console.log('captured ' + png)
}
