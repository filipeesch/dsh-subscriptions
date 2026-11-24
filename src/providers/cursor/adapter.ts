/**
 * The DSH `LlmAdapter` for the `cursor` route.
 *
 * `stream()` converts the request and runs one call on the session's Cursor
 * agent; the catalog comes from Cursor's SDK and is cached. Without a key the
 * route advertises nothing; with a key and an unreachable catalog it offers the
 * built-in list of known models so the route stays selectable.
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  DISCOVERY_TIMEOUT_MS,
  ModelCatalogCache,
  withTimeout,
  type CatalogPersistence,
} from '../common.js'
import {
  FALLBACK_MODELS,
  modelNames,
  type CursorCatalogModel,
} from './catalog.js'
import { cursorCatalogStore } from './catalog-store.js'
import { resolveContextWindow } from './context-window.js'
import { cursorRetryPolicy, describeFailure } from './failure.js'
import { offeredTierValue, reasoningInfo, requestedTier } from './params.js'
import { catalogSignature } from './catalog.js'
import { CURSOR_ROUTE, DEFAULT_CURSOR_API_KEY_REF } from './route.js'
import type { Image } from './prompt.js'
import { ChunkQueue, Reply } from './reply.js'
import {
  CursorRuntime,
  safeError,
  type CursorGateway,
  type CursorRun,
} from './runtime.js'
import { imageRefs, readRequest, type CursorImageRef } from './transcript.js'

const CATALOG_TTL_MS = 10 * 60_000
/** Attachments are immutable, and every request carries the whole history: read each once. */
const IMAGE_CACHE_SIZE = 64

/** What the adapter needs from the plugin host. */
export interface CursorAdapterOptions {
  /** The Cursor SDK seam; tests inject a fake. */
  gateway: CursorGateway
  /** Resolve the API key per request; `undefined` means unconfigured. */
  apiKey: () => Promise<string | undefined>
  /** Working directory for one session's agent. */
  cwd: (sessionId: string | undefined) => string
  /** Capacity the public catalog publishes for one model, when it describes it. */
  publishedWindow?: (modelId: string) => number | undefined
  /** Manual window for one model; settings already won over configuration. */
  manualWindow?: (modelId: string) => number | undefined
  /** The tier Cursor accepted for this model after a rejection, when remembered. */
  acceptedTier?: (modelId: string) => string | undefined
  /** Remember a tier Cursor accepted after a rejection. */
  rememberAcceptedTier?: (modelId: string, value: string) => void
  /**
   * Drop a remembered tier that no longer applies. The expected record, when
   * given, protects a newer concurrent record from a stale withdrawal.
   */
  forgetAcceptedTier?: (modelId: string, expected?: { value: string }) => void
  /** Whether a model appears in the picker; absent means enabled. */
  enabled?: (modelId: string) => boolean
  /** Called with the ids a successful live catalog read listed. */
  onCatalog?: (ids: readonly string[]) => void
  /** Called after new catalog metadata is installed, when it changed. */
  onCatalogApplied?: (models: readonly CursorCatalogModel[]) => void
  /** Read one image attachment's bytes; absent means text-only. */
  readImage?: (
    ref: CursorImageRef,
    signal?: AbortSignal,
  ) => Promise<Image | undefined>
  /** Credential reference the adapter reads, named in diagnostics. */
  keyRef?: string
  /** Diagnostics sink for failures that are not the current request's. */
  onWarn?: (message: string) => void
  /** Prewarm the SDK's per-process setup after a live catalog read. */
  prewarm?: boolean
  /** How long a reserved stream may wait before admission (tests shorten it). */
  reservationTtlMs?: number
  /** Catalog cache lifetime for tests; defaults to ten minutes. */
  catalogTtlMs?: number
  /** Catalog persistence for tests; defaults to the plugin's stored catalog. */
  catalogPersistence?: CatalogPersistence<CursorCatalogModel>
}

export class CursorAdapter extends LlmAdapter {
  private readonly runtime: CursorRuntime
  /** Durable, stale-while-revalidate catalog; a restart seeds it from disk. */
  private readonly catalog: ModelCatalogCache<CursorCatalogModel>
  private readonly images = new Map<string, Image>()
  /** Whether the projected source has been told which ids the catalog lists. */
  private seedNotified = false
  /** Picker-facing metadata the host was last told about. */
  private lastPickerSignature: string | undefined

