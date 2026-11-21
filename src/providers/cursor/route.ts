/**
 * Route identity for the Cursor provider.
 *
 * The route id is what DSH uses for `provider` in requests and listings, and
 * the credential reference is the default key name the card states.
 */

/** Route id owned by the Cursor adapter. Not a member of the OAuth provider ids. */
export const CURSOR_ROUTE = 'cursor'

/** Default credential reference naming the Cursor API key. */
export const DEFAULT_CURSOR_API_KEY_REF = 'CURSOR_API_KEY'
