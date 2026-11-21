/**
 * What Cursor sees of the DSH transcript.
 *
 * Cursor has no system-prompt slot the host can use, so the first send of a
 * session carries the DSH system prompt and the history as one text. Later
 * sends carry only what is new; fingerprints tell which messages Cursor already
 * has.
 *
 * Messages here are already in the core shape (`transcript.ts`): `user`,
 * `developer`, `assistant` with `text` / `thinking` / `toolCall` blocks, and
 * `toolResult`.
 */

import { createHash } from 'node:crypto'

/** One inline image Cursor accepts. */
export interface Image {
  data: string
  mimeType?: string
}

/** Stable short hash used for fingerprints and the session key. */
export function hash(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

/** Text of a content value (string or blocks); images and tool calls are skipped. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      const record = asRecord(block)
      return record?.type === 'text' ? String(record.text ?? '') : ''
    })
    .filter((text) => text !== '')
    .join('\n')
}

/** A value as a plain object, or undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function imagesOf(
  messages: readonly { content?: unknown }[],
): Image[] | undefined {
  const images: Image[] = []
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content) {
      const record = asRecord(block)
      if (record?.type !== 'image' || typeof record.data !== 'string') continue
      images.push({
        data: record.data,
        ...(typeof record.mimeType === 'string'
          ? { mimeType: record.mimeType }
          : {}),
      })
    }
  }
  return images.length > 0 ? images : undefined
}

/**
 * Images since the last assistant message: DSH appends context messages after
 * the user's own.
 */
export function currentTurnImages(
  messages: readonly { role?: unknown; content?: unknown }[],
): Image[] | undefined {
  let start = messages.length
  while (start > 0 && messages[start - 1]?.role !== 'assistant') start--
  return imagesOf(messages.slice(start))
}

/** Parse tool arguments that arrive as a JSON string or an object. */
export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return asRecord(value) ?? {}
}

const TOOLS_NOTE =
  "Only the tools attached to this request are available. Cursor's built-in file, shell and edit tools are disabled; do not try them."

// Cursor account rules often say "read ~/…/AGENTS.md first"; DSH injects
// instruction files itself.
const INSTRUCTIONS_NOTE =
  "The system prompt and context messages below come from the host agent and already include the user's instruction files (AGENTS.md and similar). If Cursor user rules ask you to read such a file first, treat it as already read; do not call a tool for it unless the user asks."

function renderMessage(message: {
  role?: unknown
  content?: unknown
  toolName?: unknown
  toolCallId?: unknown
  isError?: unknown
}): string {
  switch (message?.role) {
    case 'user':
      return `### user\n${textOf(message.content)}`
    case 'developer':
      return `### context\n${textOf(message.content)}`
    case 'assistant': {
      const parts: string[] = []
      for (const block of Array.isArray(message.content)
        ? message.content
        : []) {
        const record = asRecord(block)
        if (record?.type === 'text' && record.text) {
          parts.push(String(record.text))
        } else if (record?.type === 'toolCall') {
          parts.push(
            `calls ${String(record.name)} (${String(record.id)}) with ${JSON.stringify(record.arguments ?? {})}`,
          )
        }
      }
      return `### assistant\n${parts.join('\n')}`
    }
    case 'toolResult':
      return `### ${String(message.toolName ?? 'tool')} (${String(message.toolCallId ?? '')})${message.isError ? ' [error]' : ''}\n${textOf(message.content) || '(no output)'}`
    default:
      return ''
  }
}

/** The first send of a session: tool rules, the system prompt, then the history so far. */
export function renderTranscript(
  systemPrompt: string | undefined,
  messages: readonly unknown[],
): string {
  const parts = [TOOLS_NOTE]
  const system = systemPrompt?.trim()
  if (system) parts.push(INSTRUCTIONS_NOTE, system)
  const history = messages
    .map((message) => renderMessage((message ?? {}) as never))
    .filter(Boolean)
  if (history.length > 0) parts.push('Conversation so far:', ...history)
  return parts.join('\n\n')
}

/** Text Cursor gets for a message sent after the first: context keeps its label. */
export function incrementText(message: {
  role?: unknown
  content?: unknown
}): string {
  const text = textOf(message?.content)
  return message?.role === 'developer' && text ? `[context]\n${text}` : text
}