  constructor(private readonly options: CursorAdapterOptions) {
    super()
    this.runtime = new CursorRuntime({
      gateway: options.gateway,
      apiKey: options.apiKey,
      cwd: options.cwd,
      ...(options.acceptedTier === undefined
        ? {}
        : { acceptedTier: options.acceptedTier }),
      ...(options.rememberAcceptedTier === undefined
        ? {}
        : { rememberAcceptedTier: options.rememberAcceptedTier }),
      ...(options.forgetAcceptedTier === undefined
        ? {}
        : { forgetAcceptedTier: options.forgetAcceptedTier }),
      keyRef: options.keyRef ?? DEFAULT_CURSOR_API_KEY_REF,
      ...(options.reservationTtlMs === undefined
        ? {}
        : { reservationTtlMs: options.reservationTtlMs }),
      ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
    })
    this.catalog = new ModelCatalogCache(
      options.catalogPersistence ?? cursorCatalogStore(),
      options.catalogTtlMs ?? CATALOG_TTL_MS,
    )
  }

  /** Aborts adapter setup too, not only the runtime's turns. */
  private readonly lifetime = new AbortController()

  /** Close every live agent; the plugin calls this from its disposer. */
  dispose(): void {
    this.lifetime.abort()
    this.runtime.dispose()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Cursor' }
  }

  /**
   * The route owns its retry policy because only it knows which failures are
   * safe to replay: {@link cursorRetryPolicy} retries the pre-output code and
   * nothing else.
   */
  override providerRetryPolicy(
    provider: string,
  ): ResolvedRetryPolicy | undefined {
    return provider === CURSOR_ROUTE ? cursorRetryPolicy() : undefined
  }

  override async listModels(
    provider: string,
  ): Promise<readonly LlmModelInfo[]> {
    const models = (await this.models('list')).filter(
      (model) => this.options.enabled?.(model.id) !== false,
    )
    const names = modelNames(models)
    return models.map((model) => ({
      provider,
      id: model.id,
      name: names.get(model.id) ?? model.id,
      inputModalities: this.modalities(),
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    const models = await this.models('resolve')
    const entry = models.find((candidate) => candidate.id === model)
    const info: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: modelNames(models).get(model) ?? model,
      inputModalities: this.modalities(),
      context: { contextWindow: this.windowFor(model, entry).tokens },
      systemPromptUpdate: 'in-history',
    }
    const reasoning = reasoningInfo(entry)
    if (reasoning) {
      info.reasoning = {
        efforts: reasoning.efforts.map((effort) => ({
          id: effort.id as never,
          name: effort.name,
        })),
        ...(reasoning.defaultEffort === undefined
          ? {}
          : { defaultEffort: reasoning.defaultEffort as never }),
      }
    }
    return info
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Reserve the turn's order at call time, before the generator is first
    // iterated: a later call owns the conversation even if an earlier one
    // starts its setup first.
    const reservation = this.lifetime.signal.aborted
      ? undefined
      : this.runtime.reserveTurn(
          options.purpose === undefined && typeof options.sessionId === 'string'
            ? options.sessionId
            : undefined,
        )
    const controller = new AbortController()
    const iterator = this.streamTurn(
      options,
      reservation?.seq ?? this.runtime.beginTurn(),
      controller,
      reservation,
    )
    // A generator's return() queues behind a pending next(), so abort before
    // delegating: closing the stream must stop setup synchronously.
    return {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<StreamChunk>> {
          try {
            const result = await iterator.next()
            // A stream that ends before reaching a turn (or without finishing
            // one) releases its reservation here; the runtime's release is
            // idempotent.
            if (result.done) reservation?.release()
            return result
          } catch (error) {
            reservation?.release()
            throw error
          }
        },
        async return(): Promise<IteratorResult<StreamChunk>> {
          controller.abort()
          reservation?.release()
          void iterator.return?.(undefined).catch(() => {})
          return { done: true, value: undefined }
        },
        async throw(error?: unknown): Promise<IteratorResult<StreamChunk>> {
          controller.abort()
          reservation?.release()
          void iterator.throw?.(error).catch(() => {})
          throw error
        },
      }),
    }
  }

