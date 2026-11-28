/**
 * The add-provider form.
 *
 * The form is the page's only write surface for a provider that has no row, so
 * these cases pin what it must not do before its primary action (write, save, or
 * start an authorization) and what each route's action does: the OAuth attempt
 * the page owns, the two key routes that save and then validate, the managed key
 * it can only check, and Ollama's address write, which must re-send the stored
 * document rather than replace it with one field.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { AddProviderForm } from '../src/client/AddProviderForm.js'
import { SELECTOR_PROVIDERS } from '../src/client/provider-roster.js'
import type { RosterProviderId } from '../src/client/provider-roster.js'
import { en } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import { Component, nodes, settle, text } from './component-harness.js'
import type { Node } from './component-harness.js'

const t = (key: SubscriptionsKey, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ''),
  )

const OLLAMA_VIEW = {
  provider: 'ollama-cloud',
  settings: { web: true, apiKeyRef: 'MY_OLLAMA_KEY' },
  effective: {
    baseURL: 'https://ollama.example',
    apiKeyRef: 'MY_OLLAMA_KEY',
    web: true,
  },
  models: [],
  configOverridesModels: false,
  keyUsable: true,
}

/** Everything the form told the page, plus every call it made. */
interface Recorded {
  confirmed: { provider: RosterProviderId; state: string; outcome: string }[]
  attention: RosterProviderId[]
  cancelled: number
  started: string[]
  manual: { provider: string; value: string }[]
  cancelAttempts: string[]
  copied: { provider: string; code: string }[]
  calls: { endpoint: string; payload: Record<string, unknown> }[]
}

function mount(
  options: {
    configured?: RosterProviderId[]
    validation?: 'valid' | 'invalid' | 'superseded'
    external?: Record<string, { configured: boolean }>
    statuses?: Record<string, unknown>
    deviceCodes?: Record<string, { userCode: string; verificationUrl: string }>
    errors?: Record<string, string>
    /** Holds the start request open, so a cancel can arrive mid-flight. */
    startGate?: () => Promise<void>
    /** What a fresh Ollama settings read answers, when it differs from the prop. */
    ollamaSettings?: unknown
  } = {},
) {
  const recorded: Recorded = {
    confirmed: [],
    attention: [],
    cancelled: 0,
    started: [],
    manual: [],
    cancelAttempts: [],
    copied: [],
    calls: [],
  }
  const rpc = {
    call: async (_channel: string, endpoint: string, payload: unknown) => {
      recorded.calls.push({
        endpoint,
        payload: (payload ?? {}) as Record<string, unknown>,
      })
      if (endpoint === 'subscriptions-auth.keySetCredential')
        return {
          ok: true,
          value: { committed: true, generation: 3, view: {} },
        }
      if (endpoint === 'subscriptions-auth.keyValidateCredential')
        return { ok: true, value: { outcome: options.validation ?? 'valid' } }
      if (endpoint === 'subscriptions-auth.externalStatus')
        return {
          ok: true,
          value: options.external ?? { 'kimi-code': { configured: true } },
        }
      if (endpoint === 'subscriptions-auth.ollamaSettings')
        return {
          ok: true,
          value: options.ollamaSettings ?? OLLAMA_VIEW,
        }
      return { ok: true, value: {} }
    },
  } as unknown as ConnectionHandle['rpc']
  const component = new Component(() =>
    AddProviderForm({
      rpc,
      t: t as never,
      configured: new Set(options.configured ?? ['codex']),
      ollamaSettings: OLLAMA_VIEW as never,
      statuses: (options.statuses ?? {}) as never,
      deviceCodes: (options.deviceCodes ?? {}) as never,
      errors: (options.errors ?? {}) as never,
      copiedCode: undefined,
      onStartLogin: async (provider, method) => {
        recorded.started.push(
          method === 'oauth' ? provider + ':oauth' : provider,
        )
        await options.startGate?.()
      },
      onCancelAttempt: (provider) => {
        recorded.cancelAttempts.push(provider)
      },
      onManualSubmit: (provider, value) => {
        recorded.manual.push({ provider, value })
      },
      onCopyDeviceCode: (provider, code) => {
        recorded.copied.push({ provider, code })
      },
      onCancel: () => {
        recorded.cancelled += 1
      },
      onConfirmed: (provider, state, outcome) => {
        recorded.confirmed.push({ provider, state, outcome })
      },
      onNeedsAttention: (provider) => {
        recorded.attention.push(provider)
      },
    }),
  )
  return { component, recorded }
}

