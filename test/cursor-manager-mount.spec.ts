import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { CursorCard } from '../src/client/CursorCard.js'
import {
  CursorModelsManager,
  type CursorModelsView,
} from '../src/client/CursorModelsManager.js'
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
  context: 'max',
  publishedContext: true,
  models: 2,
  knownContext: { enabled: true, fetchedAt: refreshedAt },
}

const tieredRow = {
  id: 'claude-sonnet-5-5',
  name: 'Claude Sonnet 5.5',
  enabled: true,
  described: true,
  tierOverride: '200k',
  tierOptions: ['200k', '1m'],
  window: { tokens: 200_000, source: 'tier' as const, tier: '200k' },
  manualWindow: { editable: false, value: 200_000 },
}

const editableRow = {
  id: 'composer-2',
  name: 'Composer 2',
  enabled: false,
  described: true,
  tierOptions: [] as string[],
  window: { tokens: 200_000, source: 'default' as const },
  manualWindow: { editable: true, value: 200_000 },
}

function modelsView(
  rows = [tieredRow, editableRow],
  storedModels: CursorModelsView['storedModels'] = {
    'claude-sonnet-5-5': { context: '200k' },
  },
): CursorModelsView {
  return {
    provider: 'cursor',
    context: 'max',
    models: rows,
    knownContext: { enabled: true, fetchedAt: refreshedAt },
    storedModels,
    publishedContext: true,
  }
}

interface Dom {
  document: Document
  click: (element: Element | null) => Promise<void>
  setValue: (element: Element | null, value: string) => Promise<void>
  render: (element: ReturnType<typeof createElement>) => Promise<void>
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

function select(dom: Dom, model: string): Element | null {
  return dom.document.querySelector(
    'select[aria-label="' + t('cursorModelTierFor', { model }) + '"]',
  )
}

function input(dom: Dom, model: string): Element | null {
  return dom.document.querySelector(
    'input[aria-label="' + t('cursorModelWindowFor', { model }) + '"]',
  )
}

test('the card opens the manager and states a failed refresh with retained data', async () => {
  const { rpc } = fakeRpc((endpoint) => {
    if (endpoint === 'externalStatus')
      return { ok: true, value: { cursor: { configured: true } } }
    if (endpoint === 'externalUsage')
      return { ok: true, value: { observedAt: refreshedAt, windows: [] } }
    if (endpoint === 'cursorSettings') return { ok: true, value: settingsView }
    if (endpoint === 'cursorRefreshContext')
      return {
        ok: true,
        value: {
          enabled: true,
          status: 'failed',
          reason: 'models.dev answered 503',
          fetchedAt: refreshedAt,
        },
      }
    if (endpoint === 'cursorModels') return { ok: true, value: modelsView() }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  await withDom(async (dom) => {
    await dom.render(createElement(CursorCard, { rpc, t }))
    await dom.click(buttonByText(dom, en.cursorSourceRefresh))
    assert.match(dom.text(), /models\.dev answered 503/)
    assert.match(dom.text(), /last successful refresh/)
    // The manager opens from the card and loads its rows.
    await dom.click(
      dom.document.querySelector('button[aria-haspopup="dialog"]'),
    )
    assert.match(dom.text(), new RegExp(en.cursorManageTitle))
    assert.match(dom.text(), /Claude Sonnet 5\.5/)
  })
})

test('clearing a tier to Auto saves the clear instead of the old value', async () => {
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
    const control = select(dom, 'Claude Sonnet 5.5')
    assert.equal((control as HTMLSelectElement).value, '200k')
    await dom.setValue(control, '')
    assert.equal((control as HTMLSelectElement).value, '')
    await dom.click(buttonByText(dom, en.cursorSave))
    const save = calls.filter((call) => call.endpoint === 'cursorSetSettings')
    assert.equal(save.length, 1)
    const models = (
      save[0]?.payload.settings as { models: Record<string, unknown> }
    ).models
    // The stored tier is cleared, so the model has no entry at all.
    assert.equal(models['claude-sonnet-5-5'], undefined)
  })
})

test('inheritance over a YAML baseline saves a clear, not the baseline', async () => {
  const { rpc, calls } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels')
      return {
        ok: true,
        value: modelsView(
          [{ ...tieredRow, tierOverride: 'max' }, editableRow],
          {},
        ),
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
    const control = select(dom, 'Claude Sonnet 5.5')
    assert.equal((control as HTMLSelectElement).value, 'max')
    await dom.setValue(control, '')
    await dom.click(buttonByText(dom, en.cursorSave))
    const save = calls.filter((call) => call.endpoint === 'cursorSetSettings')
    assert.equal(save.length, 1)
    const models = (
      save[0]?.payload.settings as { models: Record<string, unknown> }
    ).models
    assert.equal(models['claude-sonnet-5-5'], undefined)
  })
})

test('a failed save keeps the manager open with the edited value', async () => {
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
    const control = input(dom, 'Composer 2')
    await dom.setValue(control, '300000')
    assert.equal(
      (input(dom, 'Composer 2') as HTMLInputElement).value,
      '300000',
      'the typed window reached the controlled input',
    )
    await dom.click(buttonByText(dom, en.cursorSave))
    assert.match(dom.text(), /write failed/)
    assert.equal((input(dom, 'Composer 2') as HTMLInputElement).value, '300000')
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
