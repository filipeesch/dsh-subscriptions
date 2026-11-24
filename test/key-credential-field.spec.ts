/**
 * Executes the real credential field with the small React hook dispatcher and a
 * fixture RPC: the load, the save with its validation, the removal, and the
 * origin sentences.
 *
 * What this cannot show, and must not be read as showing: React reconciliation,
 * focus, layout, and DOM `disabled` semantics are outside the harness, so a
 * disabled button here is checked through its prop, not by refusing a click.
 * The fake answers the same view and result shapes the host sends; whether the
 * real credential provider resolves the environment layers is that provider's
 * test, and whether each card passes the production validation read is proved by
 * the card-level cases in key-credential-cards.spec.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import {
  KeyCredentialField,
  credentialOriginText,
} from '../src/client/KeyCredentialField.js'
import type { KeyCredentialView } from '../src/client/KeyCredentialField.js'
import { en } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import { Component, nodes, settle, text } from './component-harness.js'
import type { Node } from './component-harness.js'

const t = (key: SubscriptionsKey, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ''),
  )

const STORED: KeyCredentialView = {
  route: 'cursor',
  keyRef: 'CURSOR_API_KEY',
  configured: true,
  source: 'file',
  writable: true,
  masked: 'sk-…',
}

/** The same route resolved from the environment: no preview, no DSH copy. */
const FROM_ENV: KeyCredentialView = {
  route: 'cursor',
  keyRef: 'CURSOR_API_KEY',
  configured: true,
  source: 'env',
  writable: true,
}

/** The same route resolved from a project .env file: still an override. */
const FROM_PROJECT_ENV: KeyCredentialView = {
  route: 'cursor',
  keyRef: 'CURSOR_API_KEY',
  configured: true,
  source: 'project-env',
  writable: true,
}

interface Fixture {
  /** The view a describe answers, mutated by a save or a removal. */
  view: KeyCredentialView
  calls: { endpoint: string; payload: any }[]
  saved?: { value: string }
  removed: boolean
  failWrite?: boolean
  failLookup?: boolean
  readError?: string
  /** Answer a successful envelope whose store write did not land. */
  uncommitted?: boolean
  /** How the host's validation answers. */
  validation?: 'valid' | 'invalid' | 'superseded'
}

