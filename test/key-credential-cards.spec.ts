/**
 * Each key route's card runs the production validation read after a save: the
 * Cursor card asks for a live catalog read, the Ollama card lists the cloud
 * models with the stored key. The field's own tests supply a validator, so this
 * file is what proves the wiring between the two.
 *
 * Executed with the small hook dispatcher; the window dispatch the cards make
 * after a usage refresh is stubbed because these cases never open a browser.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { CursorCard } from '../src/client/CursorCard.js'
import { OllamaCard } from '../src/client/OllamaCard.js'
import { KeyCredentialField } from '../src/client/KeyCredentialField.js'
import { en } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import { Component, nodes, settle } from './component-harness.js'

const t = (key: SubscriptionsKey, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ''),
  )

interface Call {
  endpoint: string
  payload: unknown
}

/** One fake connection answering every endpoint a key card mounts. */
function connection(
  calls: Call[],
  saved: Record<string, unknown>,
): ConnectionHandle['rpc'] {
  const answer = (value: unknown) => ({ ok: true, value })
  return {
    call: async (_channel: string, endpoint: string, payload: unknown) => {
      calls.push({ endpoint, payload })
      switch (endpoint) {
        case 'subscriptions-auth.cursorSettings':
          return answer({
            provider: 'cursor',
            keyRef: 'CURSOR_API_KEY',
            models: 3,
            publishedContext: true,
            knownContext: { enabled: true },
          })
        case 'subscriptions-auth.ollamaSettings':
          return answer({
            provider: 'ollama-cloud',
            settings: {},
            effective: {
              baseURL: 'https://ollama.com',
              apiKeyRef: 'OLLAMA_API_KEY',
              web: false,
            },
            models: [],
            configOverridesModels: false,
          })
        case 'subscriptions-auth.externalStatus':
          return answer({
            cursor: { configured: true },
            'ollama-cloud': { configured: true },
            'opencode-go': { configured: false },
            'kimi-code': { configured: false },
            minimax: { configured: false },
            'minimax-cn': { configured: false },
          })
        case 'subscriptions-auth.externalUsage':
          return answer({
            supported: true,
            windows: [{ kind: 'other', usedPercent: 10 }],
          })
        case 'subscriptions-auth.keyCredential':
          return answer({
            route: (payload as { route: string }).route,
            keyRef: 'CURSOR_API_KEY',
            configured: false,
            writable: true,
          })
        case 'subscriptions-auth.keySetCredential':
          return answer({ committed: true, view: saved })
        case 'subscriptions-auth.cursorModels':
          return answer({
            provider: 'cursor',
            models: [],
            knownContext: { enabled: true },
            storedModels: {},
          })
        case 'subscriptions-auth.ollamaModels':
          return answer({ models: [] })
        default:
          return answer({ ok: true })
      }
    },
  } as unknown as ConnectionHandle['rpc']
}

/** The browser globals the cards touch after a successful read. */
async function withBrowser(work: () => Promise<void>): Promise<void> {
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  globals.window = { dispatchEvent: () => true }
  try {
    await work()
  } finally {
    if (previous === undefined) delete globals.window
    else globals.window = previous
  }
}

/**
 * The card mounts the shared field with a route and the identity that remounts
 * it. The harness does not execute child components, so the wiring is asserted
 * where the card writes it: the element it hands the field.
 */
function fieldOn(component: Component): {
  route: string
  key: string | null
} {
  const element = nodes(component.tree).find(
    (node) => node.type === KeyCredentialField,
  )
  assert.ok(element, 'the card mounts the credential field')
  return {
    route: (element.props as { route: string }).route,
    key: element.key,
  }
}

test('the Cursor card mounts the field on its route and reference', async () => {
  await withBrowser(async () => {
    const calls: Call[] = []
    const component = new Component(() =>
      CursorCard({
        rpc: connection(calls, {
          route: 'cursor',
          keyRef: 'CURSOR_API_KEY',
          configured: true,
          source: 'file',
          writable: true,
          masked: 'pa…ey',
        }),
        t: t as never,
      }),
    )
    await settle(component)
    const field = fieldOn(component)
    assert.equal(field.route, 'cursor')
    // A renamed reference remounts the field instead of leaving stale state.
    assert.equal(field.key, 'CURSOR_API_KEY')
    // The route's own read belongs to the host now: the card passes no validator.
    assert.doesNotMatch(
      JSON.stringify(nodes(component.tree).map((node) => node.props)),
      /validate/,
    )
  })
})

test('the Ollama card mounts the field on its route, reference, and revision', async () => {
  await withBrowser(async () => {
    const calls: Call[] = []
    const component = new Component(() =>
      OllamaCard({
        rpc: connection(calls, {
          route: 'ollama-cloud',
          keyRef: 'OLLAMA_API_KEY',
          configured: true,
          source: 'file',
          writable: true,
          masked: 'pa…ey',
        }),
        t: t as never,
      }),
    )
    await settle(component)
    const field = fieldOn(component)
    assert.equal(field.route, 'ollama-cloud')
    // The revision is part of the identity: a connection-manager save that keeps
    // the same reference text still remounts the field.
    assert.equal(field.key, 'OLLAMA_API_KEY:0')
  })
})
