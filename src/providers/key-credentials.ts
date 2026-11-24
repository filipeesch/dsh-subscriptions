/**
 * The credential surface of this plugin's key-based routes.
 *
 * A key route authenticates by a credential *reference*, and the seam resolves
 * that reference from the DSH store first and from the environment second. This
 * module is the write side the Settings cards need: describe where the value
 * comes from, store a replacement, and remove the stored copy — addressed by
 * route, never by a free-form reference, and never returning the value.
 *
 * Only an operator-controlled reference is editable here. A route whose
 * reference is settable from the browser (Ollama Cloud stores `apiKeyRef` in a
 * card-editable document) would otherwise turn this surface into a writer for
 * any reference the host knows, so such a route is refused and the card states
 * why.
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialDigest } from './credential-text.js'
import type {
  CredentialProvider,
  CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import { CURSOR_ROUTE } from './cursor/route.js'
import { OLLAMA_CLOUD_ROUTE } from './ollama.js'

/** Route ids whose credential the Settings cards may read and write. */
export const KEY_ROUTE_IDS = [CURSOR_ROUTE, OLLAMA_CLOUD_ROUTE] as const

/** One key-based route of this plugin. */
export type KeyRouteId = (typeof KEY_ROUTE_IDS)[number]

/**
 * Whether a raw value names one of the served key routes.
 * @param value - candidate route id from a request payload.
 * @returns true when the route is served by this plugin.
 */
export function isKeyRouteId(value: unknown): value is KeyRouteId {
  return KEY_ROUTE_IDS.some((route) => route === value)
}

/** Where a route's key comes from, as the card states it. Never the value. */
export interface KeyCredentialView {
  route: KeyRouteId
  /** The reference the route reads, already resolved from its configuration. */
  keyRef: string
  configured: boolean
  /** Source layer supplying the value: `file`, `env`, `project-env`, or `user-env`. */
  source?: string
  /** Whether the active provider can write this reference. */
  writable: boolean
  /** Host-generated masked preview; absent on hosts that do not produce one. */
  masked?: string
}

/**
 * The outcome of a write or a removal.
 *
 * `committed` says the store write landed; `view` is the state read back after
 * it. A committed write whose state could not be read reports `readError`
 * instead of failing the operation, because reporting a failed save for a saved
 * key invites a second write and a false diagnosis.
 */
export interface KeyCredentialResult {
  committed: boolean
  view?: KeyCredentialView
  /** The state could not be read after the write; the write itself landed. */
  readError?: string
  /**
   * Opaque, host-side generation of the route's stored credential at commit
   * time. A validation quotes it so it can be told whether the credential it
   * read is still the one the writer stored.
   */
  generation: number
}

/** How a validation of one committed credential ended. */
export type KeyValidationOutcome = 'valid' | 'invalid' | 'superseded'

/** The outcome of validating a committed credential. */
export interface KeyValidationResult {
  outcome: KeyValidationOutcome
}

/** The seam methods this surface needs. */
export type KeyCredentialSeam = Pick<
  CredentialProvider,
  'describe' | 'set' | 'unset'
>

/**
 * What `describe` answers. The masked preview is absent from the seam's type on
 * the oldest supported DSH line, so the field is declared here and used only
 * when the host supplies it.
 */
interface CredentialInfoLike {
  configured: boolean
  source?: string
  writable: boolean
  masked?: string
}

/** A refusal the card states verbatim. Never carries a credential or a name. */
export class KeyCredentialError extends Error {}

/**
 * Read and write the key of one served route.
 *
 * The seam is resolved per call rather than held: the RPC is assembled before
 * the credentials service necessarily exists, and a host without one answers a
 * clear refusal instead of a crash at boot. The reference is snapshotted once
 * per operation, so a write and the state read back describe the same
 * reference even when a settings save renames it mid-flight.
 */
export class KeyCredentials {
  constructor(
    private readonly options: {
      /**
       * The route's reference when it is operator-controlled, or `undefined`
       * when the route reads a reference the browser can rename.
       */
      editableRefOf: (route: KeyRouteId) => string | undefined
      /** The credential seam, resolved when a call runs. */
      seam: () => KeyCredentialSeam | undefined
      /**
       * Called after a write or a removal commits, so the routes' derived state
       * (a cached usage reading, the picker's catalog) can follow the change.
       */
      onChanged?: (route: KeyRouteId) => void
      /**
       * The route's own read, run by the host after a commit to prove the stored
       * credential. It takes no argument: the host resolves the committed value
       * itself, so a caller cannot point the read at another key.
       */
      validators?: Partial<
        Record<KeyRouteId, (value: string | undefined) => Promise<void>>
      >
      /**
       * Read the value behind a reference, so a validation can prove the
       * credential it is about to read is the one the writer committed. It is
       * host-only: the value never crosses the RPC.
       */
      resolveValue?: (ref: string) => Promise<string | undefined>
    },
  ) {}