/** Stable id of one message, limited to what Cursor saw of it. */
export function fingerprint(message: {
  role?: unknown
  content?: unknown
  toolCallId?: unknown
  isError?: unknown
}): string {
  switch (message?.role) {
    case 'user':
      return hash(`u\n${textOf(message.content)}`)
    case 'developer':
      return hash(`d\n${textOf(message.content)}`)
    case 'toolResult':
      return hash(
        `r\n${String(message.toolCallId ?? '')}\n${message.isError ? 1 : 0}\n${textOf(message.content)}`,
      )
    case 'assistant': {
      const parts: string[] = []
      for (const block of Array.isArray(message.content)
        ? message.content
        : []) {
        const record = asRecord(block)
        if (record?.type === 'text' && record.text) {
          parts.push(`t:${String(record.text)}`)
        } else if (record?.type === 'toolCall') {
          parts.push(
            `c:${String(record.id)}:${String(record.name)}:${JSON.stringify(record.arguments ?? {})}`,
          )
        }
      }
      return hash(`a\n${parts.join('\n')}`)
    }
    default:
      return hash(
        `${String(message?.role ?? '?')}\n${JSON.stringify(message?.content ?? '')}`,
      )
  }
}

/** A tool result in the shape a Cursor custom tool returns. */
export function toolResultForCursor(
  message: { content?: unknown; isError?: unknown },
  extraText?: string,
): {
  content: { type: string; text?: string; data?: string; mimeType?: string }[]
  isError: boolean
} {
  const blocks =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content)
        ? message.content
        : []
  const content: {
    type: string
    text?: string
    data?: string
    mimeType?: string
  }[] = []
  for (const block of blocks) {
    const record = asRecord(block)
    if (record?.type === 'text' && record.text) {
      content.push({ type: 'text', text: String(record.text) })
    } else if (record?.type === 'image' && typeof record.data === 'string') {
      content.push({
        type: 'image',
        data: record.data,
        ...(typeof record.mimeType === 'string'
          ? { mimeType: record.mimeType }
          : {}),
      })
    }
  }
  if (extraText) content.push({ type: 'text', text: extraText })
  if (content.length === 0) content.push({ type: 'text', text: '(no output)' })
  return { content, isError: Boolean(message.isError) }
}

/**
 * Lines added to the system prompt since Cursor last saw it, as a note for the
 * next send ("" when nothing changed). `undefined` when lines were removed or
 * rewritten: Cursor cannot unlearn them, so the session must start over.
 */
export function systemPromptAddition(
  before: string,
  after: string,
): string | undefined {
  if (before === after) return ''
  const left = new Map<string, number>()
  for (const line of before.split('\n')) {
    left.set(line, (left.get(line) ?? 0) + 1)
  }
  const added: string[] = []
  for (const line of after.split('\n')) {
    const count = left.get(line) ?? 0
    if (count > 0) left.set(line, count - 1)
    else added.push(line)
  }
  for (const [line, count] of left) {
    if (count > 0 && line.trim()) return undefined
  }
  const text = added.join('\n').trim()
  return text
    ? `[system prompt update: these lines were added to the system prompt]\n${text}`
    : ''
}

const CJK =
  /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g

/** Rough token count: ~4 characters per token, but about one token per CJK character. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK)?.length ?? 0
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

/** Estimated size of what Cursor holds for this transcript, before Cursor's own prompt. */
export function estimateTranscript(
  systemPrompt: string,
  tools: readonly unknown[],
  messages: readonly { content?: unknown; role?: unknown }[],
  reply: readonly {
    text?: string
    thinking?: string
    arguments?: unknown
  }[] = [],
): number {
  let tokens =
    estimateTextTokens(systemPrompt) + estimateTextTokens(JSON.stringify(tools))
  for (const message of messages) {
    tokens += estimateTextTokens(textOf(message?.content))
    if (message?.role === 'assistant') {
      tokens += estimateTextTokens(JSON.stringify(message.content ?? []))
    }
  }
  for (const block of reply) {
    tokens += estimateTextTokens(
      block.text ?? block.thinking ?? JSON.stringify(block.arguments ?? ''),
    )
  }
  return tokens
}
