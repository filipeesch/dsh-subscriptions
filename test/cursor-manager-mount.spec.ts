import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { CursorCard } from '../src/client/CursorCard.js'
import { CursorModelsManager } from '../src/client/CursorModelsManager.js'
import type { CursorModelsView } from '../src/client/cursor-manager-derive.js'
import { en } from '../src/client/locales.js'

// React's act() needs this flag before any render outside a test renderer.
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/** The suite's translator over the English dictionary. */
function makeT(): (key: string, params?: Record<string, unknown>) => string {
  const dictionary = en as Record<string, string>
  return (key, params) =>
    String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
      String(params?.[name] ?? ''),
    )
}
const t = makeT()

type Ok = { ok: true; value: unknown }
type Bad = { ok: false; error: { message: string } }

interface Call {
  endpoint: string
  payload: Record<string, unknown>
}

/** A fake ConnectionHandle RPC that answers from a per-endpoint handler. */
function fakeRpc(
  handler: (endpoint: string, payload: Record<string, unknown>) => Ok | Bad,
) {
  const calls: Call[] = []
  const rpc = {
    async call(
      _channel: string,
      endpoint: string,
      payload: Record<string, unknown>,
    ) {
      const name = endpoint.replace('subscriptions-auth.', '')
      calls.push({ endpoint: name, payload })
      return handler(name, payload)
    },
  }
  return { rpc: rpc as never, calls }
}

const refreshedAt = 1_765_000_000_000

const settingsView = {
  provider: 'cursor' as const,
  keyRef: 'CURSOR_API_KEY',
  publishedContext: true,
  models: 2,
  knownContext: { enabled: true, fetchedAt: refreshedAt },
}

const tieredRow = {
  id: 'claude-sonnet-5-5',
  name: 'Claude Sonnet 5.5',
  enabled: true,
  described: true,
  window: { tokens: 1_000_000, source: 'tier' as const, tier: '1m' },
  overridable: false,
  manualValue: 1_000_000,
}

const editableRow = {
  id: 'composer-2',
  name: 'Composer 2',
  enabled: false,
  described: true,
  window: { tokens: 200_000, source: 'default' as const },
  overridable: true,
  manualValue: 200_000,
}

const publishedRow = {
  id: 'deepseek-v41-flash-1017',
  name: 'DeepSeek V4.1 Flash 1017',
  enabled: true,
  described: false,
  window: { tokens: 1_048_576, source: 'published' as const },
  overridable: true,
  manualValue: 1_048_576,
  publishedWindow: 1_048_576,
}

function modelsView(
  rows = [tieredRow, editableRow, publishedRow],
): CursorModelsView {
  return {
    provider: 'cursor',
    models: rows,
    knownContext: { enabled: true, fetchedAt: refreshedAt },
  }
}

interface Dom {
  document: Document
  click: (element: Element | null) => Promise<void>
  setValue: (element: Element | null, value: string) => Promise<void>
  setChecked: (element: Element | null, checked: boolean) => Promise<void>
  render: (element: ReturnType<typeof createElement>) => Promise<void>
  /** Let a debounced write fire. */
  wait: (ms: number) => Promise<void>
  text: () => string
}

async function withDom(run: (dom: Dom) => Promise<void>): Promise<void> {
  const jsdom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'http://localhost' },
  )
  const globals = globalThis as Record<string, unknown>
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const window = jsdom.window as unknown as Window & typeof globalThis
  for (const key of [
    'window',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'Event',
    'MouseEvent',
    'getComputedStyle',
  ] as const) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    globals[key] = (window as unknown as Record<string, unknown>)[key]
  }
  // Node's own navigator is a read-only accessor; define over it.
  saved.set(
    'navigator',
    Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  )
  Object.defineProperty(globalThis, 'navigator', {
    value: window.navigator,
    configurable: true,
  })
  const rootElement = jsdom.window.document.getElementById(
    'root',
  ) as HTMLElement
  const root = createRoot(rootElement)
  const dom: Dom = {
    document: jsdom.window.document as unknown as Document,
    async render(element) {
      await act(async () => {
        root.render(element)
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      })
    },
    async click(element) {
      assert.ok(element, 'the button exists')
      await act(async () => {
        element.dispatchEvent(
          new jsdom.window.MouseEvent('click', { bubbles: true }),
        )
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      })
    },
    async setValue(element, value) {
      assert.ok(element, 'the control exists')
      const input = element as HTMLInputElement | HTMLSelectElement
      await act(async () => {
        // Set the native value, then let React's test event see the change;
        // jsdom's synthetic input events do not drive React's change plugin.
        const descriptor = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(input),
          'value',
        )
        descriptor?.set?.call(input, value)
        ;(
          Simulate as unknown as {
            change: (node: Element, event: unknown) => void
          }
        ).change(input, { target: { value }, bubbles: true })
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      })
    },
    async setChecked(element, checked) {
      assert.ok(element, 'the checkbox exists')
      const input = element as HTMLInputElement
      await act(async () => {
        input.checked = checked
        ;(
          Simulate as unknown as {
            change: (node: Element, event: unknown) => void
          }
        ).change(input, { target: { checked }, bubbles: true })
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      })
    },
    async wait(ms) {
      await act(async () => {
        await new Promise((resolveWait) => setTimeout(resolveWait, ms))
      })
    },
    text() {
      return dom.document.body.textContent ?? ''
    },
  }
  try {
    await run(dom)
  } finally {
    await act(async () => {
      root.unmount()
    })
    jsdom.window.close()
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined)
        delete (globalThis as Record<string, unknown>)[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
}

