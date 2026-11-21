/**
 * The account-scoped model id the picker uses for one account's independent
 * entry: `~account:<account>:<model>`, both segments URI-encoded.
 *
 * Pure string handling in its own module so the browser half can read the
 * account out of a selection without importing the node-side adapter stack.
 */

/** Prefix that marks an account-scoped model id. */
export const ACCOUNT_MODEL_PREFIX = '~account:'

/** Build the account-scoped id of one account's model. */
export function accountModelId(account: string, model: string): string {
  return `${ACCOUNT_MODEL_PREFIX}${encodeURIComponent(account)}:${encodeURIComponent(model)}`
}

/**
 * Read an account-scoped id. Returns undefined for an ordinary model id, and
 * also for a malformed one, so a caller that only wants the account can fall
 * back to the default.
 */
export function readAccountModelId(
  id: string,
): { account: string; model: string } | undefined {
  if (!id.startsWith(ACCOUNT_MODEL_PREFIX)) return undefined
  const parts = id.slice(ACCOUNT_MODEL_PREFIX.length).split(':')
  try {
    if (parts.length !== 2) throw new Error()
    const account = decodeURIComponent(parts[0])
    const model = decodeURIComponent(parts[1])
    if (!account || !model || accountModelId(account, model) !== id) {
      throw new Error()
    }
    return { account, model }
  } catch {
    return undefined
  }
}
