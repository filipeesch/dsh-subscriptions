/** Inline media reads: one image attachment's bytes and one generated video. */

import { readImageRef, readVideoName } from '../payload.js'
import type { EndpointHandler, EndpointName } from './types.js'

export const mediaEndpoints = {
  async image(payload, { controllers, signal }) {
    return await controllers.controller.readImage(readImageRef(payload), signal)
  },
  async video(payload, { controllers, signal }) {
    return await controllers.controller.readVideo(
      readVideoName(payload),
      signal,
    )
  },
} satisfies Partial<Record<EndpointName, EndpointHandler>>