  /** Per-route commit counter behind {@link validate}. */
  private readonly generations = new Map<KeyRouteId, number>()
  /**
   * The credential each generation committed: its reference and a host-only
   * fingerprint of the value. A Settings save can move the reference without
   * writing the credential, so the counter alone does not say which credential a
   * generation names.
   */
  private readonly committed = new Map<
    KeyRouteId,
    { generation: number; ref: string; fingerprint: string | undefined }
  >()

  /**
   * The route's current credential generation.
   * @param route - served route id.
   * @returns the count of commits this process has made for the route.
   */
  generationOf(route: KeyRouteId): number {
    return this.generations.get(route) ?? 0
  }

  /**
   * Validate the credential a writer committed, refusing to answer for one that
   * another change has replaced meanwhile.
   * @param route - served route id.
   * @param generation - the generation the writer quoted from its commit.
   * @returns whether the credential works, does not, or was superseded.
   */
  async validate(
    route: KeyRouteId,
    generation: number,
  ): Promise<KeyValidationResult> {
    const committed = this.committed.get(route)
    if (
      this.generationOf(route) !== generation ||
      committed === undefined ||
      committed.generation !== generation
    )
      return { outcome: 'superseded' }
    // Resolve the committed credential once, and hand the provider read this
    // exact value: a read that resolves live state could authenticate another
    // key while the identity checks pass.
    const snapshot = await this.resolveCommitted(route, committed)
    if (snapshot === undefined) return { outcome: 'superseded' }
    const validator = this.options.validators?.[route]
    if (validator === undefined) {
      return {
        outcome: this.stillCommitted(route, committed) ? 'valid' : 'superseded',
      }
    }
    try {
      // The host reads the credential itself, under the route's destination
      // policy: a caller-supplied value could validate a key it never stored.
      await validator(snapshot.value)
    } catch {
      // A route's own error text never reaches the browser, and a change that
      // landed during the read owns the outcome.
      return {
        outcome: (await this.sameCredential(route, committed))
          ? 'invalid'
          : 'superseded',
      }
    }
    return {
      outcome: (await this.sameCredential(route, committed))
        ? 'valid'
        : 'superseded',
    }
  }

  /** A synchronous identity check: the generation still names this commit. */
  private stillCommitted(
    route: KeyRouteId,
    committed: { generation: number; ref: string },
  ): boolean {
    return (
      this.generationOf(route) === committed.generation &&
      this.options.editableRefOf(route) === committed.ref
    )
  }

  /**
   * Resolve and verify the committed credential: the reference reads the same
   * name and the value's digest matches the commit.
   * @returns the verified value, or undefined when the identity moved.
   */
  private async resolveCommitted(
    route: KeyRouteId,
    committed: {
      generation: number
      ref: string
      fingerprint: string | undefined
    },
  ): Promise<{ value: string | undefined } | undefined> {
    if (!this.stillCommitted(route, committed)) return undefined
    if (this.options.resolveValue === undefined) return { value: undefined }
    let value: string | undefined
    try {
      value = await this.options.resolveValue(committed.ref)
    } catch {
      return undefined
    }
    // The identity is re-checked after the await, before the value is used.
    if (!this.stillCommitted(route, committed)) return undefined
    const digest = value === undefined ? undefined : credentialDigest(value)
    if (digest !== committed.fingerprint) return undefined
    return { value }
  }

  /** Whether the route still reads the credential a generation committed. */
  private async sameCredential(
    route: KeyRouteId,
    committed: {
      generation: number
      ref: string
      fingerprint: string | undefined
    },
  ): Promise<boolean> {
    if (!this.stillCommitted(route, committed)) return false
    if (this.options.resolveValue === undefined) return true
    let value: string | undefined
    try {
      value = await this.options.resolveValue(committed.ref)
    } catch {
      return false
    }
    // Another writer can replace the value without a generation bump only from
    // outside this service; the digest comparison catches that, and the
    // generation is re-read after the await either way.
    if (!this.stillCommitted(route, committed)) return false
    return (
      (value === undefined ? undefined : credentialDigest(value)) ===
      committed.fingerprint
    )
  }

  /** Record what a commit stored, so a later validation can name it. */
  private commit(
    route: KeyRouteId,
    generation: number,
    ref: string,
    fingerprint: string | undefined,
  ): void {
    this.committed.set(route, { generation, ref, fingerprint })
  }

  /**
   * Presence, origin, and writability of one route's key.
   * @param route - served route id.
   * @returns the view the card renders.
   * @throws KeyCredentialError when the reference is not operator-controlled,
   *   no credential provider is mounted, or the reference is malformed.
   */
  async describe(route: KeyRouteId): Promise<KeyCredentialView> {
    const ref = this.ref(route)
    return await this.view(route, ref)
  }

