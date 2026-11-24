/**
 * Shared helpers for the credential values this plugin handles: whether one can
 * ride a header, and a host-only identity for one.
 */

import { createHmac, randomBytes } from 'node:crypto'

/**
 * Whether a credential value cannot ride an authorization header.
 *
 * A control character makes the header invalid, and the transport's error for an
 * invalid header quotes the header — which would put the credential in a reply.
 * The value is refused before any header is built instead.
 * @param value - stored or submitted secret.
 * @returns true when the value carries a control character.
 */
export function hasControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Process-local key. Regenerated on every boot, so a digest cannot be compared
 * across processes or matched against a precomputed table.
 */
const DIGEST_KEY = randomBytes(32)

/**
 * A host-only identity for a credential value: a keyed digest that a validation
 * uses to prove the credential it reads is the one a commit stored.
 *
 * Equal digests mean equal values within this process. The digest is not an
 * exportable identity and reveals nothing about the value without the process
 * key, which never leaves memory; it is a discriminator, not a password hash.
 * @param value - the credential value.
 * @returns the digest, safe to keep in host memory.
 */
export function credentialDigest(value: string): string {
  return createHmac('sha256', DIGEST_KEY).update(value).digest('base64url')
}
