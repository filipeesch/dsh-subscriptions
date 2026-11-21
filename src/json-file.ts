/**
 * Serialized, atomic JSON documents for the plugin's own state.
 *
 * Every store in this package writes the same way: a temporary file beside the
 * target, then a rename. Windows refuses to replace a file another handle holds
 * open without FILE_SHARE_DELETE (an indexer, antivirus scan, or a second dsh
 * profile reading the same file), surfacing as a transient EPERM/EBUSY/EACCES
 * on rename. On POSIX those codes are real failures, so only win32 retries.
 *
 * {@link writeJsonFile} makes one write atomic; it is not serialized. A store
 * that sequences several mutations of one document calls it through
 * {@link serializeWrites}, which provides the in-process call order. A failure
 * rejects its caller without blocking later writes. Separate processes (or
 * filesystem aliases of a path) are not locked and remain last-writer-wins.
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseJsonText } from './json-text.js'

/** What reading one document found. */
export type JsonFileRead =
  | { kind: 'missing' }
  | { kind: 'invalid'; error: unknown }
  | { kind: 'value'; value: unknown }

/** How a write formats and protects the file. */
export interface JsonFileWriteOptions {
  /** File mode; omitted leaves the platform default. */
  mode?: number
  /** JSON indentation; defaults to two spaces. */
  space?: number
}

/** Rename codes Windows raises transiently when the target is held open. */
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EBUSY',
  'EACCES',
])

/** Retries after the first attempt. */
const RENAME_RETRIES = 5

/** Base delay between attempts; it grows with each attempt. */
const RENAME_RETRY_DELAY_MS = 20

/** What {@link renameWithRetry} may substitute for tests. */
export interface RenameRetryOptions {
  /** Platform deciding whether a failure is retryable; defaults to this one. */
  platform?: NodeJS.Platform
  /** Rename implementation; defaults to the fs rename. */
  attemptRename?: (from: string, to: string) => Promise<void>
  /** Base backoff; defaults to 20 ms. */
  delayMs?: number
}

/**
 * Rename, retrying the Windows share-mode conflicts briefly.
 * @param from - temporary file.
 * @param to - final path.
 * @param options - platform, implementation, and backoff overrides for tests.
 * @returns nothing after a successful rename.
 * @throws the rename failure once a non-win32 platform or the retry budget
 *   leaves no attempt, or any code outside the retryable set.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform
  const attempt = options.attemptRename ?? rename
  const baseDelay = options.delayMs ?? RENAME_RETRY_DELAY_MS
  for (let index = 0; ; index += 1) {
    try {
      await attempt(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        platform !== 'win32' ||
        index >= RENAME_RETRIES ||
        code === undefined ||
        !RENAME_RETRY_CODES.has(code)
      ) {
        throw error
      }
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, baseDelay * (index + 1)),
      )
    }
  }
}

/** Read one document synchronously. A missing file is not an error. */
export function loadJsonFileSync(path: string): JsonFileRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'invalid', error }
  }
  try {
    return { kind: 'value', value: parseJsonText(text) }
  } catch (error) {
    return { kind: 'invalid', error }
  }
}

/** Read one document asynchronously. A missing file is not an error. */
export async function loadJsonFile(path: string): Promise<JsonFileRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'invalid', error }
  }
  try {
    return { kind: 'value', value: parseJsonText(text) }
  } catch (error) {
    return { kind: 'invalid', error }
  }
}

/**
 * Write one document atomically: the target sees the previous complete file or
 * the new complete file, never a partial one.
 * @param path - final path; its directory is created when needed.
 * @param value - the document to serialize.
 * @param options - mode and indentation.
 * @returns nothing after the rename.
 * @throws the write or rename failure after removing the temporary file.
 */
export async function writeJsonFile(
  path: string,
  value: unknown,
  options: JsonFileWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  const data = JSON.stringify(value, null, options.space ?? 2)
  try {
    await writeFile(
      temporary,
      data,
      options.mode === undefined
        ? { encoding: 'utf8' }
        : { encoding: 'utf8', mode: options.mode },
    )
    await renameWithRetry(temporary, path)
  } finally {
    // The original write/rename failure must stay the one the caller sees.
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** One serialized chain per resolved path. */
const writeChains = new Map<string, Promise<unknown>>()

/**
 * Run one mutation of a document after the previous mutation at that path.
 * @param path - the document path the chain belongs to.
 * @param action - the read-modify-write to run.
 * @returns the action's value; its failure does not block later mutations.
 */
export async function serializeWrites<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = resolve(path)
  const previous = writeChains.get(key) ?? Promise.resolve()
  const next = previous.then(action, action)
  const tail = next.then(
    () => undefined,
    () => undefined,
  )
  writeChains.set(key, tail)
  try {
    return await next
  } finally {
    if (writeChains.get(key) === tail) writeChains.delete(key)
  }
}