  /**
   * Store a value under the route's effective reference. The stored value wins
   * over an environment fallback until it is cleared.
   * @param route - served route id.
   * @param value - the non-empty secret.
   * @returns the committed write and the state read back after it.
   */
  async set(route: KeyRouteId, value: string): Promise<KeyCredentialResult> {
    const ref = this.ref(route)
    // The provider is resolved before the guarded write, so a host with no seam
    // keeps its own refusal instead of the write's generic sentence.
    const seam = this.provider('set')
    await this.mutate('store', () => seam.set(ref, value))
    const generation = this.bump(route)
    this.commit(route, generation, String(ref), credentialDigest(value))
    this.notify(route)
    return await this.readBack('store', route, ref, generation)
  }

  /**
   * Remove the DSH copy of the route's key. An environment source may still
   * supply the reference afterwards, which the state read back states.
   * @param route - served route id.
   * @returns the committed removal and the state read back after it.
   */
  async clear(route: KeyRouteId): Promise<KeyCredentialResult> {
    const ref = this.ref(route)
    const seam = this.provider('unset')
    await this.mutate('remove', () => seam.unset(ref))
    const generation = this.bump(route)
    // Publish the invalidation now: the previous credential is gone, and a save
    // that lands while the fallback is being read owns the route from here on.
    this.commit(route, generation, String(ref), undefined)
    // After a removal the effective value may be an environment fallback, so the
    // identity is read again — but only while this clear is still the latest.
    const remaining = await this.options
      .resolveValue?.(String(ref))
      .catch(() => undefined)
    if (this.generationOf(route) === generation) {
      this.commit(
        route,
        generation,
        String(ref),
        remaining === undefined ? undefined : credentialDigest(remaining),
      )
    }
    this.notify(route)
    return await this.readBack('remove', route, ref, generation)
  }

  /** One route's state under the reference the operation snapshotted. */
  private async view(
    route: KeyRouteId,
    ref: CredentialRef,
  ): Promise<KeyCredentialView> {
    // The provider is resolved before the guarded read, so a host that mounts
    // no seam keeps its own refusal instead of the read's generic sentence.
    const seam = this.provider('describe')
    let info: CredentialInfoLike
    try {
      info = (await seam.describe(ref)) as CredentialInfoLike
    } catch {
      throw new KeyCredentialError('the host could not read the credential')
    }
    return {
      route,
      keyRef: String(ref),
      configured: info.configured,
      ...(info.source === undefined ? {} : { source: info.source }),
      writable: info.writable,
      ...(info.masked === undefined ? {} : { masked: info.masked }),
    }
  }

  /** Read the state back after a committed write, reporting a read failure. */
  private async readBack(
    action: 'store' | 'remove',
    route: KeyRouteId,
    ref: CredentialRef,
    generation: number,
  ): Promise<KeyCredentialResult> {
    try {
      return { committed: true, view: await this.view(route, ref), generation }
    } catch {
      return {
        committed: true,
        generation,
        readError: `the key was ${
          action === 'store' ? 'saved' : 'removed'
        }, but the credential state could not be read`,
      }
    }
  }

  /** Record a commit and return its generation. */
  private bump(route: KeyRouteId): number {
    const next = this.generationOf(route) + 1
    this.generations.set(route, next)
    return next
  }

  /**
   * Announce a committed change. The notification is best-effort: it refreshes
   * derived state, and a failure there must not reject a write that landed.
   */
  private notify(route: KeyRouteId): void {
    try {
      this.options.onChanged?.(route)
    } catch {
      // Nothing to report: the write committed, and the next read refreshes the
      // derived state anyway.
    }
  }

  /** Run one seam mutation, mapping every failure to a fixed sentence. */
  private async mutate(
    action: 'store' | 'remove',
    write: () => Promise<void>,
  ): Promise<void> {
    try {
      await write()
    } catch {
      throw new KeyCredentialError(
        action === 'store'
          ? 'the host refused to store the key'
          : 'the host refused to remove the key',
      )
    }
  }

  /**
   * The branded reference of one operator-controlled route. The refusal never
   * repeats the configured name: a name can be a value someone pasted there.
   */
  private ref(route: KeyRouteId): CredentialRef {
    const name = this.options.editableRefOf(route)
    if (name === undefined)
      throw new KeyCredentialError(
        `the ${route} route reads a credential reference this card can rename; only the operator-configured reference can be read or written here`,
      )
    try {
      return credentialRef(name)
    } catch {
      throw new KeyCredentialError(
        `the ${route} route's credential reference is not a valid reference name`,
      )
    }
  }

  /**
   * The mounted credential seam, checked for the one method this operation
   * needs: an older host may answer the read half without the write half, and
   * the refusal must name what is missing rather than crash on the call.
   */
  private provider(method: 'describe' | 'set' | 'unset'): KeyCredentialSeam {
    const seam = this.options.seam()
    if (seam === undefined || typeof seam[method] !== 'function')
      throw new KeyCredentialError(
        'this host mounted no credential provider, so the key cannot be read or written',
      )
    return seam
  }
}
