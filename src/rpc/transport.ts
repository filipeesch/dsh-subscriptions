/**
 * The `subscriptions-auth` wire: the shared `/api` channel name, the exact-route
 * bridge that carries one endpoint's RPC envelope, and the result shapes the
 * handlers answer with. Endpoint behaviour lives in `src/rpc/endpoints/`.
 */

import type { RpcResult } from '../compat.js'

/**
 * Endpoint-name prefix under the shared `/api` channel: endpoint `status` is
 * served at `/api/subscriptions-auth.status`. The browser half calls
 * `rpc.call('/api', 'subscriptions-auth.status', payload)`.
 */
export const SUBSCRIPTIONS_AUTH_PREFIX = 'subscriptions-auth.'

/** Payload carried no usable provider id — an RPC client bug, not a server failure. */
export class BadRequest extends Error {}

/**
 * Structural face of `connection.fetch.register` shared by both dsh lines.
 * The 0.1.2-alpha typings list only `GET`/`HEAD` methods and no
 * `requestBody`, while the 0.1.5 line adds `POST` plus the body mode; the
 * runtime on both lines dispatches any declared method to the exact route,
 * so the route is typed here rather than against either line's declaration.
 */
export interface FetchRouteCompat {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  /** Buffered: the bridge aggregates the JSON body before `fetch` runs (0.1.5+; ignored earlier). */
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

export type FetchRegisterCompat = (
  route: FetchRouteCompat,
) => () => Promise<void>

/** The private exact-route bridge uses only the endpoint, payload, and signal. */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>

/** Connection `client-request` envelope, as the browser rpc caller sends it. */
interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

function readEnvelope(body: unknown): ClientRequestEnvelope | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (
    record.type !== 'client-request' ||
    typeof record.rpcId !== 'string' ||
    typeof record.method !== 'string'
  )
    return undefined
  return {
    type: 'client-request',
    rpcId: record.rpcId,
    method: record.method,
    payload: record.payload,
  }
}

function serverResponse(rpcId: string, result: RpcResult<unknown>): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

/** A successful result. */
export function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

/**
 * Map a thrown failure to the result the browser unwraps. A {@link BadRequest}
 * is the caller's mistake and reads as such; everything else is reported as an
 * internal failure carrying the handler's own message.
 */
export function failure(error: unknown): RpcResult<unknown> {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof BadRequest) {
    // The issues array is zod-shaped upstream; this channel validates by hand.
    return {
      ok: false,
      error: { code: 'bad-request', message, details: { issues: [] } },
    }
  }
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/**
 * Wrap one endpoint's handler as an exact Fetch route: decode the
 * `client-request` envelope the browser rpc caller posts, run the handler, and
 * answer with the matching `server-response` envelope.
 * @param endpoint - endpoint name, addressed as `subscriptions-auth.<endpoint>`.
 * @param handler - the endpoint dispatcher.
 * @returns the route the connection registers.
 */
export function fetchRouteFor(
  endpoint: string,
  handler: ConnectionRpcHandler,
): FetchRouteCompat {
  const method = `${SUBSCRIPTIONS_AUTH_PREFIX}${endpoint}`
  return {
    path: `/api/${method}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (
        request.headers
          .get('content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase() !== 'application/json'
      ) {
        return new Response('content type must be application/json', {
          status: 415,
        })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = readEnvelope(body)
      if (envelope === undefined) {
        const rawId = (body as Record<string, unknown> | null)?.rpcId
        return serverResponse(
          typeof rawId === 'string' ? rawId : 'invalid-request',
          {
            ok: false,
            error: {
              code: 'gateway/bad-request',
              message: 'invalid client-request message',
              details: { issues: [] },
            },
          },
        )
      }
      if (envelope.method !== method) {
        return serverResponse(envelope.rpcId, {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(method)}`,
            details: { issues: [] },
          },
        })
      }
      return serverResponse(
        envelope.rpcId,
        await handler(endpoint, envelope.payload, request.signal),
      )
    },
  }
}
