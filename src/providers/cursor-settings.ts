/**
 * Durable, non-secret Cursor route configuration.
 *
 * The API key itself never appears here; the plugin config names its credential
 * reference. The only stored value is the monthly ceiling a reader can set for
 * an account whose plan does not disclose one (an enterprise seat, for
 * example): the quota bar then shows spend against that ceiling instead of a
 * bare amount.
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Stored Cursor settings; every field is optional. */
export interface CursorSettings {
  /**
   * Monthly ceiling in US dollars. Used only when Cursor's response reports
   * spend without a limit, so a disclosed limit always wins.
   */
  monthlyCeilingUSD?: number
}

/** Upper bound for a ceiling; a larger number is a typo, not a budget. */
export const MAX_CURSOR_CEILING_USD = 1_000_000

function fail(message: string): never {
  throw new Error(message)
}

/**
 * Validate one stored document.
 * @param input - any parsed JSON value.
 * @returns the settings with unknown fields dropped.
 * @throws when the document is not an object or the ceiling is not a positive
 *   finite number of dollars.
 */
export function validateCursorSettings(input: unknown): CursorSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('settings must be an object')
  }
  const record = input as Record<string, unknown>
  const settings: CursorSettings = {}
  if (record.monthlyCeilingUSD !== undefined) {
    const ceiling = record.monthlyCeilingUSD
    if (
      typeof ceiling !== 'number' ||
      !Number.isFinite(ceiling) ||
      ceiling <= 0 ||
      ceiling > MAX_CURSOR_CEILING_USD
    ) {
      fail(
        `monthlyCeilingUSD must be a positive number no larger than ${MAX_CURSOR_CEILING_USD}`,
      )
    }
    settings.monthlyCeilingUSD = ceiling
  }
  return settings
}

/**
 * Cursor settings under the DSH home directory. Writes are serialized and
 * atomic (temp file with mode 0600, then rename), so a crash never leaves a
 * half-written document and a concurrent writer cannot lose an earlier save.
 */
export class CursorSettingsStore {
  private current: CursorSettings = {}
  private writes: Promise<void> = Promise.resolve()
  /** Set when the stored file existed but was unreadable or invalid. */
  private corrupt: string | undefined

  constructor(
    readonly path = dshHomePath(
      'plugins',
      'subscriptions',
      'cursor-settings.json',
    ),
    private readonly onCorrupt?: (message: string) => void,
  ) {
    try {
      this.current = validateCursorSettings(
        JSON.parse(readFileSync(path, 'utf8')) as unknown,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A broken file must not take the whole plugin down: degrade to
        // defaults, keep the file untouched for manual recovery, and let the
        // next save overwrite it.
        this.corrupt = error instanceof Error ? error.message : String(error)
        this.onCorrupt?.(
          `Cursor settings at ${path} are unreadable and ignored; defaults serve until the next save.`,
        )
      }
    }
  }

  /** Why the stored file is ignored, when it is. */
  corruption(): string | undefined {
    return this.corrupt
  }

  get(): CursorSettings {
    return structuredClone(this.current)
  }

  /** The configured ceiling, or undefined to use only what the API reports. */
  ceilingUSD(): number | undefined {
    return this.current.monthlyCeilingUSD
  }

  async set(input: unknown): Promise<void> {
    const validated = validateCursorSettings(input)
    const run = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(validated, null, 2), {
          mode: 0o600,
        })
        await rename(temporary, this.path)
      } finally {
        await rm(temporary, { force: true })
      }
      this.current = validated
      this.corrupt = undefined
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}
