/**
 * The real Cursor gateway: the only module that imports `@cursor/sdk`.
 *
 * The SDK is loaded on first use so the plugin's entry and the test suite never
 * pay for it — tests inject a fake `CursorGateway` instead. The SDK's bundled
 * ripgrep binary is not on the host's PATH, so the platform package's path is
 * resolved here before the first agent is created.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { CursorCatalogModel } from './catalog.js'
import type {
  CursorAgent,
  CursorAgentOptions,
  CursorGateway,
} from './runtime.js'

const require = createRequire(import.meta.url)
/** Warn once per process when the SDK's ripgrep cannot be located. */
let warned = false

/**
 * Point the SDK at its bundled ripgrep. The SDK scans the working directory
 * with it and expects the host to say where it is.
 * @param env - environment to read and update; defaults to `process.env`.
 * @returns the path when one resolves.
 */
export function configureRipgrep(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // A path inherited from an earlier install may no longer exist.
  const explicit = env.CURSOR_RIPGREP_PATH?.trim()
  if (explicit && existsSync(explicit)) return explicit
  const platform = `${process.platform}-${process.arch}`
  const binaries =
    process.platform === 'win32' ? ['bin/rg.exe', 'bin/rg'] : ['bin/rg']
  // The platform package is a dependency of the SDK, so resolve it from the
  // SDK's own install first: a pnpm layout may not expose it to this package.
  const scopes: NodeJS.Require[] = []
  try {
    scopes.push(createRequire(require.resolve('@cursor/sdk')))
  } catch {
    /* the SDK is optional for tests that never load it */
  }
  scopes.push(require)
  for (const scope of scopes) {
    for (const binary of binaries) {
      try {
        const path = scope.resolve(`@cursor/sdk-${platform}/${binary}`)
        if (existsSync(path)) return (env.CURSOR_RIPGREP_PATH = path)
      } catch {
        /* optional platform package not installed for this scope */
      }
    }
  }
  if (!warned) {
    warned = true
    process.emitWarning(
      'Cursor could not find its bundled ripgrep binary. Set CURSOR_RIPGREP_PATH to a ripgrep executable, or reinstall @cursor/sdk with its platform package.',
      'CursorSdkWarning',
    )
  }
  return undefined
}

/** The gateway the adapter uses in production. */
export function createCursorGateway(): CursorGateway {
  return {
    async createAgent(options) {
      const { Agent } = await import('@cursor/sdk')
      configureRipgrep()
      return (await Agent.create(options as never)) as unknown as CursorAgent
    },
    async deleteAgent(agentId, options) {
      const { Agent } = await import('@cursor/sdk')
      await Agent.delete(agentId, options as never)
    },
    async listModels({ apiKey }) {
      const { Cursor } = await import('@cursor/sdk')
      return (await Cursor.models.list({
        apiKey,
      })) as unknown as CursorCatalogModel[]
    },
  }
}

export type { CursorAgentOptions }