/** The node a case needs, or a failure that names what was missing. */
function mustNode(found: Node | undefined, what: string): Node {
  if (found === undefined) throw new Error('missing ' + what)
  return found
}

function select(component: Component): Node {
  return mustNode(
    nodes(component.tree).find((entry) => entry.type === 'select'),
    'provider selector',
  )
}

function choose(component: Component, id: RosterProviderId) {
  select(component).props.onChange({
    currentTarget: { value: id },
  })
}

function passwordInput(component: Component): Node {
  return mustNode(
    nodes(component.tree).find(
      (entry) => entry.type === 'input' && entry.props.type === 'password',
    ),
    'masked key field',
  )
}

function button(component: Component, label: string): Node {
  return mustNode(
    nodes(component.tree).find(
      (entry) => entry.type === 'button' && text(entry) === label,
    ),
    'button ' + label,
  )
}

/** The footer action for the chosen family, by its copy. */
function primaryButton(component: Component): Node {
  const candidates = [
    en.addContinueBrowser,
    en.addGetDeviceCode,
    en.addSave,
    en.addSaveAddress,
    en.addCheckAgain,
  ]
  for (const label of candidates) {
    const found = nodes(component.tree).find(
      (entry) => entry.type === 'button' && text(entry) === label,
    )
    if (found !== undefined) return found
  }
  throw new Error('missing primary action')
}

test('the selector lists all eleven providers and marks the configured ones', async () => {
  const { component } = mount({ configured: ['codex', 'kimi-code'] })
  await settle(component)
  const options = nodes(component.tree).filter((node) => node.type === 'option')
  assert.equal(options.length, 12, 'a placeholder plus eleven providers')
  assert.deepEqual(
    options.slice(1).map((option) => option.props.children as string),
    SELECTOR_PROVIDERS.map((entry) =>
      entry.id === 'codex' || entry.id === 'kimi-code'
        ? t('addConfiguredOption', { name: entry.name })
        : entry.name,
    ),
  )
  const disabled = options
    .filter((option) => option.props.disabled === true)
    .map((option) => option.props.value)
  assert.deepEqual(disabled, ['codex', 'kimi-code'])
})

test('choosing a provider reveals its fields and writes nothing', async () => {
  const { component, recorded } = mount()
  await settle(component)
  choose(component, 'cursor')
  await settle(component)
  assert.ok(passwordInput(component))
  assert.deepEqual(recorded.calls, [])
})

test('switching providers discards the value typed for the previous one', async () => {
  const { component } = mount()
  await settle(component)
  choose(component, 'cursor')
  await settle(component)
  passwordInput(component).props.onChange({ target: { value: 'sk-typed' } })
  await settle(component)
  choose(component, 'ollama')
  await settle(component)
  choose(component, 'cursor')
  await settle(component)
  assert.equal(passwordInput(component).props.value, '')
})

test('canceling with nothing chosen writes nothing and returns to the roster', async () => {
  const { component, recorded } = mount()
  await settle(component)
  button(component, en.cancel).props.onClick()
  await settle(component)
  assert.equal(recorded.cancelled, 1)
  assert.deepEqual(recorded.calls, [])
  assert.deepEqual(recorded.confirmed, [])
})

test('a Cursor key is saved, then proven by the route read', async () => {
  const { component, recorded } = mount({ validation: 'valid' })
  await settle(component)
  choose(component, 'cursor')
  await settle(component)
  passwordInput(component).props.onChange({ target: { value: 'sk-cursor' } })
  await settle(component)
  button(component, en.addSave).props.onClick()
  await settle(component)
  assert.deepEqual(
    recorded.calls.map((call) => call.endpoint),
    [
      'subscriptions-auth.keySetCredential',
      'subscriptions-auth.keyValidateCredential',
    ],
  )
  assert.deepEqual(recorded.calls[0]!.payload, {
    route: 'cursor',
    value: 'sk-cursor',
  })
  assert.deepEqual(recorded.confirmed, [
    {
      provider: 'cursor',
      state: 'key',
      outcome: t('addOutcomeKey', { name: 'Cursor' }),
    },
  ])
})

