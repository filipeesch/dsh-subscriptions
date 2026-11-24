/**
 * What one `subscriptions-auth` endpoint handler receives. The controller set
 * is the whole reachable surface; an optional controller that this profile did
 * not assemble answers its "unavailable" refusal.
 */

import type {
  AuthController,
  CursorRpcController,
  ExternalUsageRpcController,
  KeyCredentialRpcController,
  ModelDefaultsController,
  OllamaRpcController,
  ProviderSettingsController,
  SpeedController,
} from '../contracts.js'

/**
 * Every endpoint the channel serves. It is the single source of the route
 * table: the composed handler map is checked against it, so an endpoint that is
 * missing or unknown fails the build.
 */
export type EndpointName =
  | 'providerSettings'
  | 'setProviderSettings'
  | 'status'
  | 'login'
  | 'manual'
  | 'cancel'
  | 'logout'
  | 'setDefault'
  | 'usage'
  | 'externalStatus'
  | 'externalUsage'
  | 'ollamaSettings'
  | 'ollamaSetSettings'
  | 'ollamaModels'
  | 'cursorSettings'
  | 'cursorSetCeiling'
  | 'cursorModels'
  | 'cursorSetSettings'
  | 'cursorRefreshContext'
  | 'keyCredential'
  | 'keySetCredential'
  | 'keyClearCredential'
  | 'keyValidateCredential'
  | 'image'
  | 'video'
  | 'prepareReset'
  | 'consumeReset'
  | 'speed'
  | 'setSpeed'
  | 'modelDefaults'
  | 'setModelDefault'

/** The controllers one request may reach. */
export interface EndpointControllers {
  controller: AuthController
  speed: SpeedController
  modelDefaults?: ModelDefaultsController
  providerSettings?: ProviderSettingsController
  externalUsage?: ExternalUsageRpcController
  ollama?: OllamaRpcController
  cursor?: CursorRpcController
  keyCredentials?: KeyCredentialRpcController
}

/** The request-scoped facts every handler is given. */
export interface EndpointContext {
  controllers: EndpointControllers
  /** Caller cancellation from the RPC transport. */
  signal: AbortSignal
}

/** One endpoint's behaviour: validate, act, return the value for the caller. */
export type EndpointHandler = (
  payload: unknown,
  context: EndpointContext,
) => Promise<unknown>
