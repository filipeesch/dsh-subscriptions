/**
 * The `subscriptions-auth` host RPC the web Settings page drives.
 *
 * Endpoints are mounted as exact POST Fetch routes on the shared `/api`
 * channel (`/api/subscriptions-auth.<endpoint>`) and registered only when a host
 * `connection` service exists (the web profile); headless compositions load the
 * plugin without it. Every business outcome is returned as an RpcResult value;
 * handlers never throw.
 *
 * This module owns the channel's public contract and its registration. The
 * endpoint behaviour lives in `src/rpc/endpoints/`, the wire in
 * `src/rpc/transport.ts`, and the payload rules in `src/rpc/payload.ts`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { SUBSCRIPTIONS_AUTH_PREFIX, fetchRouteFor } from '../rpc/transport.js'
import type {
  ConnectionRpcHandler,
  FetchRegisterCompat,
} from '../rpc/transport.js'
import {
  SUBSCRIPTIONS_AUTH_ENDPOINTS,
  dispatch,
} from '../rpc/endpoints/index.js'
import type { EndpointControllers } from '../rpc/endpoints/types.js'
import { failure } from '../rpc/transport.js'

export { BadRequest, SUBSCRIPTIONS_AUTH_PREFIX } from '../rpc/transport.js'
export { SUBSCRIPTIONS_AUTH_ENDPOINTS } from '../rpc/endpoints/index.js'
export type {
  AccountStatus,
  AuthController,
  CursorKnownContextView,
  CursorModelsView,
  CursorRefreshView,
  CursorRpcController,
  CursorSettingsView,
  ExternalUsageRpcController,
  ImageBytesResult,
  KeyCredentialRpcController,
  LoginMethod,
  ModelDefaultsCatalog,
  ModelDefaultsController,
  ModelDefaultView,
  OllamaCloudCandidate,
  OllamaModelView,
  OllamaRpcController,
  OllamaSettingsView,
  ProviderAccountCatalog,
  ProviderSettingsController,
  ProviderStatus,
  SpeedController,
  SpeedState,
  SpeedTier,
  VideoBytesResult,
} from '../rpc/contracts.js'
export type {
  ExternalUsageSource,
  ExternalUsageStatus,
} from '../providers/external-usage-controller.js'
export type {
  KeyCredentialView,
  KeyRouteId,
} from '../providers/key-credentials.js'

/** The controllers this channel serves; the plugin assembles each one. */
export type AuthRpcOptions = EndpointControllers

/**
 * Register the `/subscriptions-auth` RPC channel when a host connection exists.
 * @param ctx - the plugin context (headless profiles have no `connection`).
 * @param options - the controllers backing the endpoints; an absent optional
 *   controller answers its own "unavailable" refusal.
 */
export function registerAuthRpc(ctx: Context, options: AuthRpcOptions): void {
  // `connection` is not in this plugin's inject list (headless compositions
  // lack it), so its startup order is unconstrained: defer registration until
  // the service exists instead of probing once at apply time.
  //
  // Exact Fetch routes under `/api` rather than a dedicated `rpc.handle`
  // channel: since dsh 0.1.5 the connection plugin no longer injects
  // `webServer` itself, and `rpc.handle` resolves `webServer` through the
  // connection plugin's own fiber, so every dedicated channel registration
  // throws `cannot get property "webServer" without inject`. The `/api` route is
  // mounted by the connection plugin (with its own webServer scope) and applies
  // the same trust fence and browser authentication, so exact routes below it
  // work on both dsh lines.
  ctx.inject(['connection'], (ctx) => {
    const connection = ctx.get('connection') as HostConnectionHandle
    const handler: ConnectionRpcHandler = async (endpoint, payload, signal) => {
      try {
        return await dispatch(options, endpoint, payload, signal)
      } catch (error) {
        return failure(error)
      }
    }
    const register = connection.fetch.register as unknown as FetchRegisterCompat
    for (const endpoint of SUBSCRIPTIONS_AUTH_ENDPOINTS) {
      ctx.effect(
        () => register(fetchRouteFor(endpoint, handler)),
        `dsh-subscriptions: /api/${SUBSCRIPTIONS_AUTH_PREFIX}${endpoint} route`,
      )
    }
  })
}
