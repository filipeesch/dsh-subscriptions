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
  publishedWindow: 1_048_576,
}

/** The stored document a fixture read carries: another row's setting plus one
 * the catalog no longer lists, both of which a write must keep. */
const storedDocument = {
  'claude-sonnet-5-5': { enabled: true },
  'legacy-model': { contextWindow: 300_000 },
} as Record<string, { enabled?: boolean; contextWindow?: number }>

function modelsView(
  rows = [tieredRow, editableRow, publishedRow],
  stored: Record<
    string,
    { enabled?: boolean; contextWindow?: number }
  > = storedDocument,
): CursorModelsView {
  return {
    provider: 'cursor',
    // A real host resolves enablement from the document it stored.
    models: rows.map((row) => ({
      ...row,
      enabled: stored[row.id]?.enabled ?? row.enabled,
    })),
    knownContext: { enabled: true, fetchedAt: refreshedAt },
    storedModels: stored,
  }
}

/**
 * A fake host whose settings document mutates, so a spec can prove the payload
 * the page sends is the document a real store then serves back. A recorder that
 * returns a frozen fixture cannot tell a complete map from one that dropped
 * every other model.
 */
function storeRpc() {
  let stored = { ...storedDocument }
  const handler = (
    endpoint: string,
    payload: Record<string, unknown>,
  ): Ok | Bad => {
    if (endpoint === 'cursorModels')
      return { ok: true, value: modelsView(undefined, stored) }
    if (endpoint === 'cursorSetSettings') {
      const next = (payload.settings as { models?: typeof stored } | undefined)
        ?.models
      if (next !== undefined) stored = next
      return { ok: true, value: {} }
    }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  }
  const { rpc, calls } = fakeRpc(handler)
  return { rpc, calls, stored: () => stored }
}

interface Dom {
  document: Document
  click: (element: Element | null) => Promise<void>
  setValue: (element: Element | null, value: string) => Promise<void>
  setChecked: (element: Element | null, checked: boolean) => Promise<void>
  blur: (element: Element | null) => Promise<void>
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
    async blur(element) {
      assert.ok(element, 'the field exists')
      await act(async () => {
        element.dispatchEvent(
          new jsdom.window.FocusEvent('focusout', { bubbles: true }),
        )
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
    // Autosave replaced the explicit pair: the populated dialog offers neither.
    assert.equal(buttonByText(dom, 'Save'), null)
    assert.equal(buttonByText(dom, 'Cancel'), null)
    const toggle = dom.document.querySelector(
      'input[aria-label="' +
        t('cursorModelEnabled', { model: 'Composer 2' }) +
        '"]',
    )
    await dom.setChecked(toggle, true)
    const writes = calls.filter((call) => call.endpoint === 'cursorSetSettings')
    assert.equal(writes.length, 1)
    // The whole stored document travels with the change: one model's edit must
    // not drop another model's setting, nor one the catalog no longer lists.
    assert.deepEqual(
      (writes[0]?.payload.settings as { models: Record<string, unknown> })
        .models,
      {
        'claude-sonnet-5-5': { enabled: true },
        'legacy-model': { contextWindow: 300_000 },
        'composer-2': { enabled: true },
      },
    )
  })
})

test('a change keeps the stored document and a reload reads it back', async () => {
  const { rpc, stored } = storeRpc()
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    await dom.setChecked(
      dom.document.querySelector(
        'input[aria-label="' +
          t('cursorModelEnabled', { model: 'Composer 2' }) +
          '"]',
      ),
      true,
    )
    await dom.wait(50)
    // The fake store now holds what a real store would: every earlier entry
    // plus the change.
    assert.deepEqual(stored(), {
      'claude-sonnet-5-5': { enabled: true },
      'legacy-model': { contextWindow: 300_000 },
      'composer-2': { enabled: true },
    })
    await dom.click(buttonByText(dom, en.cursorModelsReload))
    assert.equal(
      (
        dom.document.querySelector(
          'input[aria-label="' +
            t('cursorModelEnabled', { model: 'Composer 2' }) +
            '"]',
        ) as HTMLInputElement
      ).checked,
      true,
    )
  })
})