function buttonByText(dom: Dom, label: string): Element | null {
  return (
    [...dom.document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  )
}

function input(dom: Dom, model: string): Element | null {
  return dom.document.querySelector(
    'input[aria-label="' + t('cursorModelWindowFor', { model }) + '"]',
  )
}

test('the card states the source on one line and opens the manager', async () => {
  const { rpc } = fakeRpc((endpoint) => {
    if (endpoint === 'externalStatus')
      return { ok: true, value: { cursor: { configured: true } } }
    if (endpoint === 'externalUsage')
      return { ok: true, value: { observedAt: refreshedAt, windows: [] } }
    if (endpoint === 'cursorSettings') return { ok: true, value: settingsView }
    if (endpoint === 'cursorModels') return { ok: true, value: modelsView() }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  await withDom(async (dom) => {
    await dom.render(createElement(CursorCard, { rpc, t }))
    // The card states the source and its age; the controls moved to the manager.
    assert.ok(dom.text().includes(en.cursorSourceOn))
    assert.equal(buttonByText(dom, en.cursorCapacityRefresh), null)
    await dom.click(
      dom.document.querySelector('button[aria-haspopup="dialog"]'),
    )
    assert.ok(dom.text().includes(en.cursorManageTitle))
    assert.match(dom.text(), /Claude Sonnet 5\.5/)
    assert.ok(dom.text().includes(en.cursorCapacityTitle))
  })
})

test('an enablement change writes at once, with no save action', async () => {
  const { rpc, calls } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels') return { ok: true, value: modelsView() }
    if (endpoint === 'cursorSetSettings') return { ok: true, value: {} }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    assert.equal(buttonByText(dom, en.cursorSave), null)
    const toggle = dom.document.querySelector(
      'input[aria-label="' +
        t('cursorModelEnabled', { model: 'Composer 2' }) +
        '"]',
    )
    await dom.setChecked(toggle, true)
    const writes = calls.filter((call) => call.endpoint === 'cursorSetSettings')
    assert.equal(writes.length, 1)
    assert.deepEqual(
      (writes[0]?.payload.settings as { models: Record<string, unknown> })
        .models,
      { 'composer-2': { enabled: true } },
    )
  })
})

test('a typed window writes after the pause and marks the row manual', async () => {
  const { rpc, calls } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels') return { ok: true, value: modelsView() }
    if (endpoint === 'cursorSetSettings') return { ok: true, value: {} }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    const pencil = dom.document.querySelector(
      'button[aria-label="' +
        t('cursorModelOverride', { model: 'DeepSeek V4.1 Flash 1017' }) +
        '"]',
    )
    await dom.click(pencil)
    await dom.setValue(input(dom, 'DeepSeek V4.1 Flash 1017'), '900000')
    // Nothing is written while the reader is still typing.
    assert.equal(
      calls.filter((call) => call.endpoint === 'cursorSetSettings').length,
      0,
    )
    await dom.wait(700)
    const writes = calls.filter((call) => call.endpoint === 'cursorSetSettings')
    assert.equal(writes.length, 1)
    assert.deepEqual(
      (writes[0]?.payload.settings as { models: Record<string, unknown> })
        .models,
      { 'deepseek-v41-flash-1017': { contextWindow: 900_000 } },
    )
    // The row shows the manual value and offers the return to automatic.
    assert.match(dom.text(), /900K/)
    assert.ok(
      dom.document.querySelector(
        'button[aria-label="' +
          t('cursorModelResetOverride', { model: 'DeepSeek V4.1 Flash 1017' }) +
          '"]',
      ),
    )
  })
})

