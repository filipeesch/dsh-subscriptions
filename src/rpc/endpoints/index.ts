/**
 * The endpoint table: one handler per `subscriptions-auth` endpoint, composed
 * from the per-domain modules. The map is checked against {@link EndpointName},
 * so a missing or unknown endpoint fails the build instead of answering 404 at
 * runtime.
 */

import { authEndpoints } from './auth.js'
import { mediaEndpoints } from './media.js'
import { modelEndpoints } from './models.js'
import { speedEndpoints } from './speed.js'
import { usageEndpoints } from './usage.js'
import { keyRouteEndpoints } from './key-routes.js'
import { BadRequest, ok } from '../transport.js'
import type { RpcResult } from '../../compat.js'
import type { EndpointContext, EndpointHandler, EndpointName } from './types.js'

export type { EndpointContext, EndpointHandler, EndpointName } from './types.js'

const HANDLERS = {
  ...authEndpoints,
  ...modelEndpoints,
  ...mediaEndpoints,
  ...usageEndpoints,
  ...speedEndpoints,
  ...keyRouteEndpoints,
} satisfies Record<EndpointName, EndpointHandler>

/** Every endpoint the channel answers; each gets one exact Fetch route. */
export const SUBSCRIPTIONS_AUTH_ENDPOINTS: readonly EndpointName[] =
  Object.keys(HANDLERS) as EndpointName[]

/**
 * Answer one endpoint.
 * @param controllers - the assembled controller set.
 * @param endpoint - endpoint name from the route.
 * @param payload - the caller's payload.
 * @param signal - caller cancellation from the transport.
 * @returns the result envelope the browser unwraps.
 */
export async function dispatch(
  controllers: EndpointContext['controllers'],
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<RpcResult<unknown>> {
  const handler = HANDLERS[endpoint as EndpointName]
  if (handler === undefined)
    throw new BadRequest(`unknown /subscriptions-auth endpoint "${endpoint}"`)
  return ok(await handler(payload, { controllers, signal }))
}