test('the return to automatic clears an override the document already had', async () => {
  const { rpc, calls } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels')
      return {
        ok: true,
        value: modelsView(undefined, {
          ...storedDocument,
          'deepseek-v41-flash-1017': { contextWindow: 900_000 },
        }),
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
    // The stored override is what the row shows, so it can be cleared at once.
    assert.match(dom.text(), /900K/)
    await dom.click(
      dom.document.querySelector(
        'button[aria-label="' +
          t('cursorModelResetOverride', { model: 'DeepSeek V4.1 Flash 1017' }) +
          '"]',
      ),
    )
    const writes = calls.filter((call) => call.endpoint === 'cursorSetSettings')
    assert.equal(writes.length, 1)
    assert.deepEqual(
      (writes[0]?.payload.settings as { models: Record<string, unknown> })
        .models,
      storedDocument,
    )
    assert.match(dom.text(), /1,048,576/)
    assert.doesNotMatch(dom.text(), /900K/)
  })
})

test('a failed change is not carried by the write queued behind it', async () => {
  const sent: Record<string, unknown>[] = []
  let writes = 0
  const rpc = {
    async call(
      _channel: string,
      endpoint: string,
      payload: Record<string, unknown>,
    ) {
      const name = endpoint.replace('subscriptions-auth.', '')
      if (name === 'cursorModels') return { ok: true, value: modelsView() }
      if (name === 'cursorSetSettings') {
        sent.push(
          (payload.settings as { models: Record<string, unknown> }).models,
        )
        writes += 1
        if (writes === 1) {
          // Hold the first write so the second change queues behind it.
          await new Promise((resolveWait) => setTimeout(resolveWait, 120))
          return { ok: false, error: { message: 'write failed' } }
        }
        return { ok: true, value: {} }
      }
      return { ok: false, error: { message: 'unexpected ' + name } }
    },
  } as never
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    const composer = () =>
      dom.document.querySelector(
        'input[aria-label="' +
          t('cursorModelEnabled', { model: 'Composer 2' }) +
          '"]',
      ) as HTMLInputElement
    const claude = () =>
      dom.document.querySelector(
        'input[aria-label="' +
          t('cursorModelEnabled', { model: 'Claude Sonnet 5.5' }) +
          '"]',
      ) as HTMLInputElement
    await dom.setChecked(composer(), true)
    await dom.setChecked(claude(), false)
    await dom.wait(400)
    // The refused change returned to the stored value...
    assert.equal(composer().checked, false)
    assert.match(dom.text(), /write failed/)
    // ...without undoing the change queued behind it.
    assert.equal(claude().checked, false)
    assert.equal(sent.length, 2)
    // The second request describes the acknowledged document plus its own
    // change: the refused composer edit is not retried behind the reader's back.
    assert.deepEqual(sent[1], {
      'claude-sonnet-5-5': { enabled: false },
      'legacy-model': { contextWindow: 300_000 },
    })
  })
})

test('closing the dialog writes a window the reader just typed', async () => {
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
    await dom.setValue(input(dom, 'Composer 2'), '700000')
    // Close before the pause elapses: the change is still the reader's.
    await dom.click(buttonByText(dom, en.imageClose))
    await dom.wait(50)
    const writes = calls.filter((call) => call.endpoint === 'cursorSetSettings')
    assert.equal(writes.length, 1)
    assert.deepEqual(
      (writes[0]?.payload.settings as { models: Record<string, unknown> })
        .models,
      { ...storedDocument, 'composer-2': { contextWindow: 700_000 } },
    )
  })
})

test('a reload waits for the write before it reads the document', async () => {
  const order: string[] = []
  let held: (() => void) | undefined
  const rpc = {
    async call(_channel: string, endpoint: string) {
      const name = endpoint.replace('subscriptions-auth.', '')
      if (name === 'cursorModels') {
        order.push('read')
        return { ok: true, value: modelsView() }
      }
      if (name === 'cursorSetSettings') {
        order.push('write')
        await new Promise<void>((resolveWait) => {
          held = resolveWait
        })
        order.push('write-done')
        return { ok: true, value: {} }
      }
      return { ok: false, error: { message: 'unexpected ' + name } }
    },
  } as never
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    order.length = 0
    await dom.setChecked(
      dom.document.querySelector(
        'input[aria-label="' +
          t('cursorModelEnabled', { model: 'Composer 2' }) +
          '"]',
      ),
      true,
    )
    // Reload while the write is still in flight.
    await dom.click(buttonByText(dom, en.cursorModelsReload))
    assert.deepEqual(order, ['write'], 'the read waits for the write to land')
    held?.()
    await dom.wait(80)
    assert.deepEqual(order, ['write', 'write-done', 'read'])
  })
})

