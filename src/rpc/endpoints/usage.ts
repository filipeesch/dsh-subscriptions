/**
 * Quota readings for subscriptions whose model routes live outside this plugin:
 * the sources authenticate with an API key and expose only usage.
 */

import { EXTERNAL_USAGE_SOURCES } from '../../providers/external-usage-controller.js'
import type { ExternalUsageSource } from '../../providers/external-usage-controller.js'
import { BadRequest } from '../transport.js'
import { readString } from '../payload.js'
import type { EndpointHandler, EndpointName } from './types.js'

export const usageEndpoints = {
  async externalStatus(_payload, { controllers }) {
    if (!controllers.externalUsage)
      throw new BadRequest('external usage is unavailable')
    return await controllers.externalUsage.status()
  },
  async externalUsage(payload, { controllers, signal }) {
    if (!controllers.externalUsage)
      throw new BadRequest('external usage is unavailable')
    // The source field keeps the endpoint's original diagnostics: a missing or
    // blank source is read by the shared string reader, and an unknown one names
    // the accepted set.
    const source = readString(payload, 'source')
    if (!(EXTERNAL_USAGE_SOURCES as readonly string[]).includes(source)) {
      throw new BadRequest(
        `payload.source must be one of ${EXTERNAL_USAGE_SOURCES.join(', ')}`,
      )
    }
    return await controllers.externalUsage.usage(
      source as ExternalUsageSource,
      signal,
      (payload as Record<string, unknown>).force === true,
    )
  },
} satisfies Partial<Record<EndpointName, EndpointHandler>>
