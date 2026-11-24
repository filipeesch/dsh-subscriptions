/**
 * One DSH model call as `StreamChunk` values.
 *
 * DSH expects every `block-start` closed by a `block-end` carrying the full
 * block, usage before the terminal `finish`, and nothing after it. Tool
 * arguments are raw JSON strings.
 *
 * `message` mirrors the reply in the transcript shape the runtime reads
 * (`text`, `thinking`, `toolCall` blocks), so fingerprints and token estimates
 * match what DSH sends back.
 */

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'

export type StopReason = 'stop' | 'toolUse' | 'error' | 'aborted'

/** One tool call the model asked the host to run. */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** Error codes outside DSH's default retry list: a half-finished Cursor run must not be replayed. */
export const ERROR_CODES = {
  error: 'CURSOR_RUN_FAILED',
  /** A pre-output failure that survived the route's replay; the host retries it. */
  unavailable: 'CURSOR_UNAVAILABLE',
  aborted: 'ABORTED',
  missingKey: 'MISSING_CREDENTIAL',
} as const

/** Push-to-pull bridge: the turn pushes chunks, the adapter's generator pulls them. */
export class ChunkQueue implements AsyncIterable<StreamChunk> {
  private items: StreamChunk[] = []
  private done = false
  private waker: (() => void) | undefined

  push(chunk: StreamChunk): void {
    if (this.done) return
    this.items.push(chunk)
    this.wake()
  }

  end(): void {
    this.done = true
    this.wake()
  }

  private wake(): void {
    const waker = this.waker
    this.waker = undefined
    waker?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
    for (;;) {
      while (this.items.length > 0) {
        yield this.items.shift()!
      }
      if (this.done) return
      await new Promise<void>((resolve) => {
        this.waker = resolve
      })
    }
  }
}

interface ChunkSink {
  push(chunk: StreamChunk): void
  end(): void
}

export class Reply {
  readonly message: { role: 'assistant'; content: unknown[] } = {
    role: 'assistant',
    content: [],
  }
  usage: TokenUsage | undefined
  stopReason: StopReason | undefined
  errorMessage: string | undefined
  private open:
    | {
        kind: 'text' | 'thinking'
        index: number
        block: Record<string, unknown>
      }
    | undefined
  private nextIndex = 0
  private ended = false
  private readonly sink: ChunkSink

  constructor(sink: ChunkSink) {
    this.sink = sink
  }

  get content(): unknown[] {
    return this.message.content
  }

  /** Whether a terminal chunk was already pushed; the fallback finish tests it. */
  get settled(): boolean {
    return this.ended
  }

  thinking(chunk: string): void {
    this.append('thinking', chunk)
  }

  text(chunk: string): void {
    this.append('text', chunk)
  }

  toolCalls(calls: readonly ToolCall[]): void {
    this.close()
    const seen = new Set<string>()
    for (const call of calls) {
      if (seen.has(call.id)) continue
      seen.add(call.id)
      const args = call.arguments ?? {}
      this.content.push({
        type: 'toolCall',
        id: call.id,
        name: call.name,
        arguments: args,
      })
      const index = this.nextIndex++
      const raw = JSON.stringify(args)
      this.sink.push({ type: 'block-start', index, blockType: 'tool-call' })
      this.sink.push({
        type: 'tool-call-delta',
        index,
        id: ToolCallId(call.id),
        name: call.name,
        argumentsDelta: raw,
      })
      this.sink.push({
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(call.id),
          name: call.name,
          arguments: raw,
        },
      })
    }
  }

  /** Terminal chunks. Safe to call more than once; only the first takes effect. */
  finish(reason: StopReason, errorMessage?: string, code?: string): void {
    if (this.ended) return
    this.ended = true
    this.close()
    this.stopReason = reason
    if (this.usage) this.sink.push({ type: 'usage', usage: this.usage })
    if (reason === 'error' || reason === 'aborted') {
      this.errorMessage =
        errorMessage ||
        (reason === 'aborted' ? 'Cursor run cancelled' : 'Cursor run failed')
      const failure: FinishReason = {
        kind: reason,
        failure: {
          message: this.errorMessage,
          code: code ?? ERROR_CODES[reason],
        },
      }
      this.sink.push({ type: 'finish', reason: failure })
    } else {
      this.sink.push({
        type: 'finish',
        reason: { kind: reason === 'toolUse' ? 'tool-calls' : 'stop' },
      })
    }
    this.sink.end()
  }

  private append(kind: 'text' | 'thinking', chunk: string): void {
    if (!chunk) return
    if (this.open?.kind !== kind) {
      this.close()
      const block: Record<string, unknown> =
        kind === 'text'
          ? { type: 'text', text: '' }
          : { type: 'thinking', thinking: '' }
      this.content.push(block)
      this.open = { kind, index: this.nextIndex++, block }
      this.sink.push({
        type: 'block-start',
        index: this.open.index,
        blockType: kind === 'text' ? 'text' : 'reasoning',
      })
    }
    const current = this.open!
    current.block[kind] = String(current.block[kind] ?? '') + chunk
    this.sink.push({
      type: kind === 'text' ? 'text-delta' : 'reasoning-delta',
      index: current.index,
      text: chunk,
    })
  }

  private close(): void {
    if (!this.open) return
    const { kind, index, block } = this.open
    this.open = undefined
    this.sink.push({
      type: 'block-end',
      index,
      block:
        kind === 'text'
          ? { type: 'text', text: String(block.text ?? '') }
          : { type: 'reasoning', text: String(block.thinking ?? '') },
    })
  }
}