test('a failed field is not retried by a later change to the same model', async () => {
  const sent: Record<string, unknown>[] = []
  let writes = 0
  const rpc = {
    async call(
      _channel: string,
      endpoint: string,
      payload: Record<string, unknown>,
    ) {
      const name = endpoint.replace('subscriptions-auth.', '')
      if (name === 'cursorModels')
        return {
          ok: true,
          value: modelsView(undefined, {
            ...storedDocument,
            'deepseek-v41-flash-1017': { contextWindow: 900_000 },
          }),
        }
      if (name === 'cursorSetSettings') {
        sent.push(
          (payload.settings as { models: Record<string, unknown> }).models,
        )
        writes += 1
        if (writes === 1) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 120))
          return { ok: false, error: { message: 'write failed' } }
        }
        return { ok: true, value: {} }
      }
      return { ok: false, error: { message: 'unexpected ' + name } }
    },
  } as never
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    const toggle = () =>
      dom.document.querySelector(
        'input[aria-label="' +
          t('cursorModelEnabled', { model: 'DeepSeek V4.1 Flash 1017' }) +
          '"]',
      ) as HTMLInputElement
    await dom.setChecked(toggle(), false)
    // Same row, different field, queued behind the write that will fail.
    await dom.click(
      dom.document.querySelector(
        'button[aria-label="' +
          t('cursorModelResetOverride', { model: 'DeepSeek V4.1 Flash 1017' }) +
          '"]',
      ),
    )
    await dom.wait(400)
    assert.equal(sent.length, 2)
    // The refused enablement is not carried by the change queued behind it: the
    // reset clears the stored window from the entry the host still holds, and
    // the entry disappears because nothing else was acknowledged for it.
    assert.deepEqual(sent[1], {
      'claude-sonnet-5-5': { enabled: true },
      'legacy-model': { contextWindow: 300_000 },
    })
  })
})

test('opening a field and leaving it without typing keeps the override', async () => {
  const { rpc, calls } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels')
      return {
        ok: true,
        value: modelsView(undefined, {
          ...storedDocument,
          'deepseek-v41-flash-1017': { contextWindow: 900_000 },
        }),
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
    await dom.click(
      dom.document.querySelector(
        'button[aria-label="' +
          t('cursorModelResetOverride', { model: 'DeepSeek V4.1 Flash 1017' }) +
          '"]',
      ),
    )
    await dom.wait(50)
    // The reset writes once and the row returns to the published value.
    assert.equal(
      calls.filter((call) => call.endpoint === 'cursorSetSettings').length,
      1,
    )
    // Now open the field for a model with a stored override and blur it away.
    await dom.click(
      dom.document.querySelector(
        'button[aria-label="' +
          t('cursorModelOverride', { model: 'DeepSeek V4.1 Flash 1017' }) +
          '"]',
      ),
    )
    await dom.blur(input(dom, 'DeepSeek V4.1 Flash 1017'))
    assert.equal(
      calls.filter((call) => call.endpoint === 'cursorSetSettings').length,
      1,
      'an untouched field is not a change',
    )
  })
})

test('a read overtaken by a change starts over with the saved document', async () => {
  let stored = { ...storedDocument }
  let reads = 0
  let release: (() => void) | undefined
  const rpc = {
    async call(
      _channel: string,
      endpoint: string,
      payload: Record<string, unknown>,
    ) {
      const name = endpoint.replace('subscriptions-auth.', '')
      if (name === 'cursorModels') {
        reads += 1
        // The second read hangs until the test lets it answer, so a change can
        // land while it is in flight.
        if (reads === 2) {
          await new Promise<void>((resolveWait) => {
            release = resolveWait
          })
        }
        return { ok: true, value: modelsView(undefined, stored) }
      }
      if (name === 'cursorSetSettings') {
        const next = (payload.settings as { models?: typeof stored }).models
        if (next !== undefined) stored = { ...next }
        return { ok: true, value: {} }
      }
      return { ok: false, error: { message: 'unexpected ' + name } }
    },
  } as never
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    const composer = () =>
      dom.document.querySelector(
        'input[aria-label="' +
          t('cursorModelEnabled', { model: 'Composer 2' }) +
          '"]',
      ) as HTMLInputElement
    await dom.click(buttonByText(dom, en.cursorModelsReload))
    await dom.setChecked(composer(), true)
    await dom.wait(50)
    release?.()
    await dom.wait(120)
    // The overtaken read was repeated, and the repeated one describes the saved
    // document instead of the one that predated the change.
    assert.ok(reads >= 3, 'the overtaken read was repeated')
    assert.equal(composer().checked, true)
    // What the page wrote is what the repeated read describes.
    assert.deepEqual(stored, {
      'claude-sonnet-5-5': { enabled: true },
      'legacy-model': { contextWindow: 300_000 },
      'composer-2': { enabled: true },
    })
  })
})

