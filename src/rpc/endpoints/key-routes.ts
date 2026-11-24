/**
 * The key-based route surfaces: Ollama Cloud's catalog and connection settings,
 * the Cursor card and model manager, and the credential both routes read.
 */

import { MAX_CURSOR_CEILING_USD } from '../../providers/cursor-settings.js'
import { BadRequest } from '../transport.js'
import {
  readCredentialValue,
  readForce,
  readGeneration,
  readKeyRoute,
  readOllamaBaseURL,
  readOptionalString,
} from '../payload.js'
import type { EndpointHandler, EndpointName } from './types.js'

/** Read a payload's `settings` object, which every save endpoint carries. */
function readSettingsObject(payload: unknown, what: string): unknown {
  const body = payload as Record<string, unknown> | null
  const settings =
    body !== null && typeof body === 'object' ? body.settings : undefined
  if (
    settings === null ||
    typeof settings !== 'object' ||
    Array.isArray(settings)
  )
    throw new BadRequest(`${what} needs a settings object`)
  return settings
}

export const keyRouteEndpoints = {
  async ollamaSettings(_payload, { controllers }) {
    if (!controllers.ollama)
      throw new BadRequest('Ollama settings are unavailable')
    return await controllers.ollama.settings()
  },
  async ollamaSetSettings(payload, { controllers }) {
    if (!controllers.ollama)
      throw new BadRequest('Ollama settings are unavailable')
    // The controller's own validator owns the settings shape and its messages;
    // this endpoint only refuses a payload that is not an object at all, as it
    // always did.
    if (payload === null || typeof payload !== 'object')
      throw new BadRequest('payload must be an object')
    await controllers.ollama.setSettings(
      (payload as Record<string, unknown>).settings,
    )
    return { ok: true }
  },
  async ollamaModels(payload, { controllers, signal }) {
    if (!controllers.ollama)
      throw new BadRequest('Ollama settings are unavailable')
    const apiKey = readOptionalString(payload, 'apiKey')
    const baseURL = readOllamaBaseURL(payload)
    return await controllers.ollama.models(
      {
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(baseURL === undefined ? {} : { baseURL }),
      },
      signal,
    )
  },
  async cursorSettings(_payload, { controllers }) {
    if (!controllers.cursor)
      throw new BadRequest('Cursor settings are unavailable')
    return await controllers.cursor.settings()
  },
  async cursorModels(payload, { controllers }) {
    if (!controllers.cursor)
      throw new BadRequest('Cursor settings are unavailable')
    return await controllers.cursor.models(readForce(payload))
  },
  async cursorSetSettings(payload, { controllers }) {
    if (!controllers.cursor)
      throw new BadRequest('Cursor settings are unavailable')
    await controllers.cursor.setSettings(
      readSettingsObject(payload, 'cursorSetSettings'),
    )
    return { ok: true }
  },
  async cursorRefreshContext(_payload, { controllers }) {
    if (!controllers.cursor)
      throw new BadRequest('Cursor settings are unavailable')
    return await controllers.cursor.refreshContext()
  },
  async cursorSetCeiling(payload, { controllers }) {
    if (!controllers.cursor)
      throw new BadRequest('Cursor settings are unavailable')
    const body = payload as Record<string, unknown> | null
    if (body === null || typeof body !== 'object' || !('ceilingUSD' in body))
      throw new BadRequest(
        'cursorSetCeiling needs an explicit ceilingUSD, null to clear',
      )
    const raw = body.ceilingUSD
    if (raw !== null) {
      if (
        typeof raw !== 'number' ||
        !Number.isFinite(raw) ||
        raw <= 0 ||
        raw > MAX_CURSOR_CEILING_USD
      ) {
        throw new BadRequest(
          `ceilingUSD must be a positive number up to ${MAX_CURSOR_CEILING_USD}, or null`,
        )
      }
    }
    await controllers.cursor.setCeiling(raw === null ? undefined : raw)
    return { ok: true }
  },
  async keyCredential(payload, { controllers }) {
    if (!controllers.keyCredentials)
      throw new BadRequest('key credentials are unavailable')
    return await controllers.keyCredentials.describe(readKeyRoute(payload))
  },
  async keySetCredential(payload, { controllers }) {
    if (!controllers.keyCredentials)
      throw new BadRequest('key credentials are unavailable')
    const route = readKeyRoute(payload)
    return await controllers.keyCredentials.set(
      route,
      readCredentialValue(payload),
    )
  },
  async keyClearCredential(payload, { controllers }) {
    if (!controllers.keyCredentials)
      throw new BadRequest('key credentials are unavailable')
    return await controllers.keyCredentials.clear(readKeyRoute(payload))
  },
  async keyValidateCredential(payload, { controllers }) {
    if (!controllers.keyCredentials)
      throw new BadRequest('key credentials are unavailable')
    // No caller-supplied value: the host reads the committed credential itself.
    return await controllers.keyCredentials.validate(
      readKeyRoute(payload),
      readGeneration(payload),
    )
  },
} satisfies Partial<Record<EndpointName, EndpointHandler>>
