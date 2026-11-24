/**
 * Payload validation shared by the `subscriptions-auth` endpoint handlers.
 * Every reader throws {@link BadRequest} with a message naming the offending
 * field, so a browser bug reads as a bad request rather than a server failure.
 */

import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { KEY_ROUTE_IDS, isKeyRouteId } from '../providers/key-credentials.js'
import type { KeyRouteId } from '../providers/key-credentials.js'
import { validateOllamaBaseURL } from '../providers/ollama-settings.js'
import { PROVIDER_IDS } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import { hasControlCharacters } from '../providers/credential-text.js'
import { BadRequest } from './transport.js'
import type { LoginMethod, SpeedTier } from './contracts.js'

/** Media types the attachment store accepts (ImageMediaType). */
const IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const

/** Bare MP4 file names the `video` endpoint accepts (no path separators). */
const VIDEO_NAME_PATTERN = /^[\w.-]+\.mp4$/

/** Longest credential value the card may submit. */
const MAX_CREDENTIAL_LENGTH = 4096

/**
 * Read the provider a payload names.
 * @throws BadRequest when the payload names no known provider route.
 */
export function readProvider(payload: unknown): ProviderId {
  if (typeof payload !== 'object' || payload === null)
    throw new BadRequest('payload must be an object')
  const provider = (payload as Record<string, unknown>).provider
  if (
    typeof provider !== 'string' ||
    !(PROVIDER_IDS as readonly string[]).includes(provider)
  ) {
    throw new BadRequest(
      `payload.provider must be one of ${PROVIDER_IDS.join(', ')}`,
    )
  }
  return provider as ProviderId
}

/**
 * Read one required non-empty string field.
 * @throws BadRequest when the field is missing or empty.
 */
export function readString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`payload.${field} must be a non-empty string`)
  }
  return value
}

/** Read a model id, rejecting whitespace-only values that cannot be persisted. */
export function readModel(payload: unknown): string {
  const model = readString(payload, 'model')
  if (model.trim().length === 0)
    throw new BadRequest('payload.model must not be blank')
  return model
}

/**
 * Read a field that may be omitted, rejecting an empty or non-string value.
 * @throws BadRequest when the field is present but unusable.
 */
export function readOptionalString(
  payload: unknown,
  field: string,
): string | undefined {
  if (typeof payload !== 'object' || payload === null)
    throw new BadRequest('payload must be an object')
  const value = (payload as Record<string, unknown>)[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequest(
      `payload.${field} must be a non-empty string when present`,
    )
  }
  return value
}

/** Validate the `setModelDefault` endpoint's payload. */
export function readModelDefaultInput(payload: unknown): {
  provider: ProviderId
  model: string
  effort?: string
} {
  const provider = readProvider(payload)
  const model = readString(payload, 'model')
  const record = payload as Record<string, unknown>
  let effort: string | undefined
  if (record.effort !== undefined) {
    if (typeof record.effort !== 'string' || record.effort.length === 0) {
      throw new BadRequest(
        'payload.effort must be a non-empty string when present',
      )
    }
    effort = record.effort
  }
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { effort }),
  }
}

/**
 * Validate the optional Claude login method, which no other provider accepts.
 * @throws BadRequest when the method is unknown or named for another provider.
 */
export function readLoginMethod(
  payload: unknown,
  provider: ProviderId,
): LoginMethod | undefined {
  const method = (payload as Record<string, unknown>).method
  if (method === undefined) return undefined
  if (provider !== 'claude')
    throw new BadRequest('payload.method is only valid for claude')
  if (method !== 'oauth' && method !== 'keychain') {
    throw new BadRequest('payload.method must be "oauth" or "keychain"')
  }
  return method
}

/** Validate the `setSpeed` endpoint's tier. */
export function readSpeedTier(payload: unknown): SpeedTier {
  const tier = (payload as Record<string, unknown>).tier
  if (tier !== 'standard' && tier !== 'fast') {
    throw new BadRequest('payload.tier must be "standard" or "fast"')
  }
  return tier
}