test('a close whose write is refused keeps the dialog and states it', async () => {
  const { rpc } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels') return { ok: true, value: modelsView() }
    if (endpoint === 'cursorSetSettings')
      return { ok: false, error: { message: 'write failed' } }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  let closed = 0
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => {
          closed += 1
        },
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
    await dom.setValue(input(dom, 'Composer 2'), '700000')
    await dom.click(buttonByText(dom, en.imageClose))
    await dom.wait(120)
    // The refused write is not hidden behind a closed dialog.
    assert.equal(closed, 0)
    assert.match(dom.text(), /write failed/)
  })
})

test('a second close with nothing pending closes the dialog', async () => {
  const { rpc } = fakeRpc((endpoint) => {
    if (endpoint === 'cursorModels') return { ok: true, value: modelsView() }
    return { ok: false, error: { message: 'unexpected ' + endpoint } }
  })
  let closed = 0
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => {
          closed += 1
        },
        onSaved: () => undefined,
      }),
    )
    await dom.click(buttonByText(dom, en.imageClose))
    await dom.wait(50)
    assert.equal(closed, 1)
  })
})

test('an overtaken read is never adopted, even past the retries', async () => {
  let reads = 0
  const held: (() => void)[] = []
  const rpc = {
    async call(_channel: string, endpoint: string) {
      const name = endpoint.replace('subscriptions-auth.', '')
      if (name === 'cursorModels') {
        reads += 1
        // Every read after the first hangs, and every response describes the
        // document from before the writes: none of them may be adopted.
        if (reads > 1) {
          await new Promise<void>((resolveWait) => {
            held.push(resolveWait)
          })
        }
        return {
          ok: true,
          value: modelsView(undefined, { 'composer-2': { enabled: true } }),
        }
      }
      if (name === 'cursorSetSettings') return { ok: true, value: {} }
      return { ok: false, error: { message: 'unexpected ' + name } }
    },
  } as never
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    const box = (model: string) =>
      dom.document.querySelector(
        'input[aria-label="' + t('cursorModelEnabled', { model }) + '"]',
      ) as HTMLInputElement
    await dom.click(buttonByText(dom, en.cursorModelsReload))
    // Four rounds, each a real write that overtakes the read being held.
    // The first step must change the value: a toggle to the value already in
    // effect sends no write and therefore overtakes nothing.
    const steps: [string, boolean][] = [
      ['Composer 2', false],
      ['Composer 2', true],
      ['Composer 2', false],
      ['Claude Sonnet 5.5', false],
    ]
    for (const [model, enabled] of steps) {
      await dom.setChecked(box(model), enabled)
      held.shift()?.()
      await dom.wait(40)
    }
    await dom.wait(80)
    // The stale document says Composer is enabled; the last write says it is
    // not, so an adopted stale read would flip it back.
    assert.equal(box('Composer 2').checked, false)
    assert.equal(box('Claude Sonnet 5.5').checked, false)
    assert.ok(reads >= 5, 'the reads were repeated, not adopted: ' + reads)
  })
})

test('a close waits for a pending enablement write and holds a failure', async () => {
  let release: (() => void) | undefined
  const rpc = {
    async call(_channel: string, endpoint: string) {
      const name = endpoint.replace('subscriptions-auth.', '')
      if (name === 'cursorModels') return { ok: true, value: modelsView() }
      if (name === 'cursorSetSettings') {
        await new Promise<void>((resolveWait) => {
          release = resolveWait
        })
        return { ok: false, error: { message: 'write failed' } }
      }
      return { ok: false, error: { message: 'unexpected ' + name } }
    },
  } as never
  let closed = 0
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => {
          closed += 1
        },
        onSaved: () => undefined,
      }),
    )
    await dom.setChecked(
      dom.document.querySelector(
        'input[aria-label="' +
          t('cursorModelEnabled', { model: 'Composer 2' }) +
          '"]',
      ),
      true,
    )
    // Close while that write is still in flight.
    await dom.click(buttonByText(dom, en.imageClose))
    assert.equal(closed, 0, 'the dialog waits for the write')
    release?.()
    await dom.wait(80)
    assert.equal(closed, 0, 'the refused write keeps the dialog open')
    assert.match(dom.text(), /write failed/)
  })
})

