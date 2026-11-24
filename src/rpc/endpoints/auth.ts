/**
 * Account and login endpoints: provider status, the login attempts, account
 * selection, per-account usage, and the Codex reset redemption.
 */

import { PROVIDER_IDS } from '../../auth/store.js'
import { BadRequest } from '../transport.js'
import {
  readForce,
  readLoginMethod,
  readProvider,
  readString,
} from '../payload.js'
import type { ProviderStatus } from '../contracts.js'
import type { EndpointHandler, EndpointName } from './types.js'

export const authEndpoints = {
  async status(_payload, { controllers }) {
    // One provider's failure (a corrupt store entry, a broken flow) must not
    // blind the whole page: it degrades to an error detail on that provider
    // while the others still report their real status.
    const entries = await Promise.all(
      PROVIDER_IDS.map(
        async (provider) =>
          [
            provider,
            await controllers.controller.status(provider).catch(
              (error: unknown) =>
                ({
                  busy: false,
                  accounts: [],
                  detail:
                    error instanceof Error ? error.message : String(error),
                }) satisfies ProviderStatus,
            ),
          ] as const,
      ),
    )
    return {
      providers: Object.fromEntries(
        entries.map(([provider, status]) => {
          const visibleModels =
            controllers.providerSettings?.visibleModels?.(provider)
          return [
            provider,
            {
              ...status,
              ...(visibleModels === undefined ? {} : { visibleModels }),
            },
          ]
        }),
      ),
    }
  },
  async login(payload, { controllers }) {
    const provider = readProvider(payload)
    return await controllers.controller.login(
      provider,
      readLoginMethod(payload, provider),
    )
  },
  async manual(payload, { controllers }) {
    const provider = readProvider(payload)
    await controllers.controller.manual(provider, readString(payload, 'input'))
    return { ok: true }
  },
  async cancel(payload, { controllers }) {
    await controllers.controller.cancel(readProvider(payload))
    return { ok: true }
  },
  async logout(payload, { controllers }) {
    const provider = readProvider(payload)
    await controllers.controller.logout(
      provider,
      readString(payload, 'account'),
    )
    return { ok: true }
  },
  async setDefault(payload, { controllers }) {
    const provider = readProvider(payload)
    await controllers.controller.setDefault(
      provider,
      readString(payload, 'account'),
    )
    return { ok: true }
  },
  async usage(payload, { controllers, signal }) {
    const provider = readProvider(payload)
    return await controllers.controller.usage(
      provider,
      readString(payload, 'account'),
      signal,
      readForce(payload),
    )
  },
  async prepareReset(payload, { controllers, signal }) {
    if (!controllers.controller.prepareReset)
      throw new BadRequest('Reset redemption unavailable')
    return await controllers.controller.prepareReset(
      readString(payload, 'account'),
      signal,
    )
  },
  async consumeReset(payload, { controllers, signal }) {
    if (!controllers.controller.consumeReset)
      throw new BadRequest('Reset redemption unavailable')
    await controllers.controller.consumeReset(
      readString(payload, 'account'),
      readString(payload, 'ticket'),
      signal,
    )
    return { ok: true }
  },
} satisfies Partial<Record<EndpointName, EndpointHandler>>