/** Validate the `image` endpoint's payload into a full attachment reference. */
export function readImageRef(payload: unknown): ImageAttachmentRef {
  if (typeof payload !== 'object' || payload === null)
    throw new BadRequest('payload must be an object')
  const record = payload as Record<string, unknown>
  const attachmentId = record.attachmentId
  if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
    throw new BadRequest('payload.attachmentId must be a non-empty string')
  }
  const mediaType = record.mediaType
  if (
    typeof mediaType !== 'string' ||
    !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)
  ) {
    throw new BadRequest(
      `payload.mediaType must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`,
    )
  }
  for (const field of ['bytes', 'width', 'height'] as const) {
    const value = record[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new BadRequest(`payload.${field} must be a positive integer`)
    }
  }
  const name = record.name
  if (name !== undefined && typeof name !== 'string') {
    throw new BadRequest('payload.name must be a string when present')
  }
  return {
    attachmentId: AttachmentId(attachmentId),
    mediaType: mediaType as ImageAttachmentRef['mediaType'],
    bytes: record.bytes as number,
    width: record.width as number,
    height: record.height as number,
    ...(name === undefined ? {} : { name: name as string }),
  }
}

/**
 * Validate the `video` endpoint's payload into a bare file name. Rejecting
 * anything with a path separator (the pattern allows none) pins every read
 * inside the plugin's videos directory.
 */
export function readVideoName(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null)
    throw new BadRequest('payload must be an object')
  const name = (payload as Record<string, unknown>).name
  if (typeof name !== 'string' || !VIDEO_NAME_PATTERN.test(name)) {
    throw new BadRequest('payload.name must be a bare .mp4 file name')
  }
  return name
}

/** Validate the usage/model catalog endpoints' optional force flag. */
export function readForce(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const force = (payload as Record<string, unknown>).force
  if (force === undefined) return false
  if (typeof force !== 'boolean')
    throw new BadRequest('payload.force must be a boolean when present')
  return force
}

/** Validate the session id both speed endpoints carry. */
export function readSessionId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null)
    throw new BadRequest('payload must be an object')
  return readString(payload, 'sessionId')
}

/**
 * Read the key route a credential request addresses.
 * @throws BadRequest when the payload names a route this plugin does not serve.
 */
export function readKeyRoute(payload: unknown): KeyRouteId {
  if (typeof payload !== 'object' || payload === null)
    throw new BadRequest('payload must be an object')
  const route = (payload as Record<string, unknown>).route
  if (!isKeyRouteId(route)) {
    throw new BadRequest(
      `payload.route must be one of ${KEY_ROUTE_IDS.join(', ')}`,
    )
  }
  return route
}

/**
 * Read a submitted credential value: trimmed, non-empty, and bounded. The value
 * is a secret, so no refusal message repeats it.
 */
/**
 * Read a credential generation: a non-negative integer the writer quoted from
 * its commit.
 * @param payload - request payload.
 * @returns the generation.
 */
export function readGeneration(payload: unknown): number {
  const value = (payload as Record<string, unknown> | null)?.generation
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new BadRequest('generation must be a non-negative integer')
  return value
}

export function readCredentialValue(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null)
    throw new BadRequest('payload must be an object')
  const raw = (payload as Record<string, unknown>).value
  if (typeof raw !== 'string')
    throw new BadRequest('payload.value must be a string')
  const value = raw.trim()
  if (value.length === 0)
    throw new BadRequest('payload.value must not be blank')
  if (value.length > MAX_CREDENTIAL_LENGTH) {
    throw new BadRequest(
      `payload.value must be at most ${MAX_CREDENTIAL_LENGTH} characters`,
    )
  }
  // A value with a control character cannot ride an authorization header, and
  // letting the transport build one would put the value in its error message.
  if (hasControlCharacters(value))
    throw new BadRequest('payload.value must not carry control characters')
  return value
}

/** Validate the Ollama listing payload's optional base URL override. */
export function readOllamaBaseURL(payload: unknown): string | undefined {
  const raw = readOptionalString(payload, 'baseURL')
  if (raw === undefined) return undefined
  try {
    return validateOllamaBaseURL(raw)
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error))
  }
}