  private async *streamTurn(
    options: GenerateOptions,
    turnSeq: number,
    controller: AbortController,
    reservation: import('./runtime.js').TurnReservation | undefined,
  ): AsyncGenerator<StreamChunk> {
    if (options?.stop?.length) {
      throw new LlmError(
        'Cursor does not support stop sequences',
        'UNSUPPORTED_OPTION',
      )
    }
    // Installed before setup so a cancel, a disposed adapter, or an iterator
    // teardown stops the wait instead of letting discovery finish and start
    // work for a request nobody wants.
    const signal = AbortSignal.any([
      controller.signal,
      this.lifetime.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ])
    // A request the host already cancelled, or one arriving after disposal,
    // must not touch the catalog, the attachment store, or the SDK.
    if (signal.aborted) {
      const cancelled = new ChunkQueue()
      const reply = new Reply(cancelled)
      reply.finish('aborted')
      yield* cancelled
      return
    }
    const cancelled = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted')
      else {
        signal.addEventListener('abort', () => resolve('aborted'), {
          once: true,
        })
      }
    })
    const setup = Promise.all([
      this.models('resolve'),
      this.loadImages(options, signal),
    ])
    let first: Awaited<typeof setup> | 'aborted'
    try {
      first = await Promise.race([setup, cancelled])
    } catch (error) {
      // Setup owns the credential read and the attachment reads, so its
      // rejection is a failed turn like any other and must end in the route's
      // own sentence and one warning instead of an adapter throw. Nothing has
      // been sent yet, so the failure cannot echo the request.
      const queue = new ChunkQueue()
      const reply = new Reply(queue)
      if (signal.aborted) {
        reply.finish('aborted')
      } else {
        const report = describeFailure({
          phase: 'setup',
          errors: [error],
          action: 'run the model',
          beforeOutput: true,
          // No attempt and no recovery ran, so the host has nothing to replay.
          recoverySpent: false,
        })
        this.options.onWarn?.(report.warning)
        reply.finish('error', report.sentence, report.code)
      }
      yield* queue
      return
    }
    if (first === 'aborted') {
      const queue = new ChunkQueue()
      const reply = new Reply(queue)
      reply.finish('aborted')
      yield* queue
      return
    }
    const [models, images] = first
    if (signal.aborted) {
      const queue = new ChunkQueue()
      const reply = new Reply(queue)
      reply.finish('aborted')
      yield* queue
      return
    }
    const transcript = readRequest(options, images)
    const queue = new ChunkQueue()
    const reply = new Reply(queue)
    void this.runtime.runTurn({
      model: {
        id: options.model,
        cursorParameters: models.find((entry) => entry.id === options.model)
          ?.parameters,
      },
      transcript,
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoning: String(options.reasoningEffort) }),
      signal,
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: String(options.sessionId) }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      turnSeq,
      ...(reservation === undefined ? {} : { reservation }),
      reply,
    })
    // The turn resolves the key itself so a missing credential finishes the
    // stream with the host's own error code instead of a rejected adapter call.
    try {
      yield* queue
    } finally {
      controller.abort()
    }
  }

  /**
   * The catalog for display. Awaits the stored seed and falls back to the
   * built-in list, so the manager is never empty while the picker is usable.
   * Never triggers an SDK read.
   */
  async catalogSnapshot(): Promise<readonly CursorCatalogModel[]> {
    if (this.lifetime.signal.aborted) return this.catalog.lastKnown() ?? []
    const apiKey = await this.options.apiKey()
    // A stored catalog is not served without a credential, same as the picker.
    if (!apiKey) return []
    await this.catalog.ready()
    this.publishKnownIds()
    return this.catalog.cached() ?? this.catalog.lastKnown() ?? FALLBACK_MODELS
  }

  /**
   * Reload the catalog now, bypassing the TTL (the model manager's Reload).
   * @returns the models; a disposed adapter or missing key reads as empty.
   * @throws when the SDK read fails, so the caller can state the failure
   *   instead of showing a stale catalog as a successful reload.
   */
  async refreshCatalog(): Promise<readonly CursorCatalogModel[]> {
    if (this.lifetime.signal.aborted) return this.catalog.lastKnown() ?? []
    const apiKey = await this.options.apiKey()
    if (!apiKey) return []
    try {
      const models = await this.catalog.force(() => this.fetchCatalog(apiKey))
      // The cache now holds the new entry; only then is a re-list useful.
      this.catalogApplied(models)
      return models
    } catch (error) {
      this.options.onWarn?.(
        `Cursor catalog failed: ${safeError(error, 'list the models')}`,
      )
      throw error
    }
  }

  /**
   * Revalidate a stored catalog in the background at plugin start: its ids are
   * published to the public projection, and the SDK is consulted even when the
   * stored document is still inside its TTL. A missing key or an absent stored
   * catalog does nothing.
   */
  async revalidateCatalog(): Promise<void> {
    // A background call has no caller to absorb a rejection: the credential
    // read, the seed read, and the SDK read all stay inside this guard.
    try {
      if (this.lifetime.signal.aborted) return
      const apiKey = await this.options.apiKey()
      if (!apiKey) return
      await this.catalog.ready()
      if (this.catalog.lastKnown() === undefined) return
      this.publishKnownIds()
      await this.refreshCatalog()
    } catch (error) {
      this.options.onWarn?.(
        `Cursor catalog revalidation failed: ${safeError(error, 'read the catalog')}`,
      )
    }
  }

  /** One-shot helper used by tests and diagnostics: the run handle is not exposed. */
  private modalities(): ('text' | 'image')[] {
    return this.options.readImage === undefined ? ['text'] : ['text', 'image']
  }

  private windowFor(modelId: string, entry: CursorCatalogModel | undefined) {
    return resolveContextWindow({
      model: entry,
      tier: requestedTier(entry, this.options.acceptedTier?.(modelId)),
      publishedWindow: this.options.publishedWindow?.(modelId),
      manualWindow: this.options.manualWindow?.(modelId),
    })
  }

  private async loadImages(
    options: GenerateOptions,
    signal: AbortSignal,
  ): Promise<Map<string, Image>> {
    const out = new Map<string, Image>()
    const read = this.options.readImage
    if (read === undefined) return out
    await Promise.all(
      imageRefs(options).map(async (ref) => {
        const id = ref.attachmentId
        let image = this.images.get(id)
        if (!image) {
          try {
            image = await read(ref, signal)
          } catch {
            // The attachment is optional, so the request continues without it.
            // The thrown message stays out of the log: it comes from the same
            // untrusted surface the failure vocabulary exists to contain.
            this.options.onWarn?.(
              'Cursor could not read an attached image; the request continues without it.',
            )
          }
          if (image) {
            this.images.set(id, image)
            if (this.images.size > IMAGE_CACHE_SIZE) {
              const oldest = this.images.keys().next().value
              if (oldest !== undefined) this.images.delete(oldest)
            }
          }
        }
        if (image) out.set(id, image)
      }),
    )
    return out
  }

  /**
   * The catalog for one call. A list read waits for freshness; a request read
   * serves the last known catalog while a stale entry refreshes in the
   * background, so a turn never waits on the catalog network.
   * @param mode - `list` for the picker, `resolve` for a request or resolution.
   * @returns the models to serve.
   */
  private async models(
    mode: 'list' | 'resolve',
  ): Promise<readonly CursorCatalogModel[]> {
    // A disposed adapter must not wait on discovery or read a credential.
    if (this.lifetime.signal.aborted) return this.catalog.lastKnown() ?? []
    const apiKey = await this.options.apiKey()
    // No key means logged out: advertise nothing so the picker hides the route.
    if (!apiKey) return []
    await this.catalog.ready()
    this.publishKnownIds()
    const fetcher = () => this.fetchCatalog(apiKey)
    const pending =
      mode === 'resolve'
        ? this.catalog
            .resolve(fetcher, (models) => this.catalogApplied(models))
            .then((models) => models ?? FALLBACK_MODELS)
        : this.listFromCatalog(fetcher)
    // Disposal settles a pending read instead of waiting for the network; the
    // fetch itself finishes in the background and only writes memory.
    const listener = new AbortController()
    const aborted = new Promise<'aborted'>((resolve) => {
      if (this.lifetime.signal.aborted) {
        resolve('aborted')
        return
      }
      this.lifetime.signal.addEventListener('abort', () => resolve('aborted'), {
        once: true,
        signal: listener.signal,
      })
    })
    try {
      const result = await Promise.race([pending, aborted])
      return result === 'aborted' ? (this.catalog.lastKnown() ?? []) : result
    } finally {
      listener.abort()
    }
  }

  /**
   * Tell the public projection which ids the stored seed lists, once. Without
   * this a restart could project nothing until the first live read succeeds.
   */
  private publishKnownIds(): void {
    if (this.seedNotified) return
    const known = this.catalog.lastKnown()
    if (known === undefined || known.length === 0) return
    this.seedNotified = true
    this.lastPickerSignature ??= catalogSignature(known)
    this.options.onCatalog?.(known.map((model) => model.id))
  }

  /** Notify the picker after a new catalog entry is installed, if it changed. */
  private catalogApplied(models: readonly CursorCatalogModel[]): void {
    const signature = catalogSignature(models)
    if (signature === this.lastPickerSignature) return
    this.lastPickerSignature = signature
    this.options.onCatalogApplied?.(models)
  }

  /**
   * The picker read. A fresh cache answers directly; a stale or seeded catalog
   * answers immediately while the refresh runs, so a restart lists the stored
   * models before the live read completes. Only a cold cache waits for the
   * read, and a failed one falls back to the built-in list.
   */
  private async listFromCatalog(
    fetcher: () => Promise<CursorCatalogModel[]>,
  ): Promise<readonly CursorCatalogModel[]> {
    await this.catalog.ready()
    const fresh = this.catalog.cached()
    if (fresh !== undefined) return fresh
    const known = this.catalog.lastKnown()
    if (known !== undefined) {
      // The refresh outcome serves the next read; the failure is a diagnostic.
      void this.catalog
        .force(fetcher)
        .then((models) => this.catalogApplied(models))
        .catch((error: unknown) => {
          this.options.onWarn?.(
            `Cursor catalog failed: ${safeError(error, 'list the models')}`,
          )
        })
      return known
    }
    try {
      const models = await this.catalog.get(fetcher)
      this.catalogApplied(models)
      return [...models]
    } catch (error) {
      this.options.onWarn?.(
        `Cursor catalog failed: ${safeError(error, 'list the models')}`,
      )
      return FALLBACK_MODELS
    }
  }

  /**
   * Read the live catalog and pay the one-time warmup.
   * @param apiKey - the resolved credential.
   * @returns the models the catalog reported.
   * @throws when the adapter was disposed, the read timed out, or the catalog
   *   reported no models (an empty read must not replace a known catalog).
   */
  private async fetchCatalog(apiKey: string): Promise<CursorCatalogModel[]> {
    this.lifetime.signal.throwIfAborted()
    const discovered = await withTimeout(
      () => this.options.gateway.listModels({ apiKey }),
      DISCOVERY_TIMEOUT_MS,
    )
    this.lifetime.signal.throwIfAborted()
    if (discovered === undefined || discovered.length === 0) {
      throw new Error('the catalog read returned no models')
    }
    if (this.options.prewarm !== false) {
      const modelId =
        discovered.find((model) => model.id === 'default')?.id ??
        discovered[0].id
      this.runtime.prewarm(apiKey, modelId)
    }
    // Every live read tells the public projection which ids it may target.
    this.seedNotified = true
    this.options.onCatalog?.(discovered.map((model) => model.id))
    // A tier the catalog no longer offers is forgotten now, not only on the
    // model's next turn: otherwise a withdrawal followed by a reappearance
    // could make stale acceptance effective again without a turn in between.
    this.pruneWithdrawnTiers(discovered)
    return discovered
  }

  /** Forget remembered tiers whose model no longer offers that value. */
  private pruneWithdrawnTiers(models: readonly CursorCatalogModel[]): void {
    for (const model of models) {
      const remembered = this.options.acceptedTier?.(model.id)
      if (remembered === undefined) continue
      if (offeredTierValue(model, remembered) !== undefined) continue
      this.options.forgetAcceptedTier?.(model.id, { value: remembered })
    }
  }
}

export { CURSOR_ROUTE }
export type { CursorRun }