test('the return to automatic clears the stored override', async () => {
  const { rpc, calls } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels') return { ok: true, value: modelsView() }
    if (endpoint === 'cursorSetSettings') return { ok: true, value: {} }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    await dom.click(
      dom.document.querySelector(
        'button[aria-label="' +
          t('cursorModelOverride', { model: 'DeepSeek V4.1 Flash 1017' }) +
          '"]',
      ),
    )
    await dom.setValue(input(dom, 'DeepSeek V4.1 Flash 1017'), '900000')
    await dom.wait(700)
    await dom.click(
      dom.document.querySelector(
        'button[aria-label="' +
          t('cursorModelResetOverride', { model: 'DeepSeek V4.1 Flash 1017' }) +
          '"]',
      ),
    )
    const writes = calls.filter((call) => call.endpoint === 'cursorSetSettings')
    assert.equal(writes.length, 2)
    // The override is gone, not stored as zero.
    assert.deepEqual(
      (writes[1]?.payload.settings as { models: Record<string, unknown> })
        .models,
      {},
    )
    assert.match(dom.text(), /1,048,576/)
  })
})

test('an unusable window never reaches the write and the row states why', async () => {
  const { rpc, calls } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels') return { ok: true, value: modelsView() }
    if (endpoint === 'cursorSetSettings') return { ok: true, value: {} }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    await dom.click(
      dom.document.querySelector(
        'button[aria-label="' +
          t('cursorModelOverride', { model: 'Composer 2' }) +
          '"]',
      ),
    )
    await dom.setValue(input(dom, 'Composer 2'), '1.5')
    await dom.wait(700)
    assert.equal(
      calls.filter((call) => call.endpoint === 'cursorSetSettings').length,
      0,
    )
    assert.ok(dom.text().includes(en.cursorModelWindowInvalid))
  })
})

test('a failed write reverts the row and states the failure in it', async () => {
  const { rpc } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels') return { ok: true, value: modelsView() }
    if (endpoint === 'cursorSetSettings')
      return { ok: false, error: { message: 'write failed' } }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    const toggle = dom.document.querySelector(
      'input[aria-label="' +
        t('cursorModelEnabled', { model: 'Composer 2' }) +
        '"]',
    ) as HTMLInputElement
    assert.equal(toggle.checked, false)
    await dom.setChecked(toggle, true)
    await dom.wait(50)
    assert.match(dom.text(), /write failed/)
    // The row returned to what the route holds.
    assert.equal(
      (
        dom.document.querySelector(
          'input[aria-label="' +
            t('cursorModelEnabled', { model: 'Composer 2' }) +
            '"]',
        ) as HTMLInputElement
      ).checked,
      false,
    )
    assert.match(dom.text(), /Claude Sonnet 5\.5/)
  })
})

test('a failed Reload keeps the rows and states the provider failure', async () => {
  let attempts = 0
  const { rpc } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels') {
      attempts += 1
      return attempts === 1
        ? { ok: true, value: modelsView() }
        : { ok: false, error: { message: 'catalog offline' } }
    }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    await dom.click(buttonByText(dom, en.cursorModelsReload))
    assert.match(dom.text(), /catalog offline/)
    assert.match(dom.text(), /Claude Sonnet 5\.5/)
  })
})

test('the filter narrows the rows and reloading clears neither the filter nor the source', async () => {
  const { rpc } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels') return { ok: true, value: modelsView() }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    const filter = dom.document.querySelector(
      'input[aria-label="' + t('modelDefaultsFilterPlaceholder') + '"]',
    )
    await dom.setValue(filter, 'deepseek')
    assert.match(dom.text(), /DeepSeek V4\.1 Flash 1017/)
    assert.doesNotMatch(dom.text(), /Claude Sonnet 5\.5/)
    await dom.click(buttonByText(dom, en.cursorModelsReload))
    assert.match(dom.text(), /DeepSeek V4\.1 Flash 1017/)
    assert.doesNotMatch(dom.text(), /Claude Sonnet 5\.5/)
    await dom.setValue(filter, 'zzz')
    assert.match(dom.text(), /No model matches/)
  })
})

test('the manager refreshes the source and switches it off', async () => {
  const { rpc, calls } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels') return { ok: true, value: modelsView() }
    if (endpoint === 'cursorRefreshContext')
      return {
        ok: true,
        value: {
          enabled: true,
          status: 'refreshed',
          fetchedAt: refreshedAt,
          windows: 1,
        },
      }
    if (endpoint === 'cursorSetSettings') return { ok: true, value: {} }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    await dom.click(buttonByText(dom, en.cursorCapacityRefresh))
    assert.match(dom.text(), /Capacities refreshed: 1 models described/)
    // The rows were read again so they show the new projection.
    assert.equal(
      calls.filter((call) => call.endpoint === 'cursorModels').length,
      2,
    )
    await dom.click(buttonByText(dom, en.cursorCapacityDisable))
    const writes = calls.filter(
      (call) =>
        call.endpoint === 'cursorSetSettings' &&
        call.payload.settings !== undefined &&
        (call.payload.settings as { publishedContext?: boolean })
          .publishedContext !== undefined,
    )
    assert.equal(writes.length, 1)
    assert.equal(
      (writes[0]?.payload.settings as { publishedContext: boolean })
        .publishedContext,
      false,
    )
  })
})
