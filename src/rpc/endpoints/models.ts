/** Provider visibility, account preferences, and per-model default effort. */

import { BadRequest } from '../transport.js'
import { readForce, readModelDefaultInput, readProvider } from '../payload.js'
import type { EndpointHandler, EndpointName } from './types.js'

export const modelEndpoints = {
  async providerSettings(payload, { controllers }) {
    if (!controllers.providerSettings)
      throw new BadRequest('provider settings are unavailable')
    return await controllers.providerSettings.get(
      readProvider(payload),
      readForce(payload),
    )
  },
  async setProviderSettings(payload, { controllers }) {
    if (!controllers.providerSettings)
      throw new BadRequest('provider settings are unavailable')
    const provider = readProvider(payload)
    await controllers.providerSettings.set(
      provider,
      (payload as Record<string, unknown>).settings,
    )
    return { ok: true }
  },
  async modelDefaults(payload, { controllers }) {
    if (controllers.modelDefaults === undefined)
      throw new BadRequest('model defaults are unavailable')
    return await controllers.modelDefaults.catalog(readForce(payload))
  },
  async setModelDefault(payload, { controllers }) {
    if (controllers.modelDefaults === undefined)
      throw new BadRequest('model defaults are unavailable')
    const input = readModelDefaultInput(payload)
    await controllers.modelDefaults.set(
      input.provider,
      input.model,
      input.effort,
    )
    return { ok: true }
  },
} satisfies Partial<Record<EndpointName, EndpointHandler>>
