/**
 * Live-browser probe for the add-provider form and the roster.
 *
 * The stills are static markup, which cannot answer what the Designer asks a
 * browser to prove: 44 px targets, a pending action that reads unavailable while
 * it keeps focus, focus landing in the chosen provider's field, and no horizontal
 * overflow. This drives headless Chrome over its debugging protocol at a real
 * 390, 768, or 1280 CSS px viewport, injects the same pages the stills use, and
 * writes the measurements to .cache/provider-form-probe/report.json.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname
const STILLS = join(ROOT, '.cache/provider-roster-screens')
const OUT = join(ROOT, '.cache/provider-form-probe')
const CHROME =
  process.env.CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333
const TARGET_PX = 44

/** One case: the still to drive, and the viewport it was audited at. */
const CASES = [
  ['form-cursor-1280-light', 1280, 900],
  ['form-cursor-768-light', 768, 1000],
  ['form-cursor-390-light', 390, 1400],
  ['form-cursor-390-dark', 390, 1400],
  ['form-ollama-local-390-light', 390, 1400],
  ['form-ollama-local-390-dark', 390, 1400],
  ['form-waiting-browser-390-dark', 390, 1400],
  ['form-device-code-1280-light', 1280, 900],
  ['form-cursor-rejected-1280-light', 1280, 900],
  ['form-cursor-rejected-390-dark', 390, 1400],
  ['roster-configured-390-light', 390, 1200],
  ['roster-configured-1280-light', 1280, 900],
  ['roster-expanded-1280-light', 1280, 900],
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Read the page target's websocket URL once Chrome is listening. */
async function debuggerUrl() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const answer = await fetch('http://127.0.0.1:' + PORT + '/json/version')
      const body = await answer.json()
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl
    } catch {
      // Not listening yet.
    }
    await sleep(100)
  }
  throw new Error('Chrome did not open its debugging port')
}

/** A tiny CDP session over Node's built-in WebSocket. */
class Session {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Set()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && this.pending.has(message.id)) {
        const settle = this.pending.get(message.id)
        this.pending.delete(message.id)
        settle(message)
        return
      }
      if (message.method !== undefined) {
        for (const listener of this.listeners) listener(message)
      }
    })
  }
  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  send(method, params = {}, sessionId) {
    const id = (this.nextId += 1)
    const message = { id, method, params }
    if (sessionId !== undefined) message.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, (answer) => {
        if (answer.error)
          reject(new Error(method + ': ' + answer.error.message))
        else resolve(answer.result)
      })
      this.socket.send(JSON.stringify(message))
    })
  }
}

/** Wait for one named event, from any session. */
function waitForEvent(session, name) {
  return new Promise((resolve) => {
    const stop = session.onEvent((message) => {
      if (message.method !== name) return
      stop()
      resolve(message.params)
    })
  })
}

/** The page expression that measures the form's controls and focus behaviour. */
const MEASURE = `(() => {
  // The controls this change adds: the form's own fields, and on the roster its
  // row headers and the add action. The preference selects and the older detail
  // controls predate the change and keep their compact geometry.
  const form = document.querySelector('.dsh-add-provider-form')
  const scope = form || document.querySelector('.dsh-subscriptions-settings')
  const block = document.querySelector('.dsh-narrow') || scope || document.body
  const controlSelector = form
    ? 'button, input:not([type="checkbox"]), select, summary, textarea'
    : '[aria-expanded], button.dsh-subscription-primary'
  const controls = [...(scope ?? document).querySelectorAll(controlSelector)]
  const labelOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || el.type || el.tagName).trim().slice(0, 40)
  const rows = controls.map((el) => {
    const rect = el.getBoundingClientRect()
    return {
      tag: el.tagName.toLowerCase(),
      label: labelOf(el),
      height: Math.round(rect.height * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      disabled: el.disabled === true,
      ariaDisabled: el.getAttribute('aria-disabled'),
      opacity: getComputedStyle(el).opacity,
      cursor: getComputedStyle(el).cursor,
    }
  })
  const pending = [...(scope ?? document).querySelectorAll('[aria-disabled="true"]')]
  const pendingReport = pending.map((el) => {
    el.focus()
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
      label: labelOf(el),
      focused: document.activeElement === el,
      opacity: style.opacity,
      cursor: style.cursor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      background: style.backgroundColor,
      center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    }
  })
  // A disabled control is unfocusable by design, not by a defect.
  const all = [...(scope ?? document).querySelectorAll(controlSelector)]
  const disabledReport = all.filter((el) => el.disabled === true).map((el) => labelOf(el))
  const focusables = all.filter((el) => el.disabled !== true)
  const focusReport = focusables.slice(0, 12).map((el) => {
    el.focus()
    const rect = el.getBoundingClientRect()
    return {
      label: labelOf(el),
      focused: document.activeElement === el,
      insideViewport: rect.top >= -1 && rect.left >= -1 && rect.right <= window.innerWidth + 1,
      height: Math.round(rect.height * 10) / 10,
    }
  })
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    block: { clientWidth: block.clientWidth, scrollWidth: block.scrollWidth },
    documentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    controls: rows,
    pending: pendingReport,
    disabled: disabledReport,
    focus: focusReport,
  }
})()`