test('a rejected key stays saved and says so; leaving marks it for attention', async () => {
  const { component, recorded } = mount({ validation: 'invalid' })
  await settle(component)
  choose(component, 'cursor')
  await settle(component)
  passwordInput(component).props.onChange({ target: { value: 'sk-bad' } })
  await settle(component)
  button(component, en.addSave).props.onClick()
  await settle(component)
  assert.match(text(component.tree), new RegExp(en.addKeyUnusableTitle))
  assert.deepEqual(recorded.confirmed, [], 'an unusable key is not a row')
  button(component, en.cancel).props.onClick()
  await settle(component)
  assert.deepEqual(recorded.attention, ['cursor'])
  assert.equal(recorded.cancelled, 1)
})

test('the Save action stays unavailable until the key is typed', async () => {
  const { component } = mount()
  await settle(component)
  choose(component, 'cursor')
  await settle(component)
  assert.equal(button(component, en.addSave).props.disabled, true)
  passwordInput(component).props.onChange({ target: { value: 'sk' } })
  await settle(component)
  assert.equal(button(component, en.addSave).props.disabled, false)
})

test('a local address re-sends the freshly read Ollama document with the new address', async () => {
  // The prop the form mounted with is stale on purpose: a model list and a
  // reference saved elsewhere must survive the replacement write.
  const fresh = {
    ...OLLAMA_VIEW,
    settings: {
      models: [{ id: 'fresh-model' }],
      web: false,
      apiKeyRef: 'FRESH_REF',
    },
  }
  const { component, recorded } = mount({ ollamaSettings: fresh })
  await settle(component)
  choose(component, 'ollama')
  await settle(component)
  button(component, en.addConnectionLocal).props.onClick()
  await settle(component)
  const url = mustNode(
    nodes(component.tree).find(
      (entry) => entry.type === 'input' && entry.props.type === 'url',
    ),
    'address field',
  )
  url.props.onChange({ target: { value: 'http://localhost:11434' } })
  await settle(component)
  button(component, en.addSaveAddress).props.onClick()
  await settle(component)
  const save = recorded.calls.find(
    (call) => call.endpoint === 'subscriptions-auth.ollamaSetSettings',
  )
  if (save === undefined) throw new Error('the address was not saved')
  assert.deepEqual(save.payload, {
    settings: {
      models: [{ id: 'fresh-model' }],
      web: false,
      apiKeyRef: 'FRESH_REF',
      baseURL: 'http://localhost:11434',
    },
  })
  assert.deepEqual(recorded.confirmed, [
    { provider: 'ollama', state: 'address', outcome: en.addOutcomeAddress },
  ])
})

test('the local form states that saving does not check reachability', async () => {
  const { component } = mount()
  await settle(component)
  choose(component, 'ollama')
  await settle(component)
  button(component, en.addConnectionLocal).props.onClick()
  await settle(component)
  assert.match(text(component.tree), new RegExp(en.addAddressCaveat))
})

test('an Ollama Cloud key saves through the Cloud route', async () => {
  const { component, recorded } = mount({ validation: 'valid' })
  await settle(component)
  choose(component, 'ollama')
  await settle(component)
  passwordInput(component).props.onChange({ target: { value: 'sk-cloud' } })
  await settle(component)
  button(component, en.addSave).props.onClick()
  await settle(component)
  assert.equal(recorded.calls[0]!.payload.route, 'ollama-cloud')
  assert.equal(recorded.confirmed[0]!.state, 'cloud-key')
})

test('a managed key is only checked: absent means the form says so', async () => {
  const { component, recorded } = mount({ external: {} })
  await settle(component)
  choose(component, 'kimi-code')
  await settle(component)
  assert.equal(
    nodes(component.tree).some(
      (node) => node.type === 'input' && node.props.type === 'password',
    ),
    false,
    'no key field is offered for a key Settings → Models owns',
  )
  button(component, en.addCheckAgain).props.onClick()
  await settle(component)
  assert.match(
    text(component.tree),
    new RegExp(en.addManagedKeyMissing.replace('{ref}', 'KIMI_CODING_API_KEY')),
  )
  assert.deepEqual(recorded.confirmed, [])
})

test('a present managed key confirms the provider', async () => {
  const { component, recorded } = mount({
    external: { 'kimi-code': { configured: true } },
  })
  await settle(component)
  choose(component, 'kimi-code')
  await settle(component)
  button(component, en.addCheckAgain).props.onClick()
  await settle(component)
  assert.deepEqual(recorded.confirmed, [
    {
      provider: 'kimi-code',
      state: 'key',
      outcome: t('addOutcomeManaged', { name: 'Kimi Code' }),
    },
  ])
})

