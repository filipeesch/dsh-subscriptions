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
import type { CursorCatalogModel } from './models.js'
import type {
  CursorAgent,
  CursorAgentOptions,
  CursorGateway,
} from './runtime.js'

const require = createRequire(import.meta.url)

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
  for (const binary of binaries) {
    try {
      const path = require.resolve(`@cursor/sdk-${platform}/${binary}`)
      if (existsSync(path)) return (env.CURSOR_RIPGREP_PATH = path)
    } catch {
      /* optional platform package not installed */
    }
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
