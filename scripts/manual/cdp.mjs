/**
 * A small Chrome DevTools Protocol driver for the manual browser proofs.
 *
 * Node has a WebSocket client, so a headless Chrome can be driven without
 * installing a browser-automation package: launch it on a debugging port, attach
 * to a page target, and speak the protocol. Every helper here takes real input
 * (mouse, text) so a proof can observe what the component does with focus rather
 * than placing focus itself.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CHROME =
  process.env.CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Read the debugging websocket URL once Chrome is listening. */
async function debuggerUrl(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const answer = await fetch('http://127.0.0.1:' + port + '/json/version')
      const body = await answer.json()
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl
    } catch {
      // Not listening yet.
    }
    await sleep(100)
  }
  throw new Error('Chrome did not open its debugging port')
}

/** One protocol conversation: commands by id, events by listener. */
class Transport {
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

/**
 * Launch a headless Chrome and attach to one page.
 * @param port - debugging port to listen on.
 * @returns the page driver and a close function.
 */
export async function launchChrome(port) {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-cdp-'))
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
  ])
  const socket = new WebSocket(await debuggerUrl(port))
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  const transport = new Transport(socket)
  const target = await transport.send('Target.createTarget', {
    url: 'about:blank',
  })
  const attached = await transport.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const sid = attached.sessionId
  await transport.send('Page.enable', {}, sid)
  await transport.send('Runtime.enable', {}, sid)
  return {
    transport,
    sid,
    /** Size the viewport in CSS pixels. */
    async viewport(width, height) {
      await transport.send(
        'Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: 2, mobile: false },
        sid,
      )
    },
    /** Load a URL and wait for its load event. */
    async navigate(url) {
      const loaded = new Promise((resolve) => {
        const stop = transport.onEvent((message) => {
          if (message.method !== 'Page.loadEventFired') return
          stop()
          resolve()
        })
      })
      await transport.send('Page.navigate', { url }, sid)
      await loaded
    },
    /** Run an expression in the page and return its value. */
    async evaluate(expression) {
      const answer = await transport.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sid,
      )
      if (answer.exceptionDetails !== undefined) {
        const described =
          answer.exceptionDetails.exception?.description ??
          answer.exceptionDetails.text
        throw new Error('page error: ' + described)
      }
      return answer.result?.value
    },
    /** Wait until an expression returns truthy. */
    async waitFor(expression, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (await this.evaluate(expression)) return
        await sleep(50)
      }
      throw new Error('timed out waiting for: ' + expression)
    },
    /** Click the centre of the element an expression returns. */
    async clickOn(expression) {
      const point = await this.evaluate(
        '(() => { const el = ' +
          expression +
          '; if (el === null || el === undefined) return null;' +
          ' el.scrollIntoView({ block: "center" });' +
          ' const rect = el.getBoundingClientRect();' +
          ' return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()',
      )
      if (point === null) throw new Error('no element for: ' + expression)
      await transport.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: point.x, y: point.y },
        sid,
      )
      await transport.send(
        'Input.dispatchMouseEvent',
        {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        },
        sid,
      )
      await transport.send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        },
        sid,
      )
    },
    /** Type into whatever the page has focused, as a keyboard would.
     * One key event per character: React reads key events, and an inserted text
     * run would leave its controlled state behind. */
    async type(text) {
      for (const character of text) {
        await transport.send(
          'Input.dispatchKeyEvent',
          { type: 'keyDown', text: character, key: character },
          sid,
        )
        await transport.send(
          'Input.dispatchKeyEvent',
          { type: 'keyUp', key: character },
          sid,
        )
      }
    },
    /** Save a screenshot. */
    async screenshot(path) {
      const shot = await transport.send(
        'Page.captureScreenshot',
        { format: 'png' },
        sid,
      )
      const { writeFileSync } = await import('node:fs')
      writeFileSync(path, Buffer.from(shot.data, 'base64'))
    },
    /** Close Chrome. */
    async close() {
      socket.close()
      chrome.kill()
    },
  }
}