function rpc(fixture: Fixture): ConnectionHandle['rpc'] {
  return {
    call: async (_channel: string, endpoint: string, payload: any) => {
      fixture.calls.push({ endpoint, payload })
      if (endpoint === 'subscriptions-auth.keyCredential') {
        if (fixture.failLookup)
          return { ok: false, error: { message: 'fixture lookup failure' } }
        return { ok: true, value: { ...fixture.view } }
      }
      if (endpoint === 'subscriptions-auth.keySetCredential') {
        if (fixture.failWrite)
          return { ok: false, error: { message: 'fixture write failure' } }
        fixture.saved = { value: payload.value }
        fixture.view = { ...STORED, configured: true }
        if (fixture.uncommitted === true)
          return { ok: true, value: { committed: false, generation: 0 } }
        return {
          ok: true,
          value: {
            committed: true,
            generation: 1,
            ...(fixture.readError === undefined
              ? { view: { ...fixture.view } }
              : { readError: fixture.readError }),
          },
        }
      }
      if (endpoint === 'subscriptions-auth.keyValidateCredential') {
        if (payload.generation !== 1)
          return { ok: true, value: { outcome: 'superseded' } }
        return { ok: true, value: { outcome: fixture.validation ?? 'valid' } }
      }
      if (endpoint === 'subscriptions-auth.keyClearCredential') {
        fixture.removed = true
        fixture.view = {
          route: fixture.view.route,
          keyRef: fixture.view.keyRef,
          configured: false,
          writable: true,
        }
        return {
          ok: true,
          value: { committed: true, view: fixture.view, generation: 2 },
        }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    },
  } as unknown as ConnectionHandle['rpc']
}

async function mount(
  fixture: Fixture,
  options: { onChanged?: () => void } = {},
): Promise<Component> {
  // One connection per mount: the real prop is stable, and a fresh handle per
  // render would re-run the load effect the way React never does.
  const connection = rpc(fixture)
  const component = new Component(() =>
    KeyCredentialField({
      rpc: connection,
      t: t as never,
      route: 'cursor',
      ...(options.onChanged === undefined
        ? {}
        : { onChanged: options.onChanged }),
    }),
  )
  await settle(component)
  return component
}

function input(component: Component): Node {
  const result = nodes(component.tree).find((node) => node.type === 'input')
  assert.ok(result, 'the key input')
  return result
}

function button(component: Component, label: string): Node | undefined {
  return nodes(component.tree).find(
    (node) => node.type === 'button' && text(node) === label,
  )
}

/** Submit the credential form the way Enter does: the button has no handler. */
function submit(component: Component) {
  const form = nodes(component.tree).find((node) => node.type === 'form')
  assert.ok(form, 'the credential form')
  form.props.onSubmit({ preventDefault() {} })
}

test('the origin sentence names the layer that supplies the key', () => {
  const base: KeyCredentialView = {
    route: 'cursor',
    keyRef: 'CURSOR_API_KEY',
    configured: true,
    writable: true,
  }
  assert.equal(
    credentialOriginText(t as never, { ...base, configured: false }),
    'No key found at CURSOR_API_KEY.',
  )
  assert.equal(
    credentialOriginText(t as never, { ...base, source: 'env' }),
    'Found in the environment at CURSOR_API_KEY.',
  )
  assert.equal(
    credentialOriginText(t as never, { ...base, source: 'project-env' }),
    'Found in the project .env file for CURSOR_API_KEY.',
  )
  assert.equal(
    credentialOriginText(t as never, { ...base, source: 'user-env' }),
    'Found in the user .env file for CURSOR_API_KEY.',
  )
  assert.equal(
    credentialOriginText(t as never, { ...base, source: 'file' }),
    'Stored in DSH at CURSOR_API_KEY.',
  )
  assert.equal(
    credentialOriginText(t as never, {
      ...base,
      source: 'file',
      masked: 'sk-…',
    }),
    'Stored in DSH at CURSOR_API_KEY: sk-…',
  )
})

test('a configured key shows the masked preview and offers replace and remove', async () => {
  const fixture: Fixture = { view: STORED, calls: [], removed: false }
  const component = await mount(fixture)
  const body = text(component.tree)
  assert.match(body, /Stored in DSH at CURSOR_API_KEY: sk-…/)
  assert.match(body, new RegExp(en.credentialRemoveHint.slice(0, 20)))
  assert.ok(button(component, en.credentialReplace))
  assert.ok(button(component, en.credentialRemove))
})

test('an environment key offers no removal and saves a DSH override', async () => {
  const fixture: Fixture = {
    view: FROM_ENV,
    calls: [],
    removed: false,
  }
  const component = await mount(fixture)
  assert.match(text(component.tree), /Found in the environment/)
  assert.equal(button(component, en.credentialRemove), undefined)
  assert.ok(button(component, en.credentialOverride))
})

test('an absent key offers save and starts empty', async () => {
  const fixture: Fixture = {
    view: {
      route: 'cursor',
      keyRef: 'CURSOR_API_KEY',
      configured: false,
      writable: true,
    },
    calls: [],
    removed: false,
  }
  const component = await mount(fixture)
  assert.match(text(component.tree), /No key found at CURSOR_API_KEY/)
  assert.ok(button(component, en.credentialSave))
  assert.equal(input(component).props.value, '')
  assert.equal(
    input(component).props['aria-describedby'],
    'credential-origin-cursor',
  )
})

test('a save stores the trimmed value, validates it, and reports the change', async () => {
  const fixture: Fixture = {
    view: {
      route: 'cursor',
      keyRef: 'CURSOR_API_KEY',
      configured: false,
      writable: true,
    },
    calls: [],
    removed: false,
  }
  let changed = 0
  const component = await mount(fixture, {
    onChanged: () => {
      changed += 1
    },
  })
  input(component).props.onChange({ target: { value: '  cursor-key  ' } })
  component.render()
  submit(component)
  await settle(component)
  assert.deepEqual(fixture.saved, { value: 'cursor-key' })
  assert.equal(changed, 1)
  const validation = fixture.calls.find(
    (call) => call.endpoint === 'subscriptions-auth.keyValidateCredential',
  )
  // The host reads the committed credential itself; the request names only the
  // write it is asking about.
  assert.deepEqual(validation?.payload, { route: 'cursor', generation: 1 })
  assert.match(text(component.tree), new RegExp(en.credentialSaved))
})

test('a rejected key stays saved and the card states it without provider text', async () => {
  const fixture: Fixture = {
    view: {
      route: 'cursor',
      keyRef: 'CURSOR_API_KEY',
      configured: false,
      writable: true,
    },
    calls: [],
    removed: false,
  }
  const component = await mount(fixture)
  fixture.validation = 'invalid'
  input(component).props.onChange({ target: { value: 'bad-key' } })
  component.render()
  submit(component)
  await settle(component)
  assert.deepEqual(fixture.saved, { value: 'bad-key' })
  const body = text(component.tree)
  assert.match(body, /The key is saved, but the route could not use it/)
  assert.match(body, /Stored in DSH/)
  assert.doesNotMatch(body, /sk-synthetic-secret/)
})

test('a committed save whose state could not be read is not called a failure', async () => {
  const fixture: Fixture = {
    view: {
      route: 'cursor',
      keyRef: 'CURSOR_API_KEY',
      configured: false,
      writable: true,
    },
    calls: [],
    removed: false,
    readError: 'the key was saved, but the credential state could not be read',
  }
  const component = await mount(fixture)
  input(component).props.onChange({ target: { value: 'new-key' } })
  component.render()
  submit(component)
  await settle(component)
  assert.match(
    text(component.tree),
    /The key was saved, but its state could not be read/,
  )
  assert.doesNotMatch(text(component.tree), /Could not save the key/)
})

test('a refused write states the failure and keeps the previous view', async () => {
  const fixture: Fixture = {
    view: FROM_ENV,
    calls: [],
    removed: false,
    failWrite: true,
  }
  const component = await mount(fixture)
  input(component).props.onChange({ target: { value: 'new-key' } })
  component.render()
  submit(component)
  await settle(component)
  assert.match(
    text(component.tree),
    /Could not save the key: fixture write failure/,
  )
  assert.match(text(component.tree), /Found in the environment/)
})

test('removal clears the stored copy and the card states the missing key', async () => {
  const fixture: Fixture = { view: STORED, calls: [], removed: false }
  const component = await mount(fixture)
  button(component, en.credentialRemove)!.props.onClick()
  await settle(component)
  assert.equal(fixture.removed, true)
  assert.match(text(component.tree), /No key found at CURSOR_API_KEY/)
})

test('a lookup failure is stated instead of rendering an empty field', async () => {
  const fixture: Fixture = {
    view: STORED,
    calls: [],
    removed: false,
    failLookup: true,
  }
  const component = await mount(fixture)
  assert.match(
    text(component.tree),
    /Could not read the credential: fixture lookup failure/,
  )
})

test('a host that cannot write disables the controls', async () => {
  const fixture: Fixture = {
    view: { ...STORED, writable: false },
    calls: [],
    removed: false,
  }
  const component = await mount(fixture)
  assert.equal(input(component).props.disabled, true)
  assert.equal(button(component, en.credentialReplace)!.props.disabled, true)
  assert.equal(button(component, en.credentialRemove)!.props.disabled, true)
  assert.match(text(component.tree), /This host cannot write the key/)
})

test('a key from a project env file is replaced by an override, not edited', async () => {
  const fixture: Fixture = {
    view: FROM_PROJECT_ENV,
    calls: [],
    removed: false,
  }
  const component = await mount(fixture)
  assert.match(text(component.tree), /project \.env file/)
  assert.ok(button(component, en.credentialOverride))
  assert.equal(button(component, en.credentialRemove), undefined)
})

test('a completed save announces the stored key', async () => {
  const fixture: Fixture = {
    view: {
      route: 'cursor',
      keyRef: 'CURSOR_API_KEY',
      configured: false,
      writable: true,
    },
    calls: [],
    removed: false,
  }
  const component = await mount(fixture)
  input(component).props.onChange({ target: { value: 'new-key' } })
  component.render()
  submit(component)
  await settle(component)
  assert.match(text(component.tree), new RegExp(en.credentialSaved))
})

test('an unconfirmed write is reported, not presented as a saved key', async () => {
  const fixture: Fixture = {
    view: {
      route: 'cursor',
      keyRef: 'CURSOR_API_KEY',
      configured: false,
      writable: true,
    },
    calls: [],
    removed: false,
    uncommitted: true,
  }
  const component = await mount(fixture)
  input(component).props.onChange({ target: { value: 'new-key' } })
  component.render()
  submit(component)
  await settle(component)
  assert.match(text(component.tree), new RegExp(en.credentialNotCommitted))
  assert.doesNotMatch(text(component.tree), new RegExp(en.credentialSaved))
})

test('a key superseded while the host validated it is its own outcome', async () => {
  const fixture: Fixture = {
    view: {
      route: 'cursor',
      keyRef: 'CURSOR_API_KEY',
      configured: false,
      writable: true,
    },
    calls: [],
    removed: false,
  }
  // Another client replaced or removed the key while the host was reading it, so
  // the host answers superseded and this save owns no verdict.
  fixture.validation = 'superseded'
  const component = await mount(fixture)
  input(component).props.onChange({ target: { value: 'new-key' } })
  component.render()
  submit(component)
  await settle(component)
  assert.match(text(component.tree), new RegExp(en.credentialSuperseded))
  assert.doesNotMatch(text(component.tree), new RegExp(en.credentialSaved))
})