test('a read cannot drop the text a reader is still typing', async () => {
  let release: (() => void) | undefined
  let reads = 0
  const rpc = {
    async call(_channel: string, endpoint: string) {
      const name = endpoint.replace('subscriptions-auth.', '')
      if (name === 'cursorModels') {
        reads += 1
        if (reads === 2) {
          await new Promise<void>((resolveWait) => {
            release = resolveWait
          })
        }
        return { ok: true, value: modelsView() }
      }
      if (name === 'cursorSetSettings') return { ok: true, value: {} }
      return { ok: false, error: { message: 'unexpected ' + name } }
    },
  } as never
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
    await dom.setValue(input(dom, 'Composer 2'), '700000')
    // A reload lands while the field is open and uncommitted.
    await dom.click(buttonByText(dom, en.cursorModelsReload))
    release?.()
    await dom.wait(80)
    const field = input(dom, 'Composer 2')
    assert.ok(field, 'the field is still open')
    assert.equal((field as HTMLInputElement).value, '700000')
  })
})

test('Escape waits for a pending write and holds a failure', async () => {
  let release: (() => void) | undefined
  const rpc = {
    async call(_channel: string, endpoint: string) {
      const name = endpoint.replace('subscriptions-auth.', '')
      if (name === 'cursorModels') return { ok: true, value: modelsView() }
      if (name === 'cursorSetSettings') {
        await new Promise<void>((resolveWait) => {
          release = resolveWait
        })
        return { ok: false, error: { message: 'write failed' } }
      }
      return { ok: false, error: { message: 'unexpected ' + name } }
    },
  } as never
  let closed = 0
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => {
          closed += 1
        },
        onSaved: () => undefined,
      }),
    )
    await dom.setChecked(
      dom.document.querySelector(
        'input[aria-label="' +
          t('cursorModelEnabled', { model: 'Composer 2' }) +
          '"]',
      ),
      true,
    )
    // Escape while the checkbox save is still in flight.
    const dialog = dom.document.querySelector('dialog') as HTMLDialogElement
    await act(async () => {
      const cancel = new Event('cancel', { cancelable: true })
      dialog.dispatchEvent(cancel)
      // The manager prevents the browser's own dismissal to wait for the write.
      assert.equal(cancel.defaultPrevented, true)
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    })
    assert.equal(closed, 0, 'the dialog waits for the write')
    release?.()
    await dom.wait(80)
    assert.equal(closed, 0, 'the refused write keeps the dialog open')
    assert.match(dom.text(), /write failed/)
  })
})

test('an older read cannot restore a stale source state', async () => {
  let sourceOn = true
  let reads = 0
  let release: (() => void) | undefined
  const rpc = {
    async call(
      _channel: string,
      endpoint: string,
      payload: Record<string, unknown>,
    ) {
      const name = endpoint.replace('subscriptions-auth.', '')
      if (name === 'cursorModels') {
        reads += 1
        // The response describes the state when the request was made, so a
        // held early read answers with the source still on.
        const snapshot = sourceOn
        if (reads === 2) {
          await new Promise<void>((resolveWait) => {
            release = resolveWait
          })
        }
        return {
          ok: true,
          value: {
            ...modelsView(),
            knownContext: { enabled: snapshot, fetchedAt: refreshedAt },
          },
        }
      }
      if (name === 'cursorSetSettings') {
        const settings = payload.settings as { publishedContext?: boolean }
        if (settings.publishedContext !== undefined)
          sourceOn = settings.publishedContext
        return { ok: true, value: {} }
      }
      return { ok: false, error: { message: 'unexpected ' + name } }
    },
  } as never
  await withDom(async (dom) => {
    await dom.render(
      createElement(CursorModelsManager, {
        rpc,
        t,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    // The reload hangs with the source on.
    await dom.click(buttonByText(dom, en.cursorModelsReload))
    // The source is switched off in the meantime; that read answers first.
    await dom.click(buttonByText(dom, en.cursorCapacityDisable))
    await dom.wait(60)
    assert.match(dom.text(), new RegExp(en.cursorCapacityOff.slice(0, 20)))
    release?.()
    await dom.wait(80)
    // The older response must not turn the source back on in the dialog.
    assert.match(dom.text(), new RegExp(en.cursorCapacityOff.slice(0, 20)))
    assert.doesNotMatch(
      dom.text(),
      new RegExp(en.cursorCapacityOn.slice(0, 20)),
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
      {
        ...storedDocument,
        'deepseek-v41-flash-1017': { contextWindow: 900_000 },
      },
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
    // The override is gone, not stored as zero, and the rest of the document
    // is back to what the host already held.
    assert.deepEqual(
      (writes[1]?.payload.settings as { models: Record<string, unknown> })
        .models,
      storedDocument,
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
