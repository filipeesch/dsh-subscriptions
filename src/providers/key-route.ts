/**
 * Registration for key-based routes: model providers that authenticate with a
 * DSH credential reference instead of an OAuth session (`ollama-cloud`,
 * `cursor`). They sit outside the account machinery on purpose: the auth store
 * keeps refreshable sessions, and a permanent key stored as one would run
 * through token refresh, pool selection, and multi-account UI that assume an
 * expiring token.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  AdapterRegistrationHandle,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'

/** Resolve one credential by reference name; `undefined` means unconfigured. */
export type CredentialResolver = (
  name: string,
) => Promise<{ value: string } | undefined>

/**
 * Build the resolver both key routes read credentials through, so a Settings
 * save that changes a reference reaches chat and usage with the same lookup.
 * @param ctx - a Context with the `credentials` service injected.
 * @returns the resolver, safe to keep for the route's lifetime.
 */
export function createCredentialResolver(ctx: Context): CredentialResolver {
  return (name) => ctx.credentials.resolve(credentialRef(name))
}

/**
 * Register one key-based route and keep its handle so a settings change can
 * re-announce it (`replace` fires the host's model-catalog update).
 * @param ctx - a Context with the `llm` service injected.
 * @param route - the route id the adapter serves.
 * @param adapter - the adapter to register under that route.
 * @returns the registration handle.
 */
export function registerKeyRoute(
  ctx: Pick<Context, 'llm'>,
  route: string,
  adapter: LlmAdapter,
): AdapterRegistrationHandle {
  return ctx.llm.registerAdapter([route], adapter)
}