const main = async () => {
  mkdirSync(OUT, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
  ])
  const report = []
  try {
    const socket = new WebSocket(await debuggerUrl())
    await new Promise((resolve) => socket.addEventListener('open', resolve))
    const session = new Session(socket)
    const page = await session.send('Target.createTarget', {
      url: 'about:blank',
    })
    const attached = await session.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    })
    const sid = attached.sessionId
    await session.send('Page.enable', {}, sid)
    await session.send('Runtime.enable', {}, sid)
    for (const [name, width, height] of CASES) {
      const html = readFileSync(join(STILLS, name + '.html'), 'utf8')
      // A narrow still is a 390 px block inside Chrome's 500 px minimum window;
      // here the viewport itself is 390, so the block is widened to fill it.
      const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
      await session.send(
        'Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: 2, mobile: false },
        sid,
      )
      const loaded = waitForEvent(session, 'Page.loadEventFired')
      await session.send('Page.navigate', { url }, sid)
      await loaded
      await session.send(
        'Runtime.evaluate',
        {
          expression:
            'if (!/\\.dsh-narrow/.test(document.documentElement.outerHTML)) true; else ' +
            '(() => { const style = document.createElement("style"); style.textContent = ' +
            '"html,body{width:' +
            width +
            'px!important;margin:0} .dsh-narrow{width:' +
            width +
            'px;margin:0;box-sizing:border-box}"; ' +
            'document.head.append(style); return true })()',
        },
        sid,
      )
      const measured = await session.send(
        'Runtime.evaluate',
        { expression: MEASURE, returnByValue: true },
        sid,
      )
      const value = measured.result?.value ?? {}
      report.push({ name, width, ...value })
      // Hover has to be driven for real: a selector can leak a hover background
      // that a static measurement never sees.
      if ((value.pending ?? []).length > 0) {
        const target = value.pending[0].center
        await session.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: target.x, y: target.y },
          sid,
        )
        const hovered = await session.send(
          'Runtime.evaluate',
          {
            expression:
              '(() => [...document.querySelectorAll(\'[aria-disabled="true"]\')]' +
              '.map((el) => getComputedStyle(el).backgroundColor))()',
            returnByValue: true,
          },
          sid,
        )
        value.pendingHover = hovered.result?.value ?? []
        await session.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: 2, y: 2 },
          sid,
        )
      }
      // A positive control proves the hover probe itself works: an enabled
      // primary must change its background under the pointer.
      const ENABLED_PRIMARY =
        "button.dsh-subscription-primary:not([aria-disabled='true']):not(:disabled)"
      const control = await session.send(
        'Runtime.evaluate',
        {
          expression:
            '(() => { const el = document.querySelector("' +
            ENABLED_PRIMARY +
            '");' +
            ' if (el === null) return null; const rect = el.getBoundingClientRect();' +
            ' return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,' +
            ' background: getComputedStyle(el).backgroundColor } })()',
          returnByValue: true,
        },
        sid,
      )
      if (control.result?.value) {
        await session.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseMoved',
            x: control.result.value.x,
            y: control.result.value.y,
          },
          sid,
        )
        const hoveredControl = await session.send(
          'Runtime.evaluate',
          {
            expression:
              '(() => { const el = document.querySelector("' +
              ENABLED_PRIMARY +
              '");' +
              ' return el === null ? null : getComputedStyle(el).backgroundColor })()',
            returnByValue: true,
          },
          sid,
        )
        value.controlHover = {
          before: control.result.value.background,
          after: hoveredControl.result?.value ?? null,
        }
        await session.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: 2, y: 2 },
          sid,
        )
      }
      const shot = await session.send(
        'Page.captureScreenshot',
        { format: 'png' },
        sid,
      )
      writeFileSync(join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'))
    }
    socket.close()
  } finally {
    chrome.kill()
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  let failures = 0
  for (const page of report) {
    const short = page.controls.filter((control) => control.height < TARGET_PX)
    // A pending action must read exactly like a disabled one, keep its focus, keep
    // the focus ring, and keep its resting background while the pointer is over it.
    const pendingProblems = page.pending.filter(
      (entry) =>
        entry.focused !== true ||
        Number(entry.opacity) > 0.41 ||
        entry.cursor !== 'default' ||
        entry.outlineStyle === 'none' ||
        Number.parseFloat(entry.outlineWidth) < 1 ||
        (page.pendingHover ?? []).some((background, index) =>
          index === page.pending.indexOf(entry)
            ? background !== entry.background
            : false,
        ),
    )
    const unfocused = page.focus.filter((entry) => entry.focused !== true)
    if (short.length > 0) failures += 1
    if (pendingProblems.length > 0) failures += 1
    if (page.block.scrollWidth > page.block.clientWidth) failures += 1
    if (unfocused.length > 0) failures += 1
    if (
      page.controlHover !== undefined &&
      page.controlHover.before === page.controlHover.after
    ) {
      failures += 1
      console.log(
        page.name + ' · the hover probe changed nothing, so hover is unproven',
      )
    }
    console.log(
      page.name +
        ' · ' +
        page.viewport.width +
        'px · controls ' +
        page.controls.length +
        ' · under ' +
        TARGET_PX +
        ': ' +
        (short.length === 0
          ? 'none'
          : short
              .map((c) => c.tag + ':' + c.label + '=' + c.height)
              .join(', ')) +
        ' · pending: ' +
        (page.pending.length === 0 ? 'n/a' : JSON.stringify(page.pending)) +
        ' · overflow: ' +
        (page.block.scrollWidth > page.block.clientWidth ? 'YES' : 'no') +
        ' · unfocusable: ' +
        (unfocused.length === 0
          ? 'none'
          : unfocused.map((f) => f.label).join(', ')) +
        ' · disabled by design: ' +
        (page.disabled.length === 0 ? 'none' : page.disabled.join(', ')),
    )
  }
  console.log(
    failures === 0
      ? 'probe: all checks passed'
      : 'probe: ' + failures + ' problem(s)',
  )
  if (failures > 0) process.exitCode = 1

  // Keep the launcher honest: screenshots above come from the same page.
  execFileSync('true', [])
}

await main()
