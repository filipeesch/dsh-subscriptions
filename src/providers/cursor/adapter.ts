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
}

export class CursorAdapter extends LlmAdapter {
  private readonly runtime: CursorRuntime
  private catalog:
    { models: CursorCatalogModel[]; live: boolean; at: number } | undefined
  private loading: Promise<CursorCatalogModel[]> | undefined
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
      ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
    })
  }

  /** Close every live agent; the plugin calls this from its disposer. */
  dispose(): void {
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

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options?.stop?.length) {
      throw new LlmError(
        'Cursor does not support stop sequences',
        'UNSUPPORTED_OPTION',
      )
    }
    // A request the host already cancelled must not touch the catalog, the
    // attachment store, or the SDK.
    if (options.signal?.aborted) {
      const cancelled = new ChunkQueue()
      const reply = new Reply(cancelled)
      reply.finish('aborted')
      yield* cancelled
      return
    }
    const [models, images] = await Promise.all([
      this.models(),
      this.loadImages(options),
    ])
    const transcript = readRequest(options, images)
    const queue = new ChunkQueue()
    const reply = new Reply(queue)
    // Closing the stream (host abort, iterator teardown) must not leave the
    // Cursor run or its agent working in the background.
    const controller = new AbortController()
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([options.signal, controller.signal])
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
            image = await read(ref, options.signal)
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
    const cached = this.catalog
    if (
      cached &&
      Date.now() - cached.at < (cached.live ? CATALOG_TTL_MS : CATALOG_RETRY_MS)
    ) {
      return cached.models
    }
    const loading = this.load().finally(() => {
      this.loading = undefined
    })
    this.loading = loading
    return loading
  }

  private async load(): Promise<CursorCatalogModel[]> {
    let models: CursorCatalogModel[] = []
    let apiKey: string | undefined
    try {
      apiKey = await this.options.apiKey()
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
    // No key means logged out: advertise nothing so the picker hides the route.
    if (!apiKey) {
      this.catalog = { models: [], live: false, at: Date.now() }
      return []
    }
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
