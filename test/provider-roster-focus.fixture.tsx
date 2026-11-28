/**
 * Interactive focus fixture for the subscriptions page: the shipped section,
 * mounted against a fake RPC, so a browser run can observe focus moving on its
 * own rather than being placed by a test.
 *
 * Bundled by scripts/manual/focus-flow-proof.mjs and driven through Chrome's
 * debugging protocol; nothing here talks to a provider or writes settings.
 */
import { createRoot } from 'react-dom/client'
import { SubscriptionsSection } from '../src/client/SubscriptionsSection.js'
import type {
  ProviderStatus,
  SubscriptionProvider,
} from '../src/client/SubscriptionsSection.js'
import { en } from '../src/client/locales.js'

const state = window as any
state.calls = []
state.cursorConfigured = false

/** One OAuth provider's reported state. */
function statusOf(
  accounts: { key: string; isDefault?: boolean }[],
): ProviderStatus {
  return {
    busy: false,
    accounts: accounts.map((account, index) => ({
      key: account.key,
      isDefault: account.isDefault ?? index === 0,
    })),
  } as ProviderStatus
}

const PROVIDERS: Record<SubscriptionProvider, ProviderStatus> = {
  codex: statusOf([{ key: 'codex-demo' }]),
  claude: statusOf([]),
  grok: statusOf([]),
  copilot: statusOf([]),
  antigravity: statusOf([]),
}

const rpc = {
  call: async (_channel: string, endpoint: string, payload: any) => {
    state.calls.push({ endpoint, payload })
    if (endpoint === 'subscriptions-auth.status')
      return { ok: true, value: { providers: PROVIDERS } }
    if (endpoint === 'subscriptions-auth.externalStatus')
      return {
        ok: true,
        value: {
          'kimi-code': { configured: true },
          // A stored key is what the route reports after the write commits.
          ...(state.cursorConfigured ? { cursor: { configured: true } } : {}),
        },
      }
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
    if (endpoint === 'subscriptions-auth.keySetCredential') {
      state.cursorConfigured = true
      return {
        ok: true,
        value: {
          committed: true,
          generation: 7,
          view: {
            route: 'cursor',
            keyRef: 'CURSOR_API_KEY',
            configured: true,
            source: 'file',
            writable: true,
          },
        },
      }
    }
    if (endpoint === 'subscriptions-auth.keyValidateCredential')
      return { ok: true, value: { outcome: 'valid' } }
    if (endpoint === 'subscriptions-auth.usage')
      return { ok: true, value: { supported: false } }
    return { ok: true, value: {} }
  },
} as any

const t = ((key: string, params?: Record<string, unknown>) =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll('{' + name + '}', String(value)),
    (en as Record<string, string>)[key] ?? key,
  )) as any

function App() {
  return <SubscriptionsSection rpc={rpc} t={t} />
}

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
// The driver waits for this before touching the page. A separate assignment:
// a following parenthesized expression would parse as a call on render().
state.ready = true