test('a browser authorization is the page attempt, not a second one', async () => {
  const { component, recorded } = mount()
  await settle(component)
  choose(component, 'claude')
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  // The add flow asks for the browser method explicitly: without it, Claude's
  // login would import an existing CLI credential instead of signing in.
  assert.deepEqual(recorded.started, ['claude:oauth'])
  assert.deepEqual(recorded.calls, [], 'the page owns the login call')
})

test('while the browser waits, the form states it and offers the attempt cancel', async () => {
  const { component, recorded } = mount({
    statuses: { claude: { busy: true, accounts: [] } },
  })
  await settle(component)
  choose(component, 'claude')
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  assert.match(
    text(component.tree),
    new RegExp(en.addWaiting.replace('{provider}', 'Claude')),
  )
  button(component, en.addCancelSignIn).props.onClick()
  await settle(component)
  assert.deepEqual(recorded.cancelAttempts, ['claude'])
  assert.equal(recorded.cancelled, 0, 'the attempt cancel keeps the form open')
})

test('a manual callback value is submitted through the page', async () => {
  const { component, recorded } = mount({
    statuses: { grok: { busy: true, accounts: [] } },
  })
  await settle(component)
  choose(component, 'grok')
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  const input = mustNode(
    nodes(component.tree).find(
      (node) => node.type === 'input' && node.props.type === 'text',
    ),
    'manual callback field',
  )
  input.props.onChange({ target: { value: 'http://127.0.0.1/cb?code=1' } })
  await settle(component)
  button(component, en.submit).props.onClick()
  await settle(component)
  assert.deepEqual(recorded.manual, [
    { provider: 'grok', value: 'http://127.0.0.1/cb?code=1' },
  ])
})

test('the host terminal remark for the attempt is stated in the form', async () => {
  // Exchange and device-flow failures arrive in the provider's status as
  // `detail`, not as an action error: the form must announce that remark.
  const { component } = mount({
    configured: [],
    statuses: {
      claude: {
        busy: false,
        accounts: [],
        detail: 'authorization was refused',
      },
    },
  })
  await settle(component)
  choose(component, 'claude')
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  assert.match(text(component.tree), /authorization was refused/)
  assert.ok(button(component, en.cancel), 'the form is still open')
})

test('an action error is stated in the form, which stays open', async () => {
  const { component } = mount({
    configured: [],
    errors: { claude: 'login answered without an authorizeUrl' },
  })
  await settle(component)
  choose(component, 'claude')
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  assert.match(text(component.tree), /login answered without an authorizeUrl/)
  assert.ok(button(component, en.cancel), 'the form is still open')
})

test('a confirmed authorization adds the row once', async () => {
  const { component, recorded } = mount({
    statuses: {
      claude: { busy: false, accounts: [{ key: 'me', isDefault: true }] },
    },
  })
  await settle(component)
  choose(component, 'claude')
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  assert.equal(recorded.confirmed.length, 1)
  assert.deepEqual(recorded.confirmed[0], {
    provider: 'claude',
    state: 'accounts-one',
    outcome: t('addOutcomeProvider', { name: 'Claude' }),
  })
})

test('a device code is shown with its copy action', async () => {
  const { component, recorded } = mount({
    statuses: { copilot: { busy: true, accounts: [] } },
    deviceCodes: {
      copilot: {
        userCode: 'ABCD-1234',
        verificationUrl: 'https://example.invalid',
      },
    },
  })
  await settle(component)
  choose(component, 'copilot')
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  assert.match(text(component.tree), /ABCD-1234/)
  button(component, en.deviceCodeCopy).props.onClick()
  await settle(component)
  assert.deepEqual(recorded.copied, [
    { provider: 'copilot', code: 'ABCD-1234' },
  ])
})

test('switching is refused while an attempt runs, so no attempt is abandoned', async () => {
  const { component } = mount({
    statuses: { claude: { busy: true, accounts: [] } },
  })
  await settle(component)
  choose(component, 'claude')
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  assert.equal(select(component).props.disabled, true, 'the selector is locked')
  choose(component, 'cursor')
  await settle(component)
  assert.equal(select(component).props.value, 'claude', 'the choice stands')
})

test('a cancel that arrives during the start request reaches the attempt', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { component, recorded } = mount({ startGate: () => gate })
  await settle(component)
  choose(component, 'claude')
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  // Footer Cancel while the page is still answering the login request.
  button(component, en.cancel).props.onClick()
  assert.equal(recorded.cancelled, 1)
  assert.deepEqual(recorded.cancelAttempts, [], 'nothing to cancel yet')
  release()
  await settle(component)
  assert.deepEqual(
    recorded.cancelAttempts,
    ['claude'],
    'the attempt is canceled',
  )
})

