/**
 * The interactive focus proof for the subscriptions page.
 *
 * The static stills and the geometry probe cannot show focus *moving*: one shows
 * a picture, the other places focus itself. This mounts the shipped section
 * against a fake RPC in a real browser and reads document.activeElement after
 * each step, so the component is the only thing that moves focus — the driver
 * never calls focus(). Buttons are clicked for real and the key is typed as key
 * events; the provider selection is injected as a change on the native select,
 * because a headless select popup does not accept a scripted choice. No provider
 * is called and no credential is real.
 *
 * Writes .cache/focus-flow-proof/result.json and a screenshot per step; exits
 * non-zero when a step disagrees with the requirement.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchChrome } from './cdp.mjs'

const OUT = '.cache/focus-flow-proof'
const PORT = 9444

/** Resolve one dependency from the pnpm store, the way the repo's other check does. */
function packagePath(name) {
  const dependencies = readdirSync('node_modules/.pnpm')
  const entry = dependencies.find((candidate) =>
    candidate.startsWith(name + '@'),
  )
  if (entry === undefined) throw new Error('missing package: ' + name)
  return resolve('node_modules/.pnpm', entry, 'node_modules', name)
}

const { build } = await import(
  pathToFileURL(packagePath('rolldown') + '/dist/index.mjs').href
)
const bundle = await build({
  input: 'test/provider-roster-focus.fixture.tsx',
  resolve: {
    alias: { 'react-dom/client': packagePath('react-dom') + '/client.js' },
  },
  transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  output: { format: 'iife' },
  write: false,
})
const code = bundle.output.find((file) => file.type === 'chunk').code
if (typeof code !== 'string') throw new Error('the fixture produced no bundle')

// Host tokens the section's inline styles read; the values are the light theme's.
const TOKENS = [
  ':root{',
  '--dsw-alias-bg-layer-1:#f6f7fa;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-layer-3:#f1f2f6;',
  '--dsw-alias-label-primary:#20212b;--dsw-alias-label-secondary:#4b4d5c;--dsw-alias-label-tertiary:#626575;',
  '--dsw-alias-label-primary-foreground:#fff;--dsw-alias-border-l1:#e6e7ee;--dsw-alias-border-l2:#dedee6;',
  '--dsw-alias-border-l3:#d3d4de;--dsw-alias-border-l4:#c7c8d4;',
  '--dsw-alias-state-business-primary:#2f6fed;--dsw-alias-state-error-primary:#b42318;',
  '--dsw-alias-button-primary-fill:#2f6fed;--dsw-alias-button-primary-hover:#255bc7;',
  '--dsw-alias-interactive-bg-hover:#eef0f6;--dsw-alias-interactive-bg-active:#e6e9f2;',
  '--dsw-alias-bg-skeleton:#eceef4;--dsw-alias-bg-mask-1:#10132966;',
  '--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#2f6fed;',
  '--dsw-radius-sm:6px;--dsw-radius-md:8px;--dsw-radius-lg:16px;--dsw-radius-panel:16px;',
  '}',
  'body{margin:0;padding:24px;background:#f6f7fa;color:#20212b;',
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.5}',
].join('')

const page =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<style>' +
  TOKENS +
  '</style></head><body><div id="root"></div>' +
  '<script>' +
  code +
  '</' +
  'script></body></html>'

mkdirSync(OUT, { recursive: true })
const pagePath = resolve(OUT, 'harness.html')
writeFileSync(pagePath, page)

const chrome = await launchChrome(PORT)
// An uncaught page error would let the proof pass on a page that never mounted.
const exceptions = []
chrome.transport.onEvent((message) => {
  if (message.method !== 'Runtime.exceptionThrown') return
  exceptions.push(
    message.params?.exceptionDetails?.exception?.description ??
      message.params?.exceptionDetails?.text ??
      'unknown',
  )
})
const steps = []
const check = (name, condition, detail) => {
  steps.push({
    name,
    passed: condition === true,
    ...(detail === undefined ? {} : { detail }),
  })
  if (condition !== true) {
    console.log(
      'FAILED · ' +
        name +
        (detail === undefined ? '' : ' · ' + JSON.stringify(detail)),
    )
  } else {
    console.log(
      'ok · ' +
        name +
        (detail === undefined ? '' : ' · ' + JSON.stringify(detail)),
    )
  }
}

