/** The composer's Speed toggle: the session's tier and its fast-model list. */

import { readModel, readSessionId, readSpeedTier } from '../payload.js'
import type { EndpointHandler, EndpointName } from './types.js'

export const speedEndpoints = {
  async speed(payload, { controllers }) {
    return await controllers.speed.speed(
      readSessionId(payload),
      (payload as Record<string, unknown>).model === undefined
        ? undefined
        : readModel(payload),
    )
  },
  async setSpeed(payload, { controllers }) {
    await controllers.speed.setSpeed(
      readSessionId(payload),
      readSpeedTier(payload),
      (payload as Record<string, unknown>).model === undefined
        ? undefined
        : readModel(payload),
    )
    return { ok: true }
  },
} satisfies Partial<Record<EndpointName, EndpointHandler>>
