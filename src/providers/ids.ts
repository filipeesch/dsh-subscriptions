/**
 * Provider routes the OAuth account machinery can serve.
 *
 * One source for the server (the auth store, the RPC surface, the settings
 * store) and the browser (the section and badge unions), because the two
 * halves must agree on the exact set and order of routes. Pure data: the
 * client bundle imports it too, so it must not reach for Node APIs.
 */

/** Every OAuth provider route, in display order. */
export const PROVIDER_IDS = [
  'codex',
  'claude',
  'grok',
  'copilot',
  'antigravity',
] as const

/** One OAuth provider route this plugin can serve. */
export type ProviderId = (typeof PROVIDER_IDS)[number]