/** Read what the page currently has focused, in the reader's terms. */
const ACTIVE =
  '(() => { const el = document.activeElement; if (el === null) return null;' +
  ' const labelled = el.labels && el.labels.length > 0 ? el.labels[0].textContent : "";' +
  ' const name = el.getAttribute("aria-label") || labelled || el.textContent || "";' +
  ' return { tag: el.tagName.toLowerCase(), label: name.trim().replace(/\\s+/g, " ").slice(0, 60),' +
  ' type: el.getAttribute("type"), role: el.getAttribute("role") } })()'

try {
  await chrome.viewport(1280, 1000)
  await chrome.navigate(pathToFileURL(pagePath).href)
  await chrome.waitFor('window.ready === true')
  await chrome.screenshot(resolve(OUT, 'step-1-roster.png'))

  // 1. Open the form with a real click.
  await chrome.clickOn(
    '[...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "+ Add provider")',
  )
  await chrome.waitFor(
    'document.querySelector(".dsh-add-provider-form") !== null',
  )
  await chrome.screenshot(resolve(OUT, 'step-2-form-open.png'))

  // 2. Choose Cursor. The choice is injected as a change on the native select —
  //    a headless select popup does not take a scripted pick — and the point of
  //    this step is what the component does next: it must focus the field itself.
  await chrome.evaluate(
    '(() => { const select = document.querySelector("select");' +
      ' const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;' +
      ' setter.call(select, "cursor"); select.dispatchEvent(new Event("change", { bubbles: true })); })()',
  )
  const chosenValue = await chrome.evaluate(
    'document.querySelector("select").value',
  )
  check('the choice reached the component', chosenValue === 'cursor', {
    chosenValue,
  })
  await chrome.waitFor(
    'document.querySelector("input[type=password]") !== null',
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  const focusedField = await chrome.evaluate(ACTIVE)
  check(
    'choosing a provider focuses its first field',
    focusedField !== null &&
      focusedField.tag === 'input' &&
      focusedField.type === 'password' &&
      focusedField.label === 'Cursor API key',
    focusedField,
  )
  await chrome.screenshot(resolve(OUT, 'step-3-field-focused.png'))

  // 3. Type a fictitious key into whatever the component focused.
  await chrome.type('sk-fictitious-focus-proof')
  const typed = await chrome.evaluate(
    'document.querySelector("input[type=password]").value',
  )
  check(
    'typing lands in the field the component focused',
    typed === 'sk-fictitious-focus-proof',
    {
      typed,
    },
  )

  const primaryState = await chrome.evaluate(
    '(() => { const el = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Save");' +
      ' return el === undefined ? null : { disabled: el.disabled, ariaDisabled: el.getAttribute("aria-disabled") } })()',
  )
  check(
    'the primary is available once the field holds a value',
    primaryState !== null &&
      primaryState.disabled === false &&
      primaryState.ariaDisabled === null,
    primaryState,
  )

  // A real click only reaches the handler if the point belongs to the button.
  const hit = await chrome.evaluate(
    '(() => { const el = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Save");' +
      ' if (el === undefined) return null; el.scrollIntoView({ block: "center" });' +
      ' const rect = el.getBoundingClientRect(); const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;' +
      ' const at = document.elementFromPoint(x, y);' +
      ' return { x, y, hit: at === null ? null : at.tagName.toLowerCase() + ":" + (at.textContent || "").trim().slice(0, 24) } })()',
  )
  check(
    'the primary is the element under the click point',
    hit !== null && String(hit.hit).startsWith('button'),
    hit,
  )

  // 4. Submit with a real click; the route accepts the fictitious key.
  await chrome.clickOn(
    '[...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "Save")',
  )
  let closed = true
  try {
    await chrome.waitFor(
      'document.querySelector(".dsh-add-provider-form") === null',
      4000,
    )
  } catch {
    closed = false
  }
  if (!closed) {
    const alert = await chrome.evaluate(
      '(() => { const line = document.querySelector("[role=alert]"); return line === null ? null : line.textContent.trim() })()',
    )
    const calls = await chrome.evaluate(
      'window.calls.map((call) => call.endpoint)',
    )
    const panelText = await chrome.evaluate(
      '(() => { const panel = document.querySelector(".dsh-add-provider-form"); return panel === null ? null : panel.textContent.trim().slice(0, 300) })()',
    )
    await chrome.screenshot(resolve(OUT, 'step-4-did-not-close.png'))
    throw new Error(
      'the form did not close after saving; alert=' +
        String(alert) +
        ' calls=' +
        JSON.stringify(calls) +
        ' text=' +
        String(panelText),
    )
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
  const focusedAfter = await chrome.evaluate(ACTIVE)
  check(
    'the confirmation returns focus to the list heading',
    focusedAfter !== null &&
      focusedAfter.tag === 'h2' &&
      focusedAfter.label === 'Configured providers' &&
      focusedAfter.role === null,
    focusedAfter,
  )
  await chrome.screenshot(resolve(OUT, 'step-4-focus-returned.png'))

  // 5. The new row exists, collapsed, and the earlier rows are untouched.
  const rows = await chrome.evaluate(
    '(() => [...document.querySelectorAll("button[aria-expanded]")].map((el) => ({' +
      ' label: el.textContent.trim(), expanded: el.getAttribute("aria-expanded") })))()',
  )
  const labels = rows.map((row) => row.label)
  check(
    'the new provider has one collapsed row',
    rows.filter((row) => row.label.startsWith('Cursor')).length === 1 &&
      rows.some(
        (row) => row.label.startsWith('Cursor') && row.expanded === 'false',
      ),
    { rows: labels },
  )
  check(
    'the earlier rows are retained',
    rows.some((row) => row.label.startsWith('Codex')) &&
      rows.some((row) => row.label.startsWith('Kimi Code')),
    { rows: labels },
  )
  const outcome = await chrome.evaluate(
    '(() => { const line = document.querySelector("[role=status]"); return line === null ? null : line.textContent.trim() })()',
  )
  check(
    'the outcome line names the provider',
    String(outcome).includes('Cursor'),
    { outcome },
  )

  // 6. Reopening the form and leaving it returns focus to the roster too.
  await chrome.clickOn(
    '[...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "+ Add provider")',
  )
  await chrome.waitFor(
    'document.querySelector(".dsh-add-provider-form") !== null',
  )
  await chrome.clickOn(
    '[...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "Cancel")',
  )
  await new Promise((resolve) => setTimeout(resolve, 200))
  const focusedAfterCancel = await chrome.evaluate(ACTIVE)
  check(
    'canceling returns focus to the list heading',
    focusedAfterCancel !== null &&
      focusedAfterCancel.tag === 'h2' &&
      focusedAfterCancel.label === 'Configured providers',
    focusedAfterCancel,
  )
  await chrome.screenshot(resolve(OUT, 'step-5-after-cancel.png'))

  check('the page raised no uncaught error', exceptions.length === 0, {
    exceptions,
  })
  const state = await chrome.evaluate(
    '({ calls: window.calls.map((call) => call.endpoint) })',
  )
  check(
    'the write went through the credential endpoints',
    state.calls.includes('subscriptions-auth.keySetCredential') &&
      state.calls.includes('subscriptions-auth.keyValidateCredential'),
    { calls: state.calls },
  )
  writeFileSync(
    resolve(OUT, 'result.json'),
    JSON.stringify({ steps, rows, outcome, calls: state.calls }, null, 2),
  )
} finally {
  await chrome.close()
}

const failed = steps.filter((step) => step.passed !== true)
console.log(
  failed.length === 0
    ? 'focus proof: all ' + steps.length + ' checks passed'
    : 'focus proof: ' +
        failed.length +
        ' of ' +
        steps.length +
        ' checks failed',
)
if (failed.length > 0) process.exitCode = 1
