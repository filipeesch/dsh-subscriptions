/**
 * The DSH `LlmAdapter` for the `cursor` route.
 *
 * `stream()` converts the request and runs one call on the session's Cursor
 * agent; the catalog comes from Cursor's SDK and is cached. Without a key the
 * route advertises nothing; with a key and an unreachable catalog it offers the
 * built-in list of known models so the route stays selectable.
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { withTimeout, DISCOVERY_TIMEOUT_MS } from '../common.js'
import {
  CURSOR_ROUTE,
  DEFAULT_CURSOR_API_KEY_REF,
  DEFAULT_CURSOR_CONTEXT,
  FALLBACK_MODELS,
  contextWindowFor,
  modelNames,
  reasoningInfo,
  type CursorCatalogModel,
} from './models.js'
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
const CATALOG_RETRY_MS = 60_000
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
  /** Live context tier preference (default `max`). */
  contextPreference?: () => string
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
}

export class CursorAdapter extends LlmAdapter {
  private readonly runtime: CursorRuntime
  private catalog:
    { models: CursorCatalogModel[]; live: boolean; at: number } | undefined
  private loading: Promise<CursorCatalogModel[]> | undefined
  private loadToken: object | undefined
  private readonly images = new Map<string, Image>()

  constructor(private readonly options: CursorAdapterOptions) {
    super()
    this.runtime = new CursorRuntime({
      gateway: options.gateway,
      apiKey: options.apiKey,
      cwd: options.cwd,
      contextPreference: () =>
        options.contextPreference?.() ?? DEFAULT_CURSOR_CONTEXT,
      keyRef: options.keyRef ?? DEFAULT_CURSOR_API_KEY_REF,
      ...(options.reservationTtlMs === undefined
        ? {}
        : { reservationTtlMs: options.reservationTtlMs }),
      ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
    })
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

  override async listModels(
    provider: string,
  ): Promise<readonly LlmModelInfo[]> {
    const models = await this.models()
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
    const models = await this.models()
    const entry = models.find((candidate) => candidate.id === model)
    const info: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: modelNames(models).get(model) ?? model,
      inputModalities: this.modalities(),
      context: { contextWindow: this.contextWindow(entry) },
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
    const setup = Promise.all([this.models(), this.loadImages(options, signal)])
    const first = await Promise.race([setup, cancelled])
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

  /** The catalog size when one is already loaded; never triggers an SDK read. */
  cachedModelCount(): number | undefined {
    return this.catalog?.models.length
  }

  /** One-shot helper used by tests and diagnostics: the run handle is not exposed. */
  private modalities(): ('text' | 'image')[] {
    return this.options.readImage === undefined ? ['text'] : ['text', 'image']
  }

  private contextWindow(entry: CursorCatalogModel | undefined): number {
    return contextWindowFor(
      entry,
      this.options.contextPreference?.() ?? DEFAULT_CURSOR_CONTEXT,
    )
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
          } catch (error) {
            this.options.onWarn?.(
              `Cursor image ${id} unreadable: ${error instanceof Error ? error.message : String(error)}`,
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

  private async models(): Promise<CursorCatalogModel[]> {
    // A disposed adapter must not wait on discovery or read a credential.
    if (this.lifetime.signal.aborted) return this.catalog?.models ?? []
    const cached = this.catalog
    if (
      cached &&
      Date.now() - cached.at < (cached.live ? CATALOG_TTL_MS : CATALOG_RETRY_MS)
    ) {
      return cached.models
    }
    // Discovery belongs to the adapter, not to whichever caller happened to
    // start it: one caller's cancellation must not fail another's wait. A
    // standalone read still stops waiting when the adapter is disposed.
    const load = this.loading ?? this.startLoad()
    const disposed = new Promise<CursorCatalogModel[]>((resolve) => {
      this.lifetime.signal.addEventListener(
        'abort',
        () => resolve(this.catalog?.models ?? []),
        { once: true },
      )
    })
    return Promise.race([load, disposed])
  }

  private startLoad(): Promise<CursorCatalogModel[]> {
    const token = {}
    this.loadToken = token
    const loading = this.load(token).finally(() => {
      if (this.loading === loading) this.loading = undefined
    })
    this.loading = loading
    return loading
  }

  private async load(token?: object): Promise<CursorCatalogModel[]> {
    let models: CursorCatalogModel[] = []
    let apiKey: string | undefined
    try {
      if (this.lifetime.signal.aborted) return this.catalog?.models ?? []
      apiKey = await this.options.apiKey()
      if (this.lifetime.signal.aborted) {
        return this.catalog?.models ?? []
      }
      if (apiKey) {
        const discovered = await withTimeout(
          () => this.options.gateway.listModels({ apiKey: apiKey! }),
          DISCOVERY_TIMEOUT_MS,
        )
        models = discovered ?? []
      }
    } catch (error) {
      this.options.onWarn?.(
        `Cursor catalog failed: ${safeError(error, 'list the models')}`,
      )
    }
    const live = models.length > 0
    // A load a newer load replaced, or one after disposal, must not publish.
    if (this.loadToken !== token || this.lifetime.signal.aborted) {
      return this.catalog?.models ?? []
    }
    // No key means logged out: advertise nothing so the picker hides the route.
    if (!apiKey) {
      this.catalog = { models: [], live: false, at: Date.now() }
      return []
    }
    // A cancelled or superseded load returned above; this one is current.
    if (live && this.options.prewarm !== false) {
      const modelId =
        models.find((model) => model.id === 'default')?.id ?? models[0].id
      this.runtime.prewarm(apiKey, modelId)
    }
    this.catalog = {
      models: live ? models : FALLBACK_MODELS,
      live,
      at: Date.now(),
    }
    return this.catalog.models
  }
}

export { CURSOR_ROUTE }
export type { CursorRun }