test('a rejected key keeps its verdict when the provider is switched', async () => {
  const { component, recorded } = mount({ validation: 'invalid' })
  await settle(component)
  choose(component, 'cursor')
  await settle(component)
  passwordInput(component).props.onChange({ target: { value: 'sk-bad' } })
  await settle(component)
  button(component, en.addSave).props.onClick()
  await settle(component)
  choose(component, 'ollama')
  await settle(component)
  choose(component, 'cursor')
  await settle(component)
  assert.match(text(component.tree), new RegExp(en.addKeyUnusableTitle))
  button(component, en.cancel).props.onClick()
  await settle(component)
  assert.deepEqual(recorded.attention, ['cursor'], 'the saved key is reported')
})

test('only Claude names the sign-in method the host accepts', async () => {
  for (const provider of ['claude', 'grok', 'copilot'] as const) {
    const { component, recorded } = mount({ configured: [] })
    await settle(component)
    choose(component, provider)
    await settle(component)
    primaryButton(component).props.onClick()
    await settle(component)
    assert.deepEqual(
      recorded.started,
      [provider === 'claude' ? 'claude:oauth' : provider],
      provider + ' asks for the method only when it has a second one',
    )
  }
})

test('canceling the sign-in stops a later account from confirming', async () => {
  const options: Parameters<typeof mount>[0] = {
    statuses: { claude: { busy: true, accounts: [] } },
  }
  const { component, recorded } = mount(options)
  await settle(component)
  choose(component, 'claude')
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  button(component, en.addCancelSignIn).props.onClick()
  await settle(component)
  assert.deepEqual(recorded.cancelAttempts, ['claude'])
  // The attempt completes anyway: the canceled form must not add a row.
  options!.statuses = {
    claude: { busy: false, accounts: [{ key: 'me', isDefault: true }] },
  }
  await settle(component)
  assert.deepEqual(recorded.confirmed, [])
})

test('canceling after a switch marks the provider the verdict belongs to', async () => {
  const { component, recorded } = mount({ validation: 'invalid' })
  await settle(component)
  choose(component, 'cursor')
  await settle(component)
  passwordInput(component).props.onChange({ target: { value: 'sk-bad' } })
  await settle(component)
  button(component, en.addSave).props.onClick()
  await settle(component)
  choose(component, 'ollama')
  await settle(component)
  button(component, en.cancel).props.onClick()
  await settle(component)
  assert.deepEqual(recorded.attention, ['cursor'])
  assert.equal(recorded.cancelled, 1)
})

test('a confirmation of another route still hands over the rejected verdict', async () => {
  const { component, recorded } = mount({
    validation: 'invalid',
    external: { 'kimi-code': { configured: true } },
  })
  await settle(component)
  choose(component, 'cursor')
  await settle(component)
  passwordInput(component).props.onChange({ target: { value: 'sk-bad' } })
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  choose(component, 'kimi-code')
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  assert.deepEqual(
    recorded.confirmed.map((entry) => entry.provider),
    ['kimi-code'],
  )
  assert.deepEqual(
    recorded.attention,
    ['cursor'],
    'the verdict survives the form',
  )
  assert.equal(recorded.cancelled, 0, 'a confirmation is not a cancel')
})

test('two rejected routes each keep their verdict', async () => {
  const { component, recorded } = mount({ validation: 'invalid' })
  await settle(component)
  choose(component, 'cursor')
  await settle(component)
  passwordInput(component).props.onChange({ target: { value: 'sk-bad' } })
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  choose(component, 'ollama')
  await settle(component)
  passwordInput(component).props.onChange({ target: { value: 'sk-cloud' } })
  await settle(component)
  primaryButton(component).props.onClick()
  await settle(component)
  button(component, en.cancel).props.onClick()
  await settle(component)
  assert.deepEqual(recorded.attention.sort(), ['cursor', 'ollama'])
})

test('nothing is written before a primary action, in any family', async () => {
  for (const id of SELECTOR_PROVIDERS.map((entry) => entry.id)) {
    const { component, recorded } = mount({ configured: [] })
    await settle(component)
    choose(component, id)
    await settle(component)
    assert.deepEqual(recorded.calls, [], id + ' writes nothing on selection')
  }
})
