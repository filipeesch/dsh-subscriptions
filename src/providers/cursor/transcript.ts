/**
 * A DSH request as the transcript shape the Cursor runtime reads.
 *
 * DSH sends the whole derived history on every call: system messages (the
 * latest one is the effective system prompt), developer context, user,
 * assistant with tool-call blocks whose arguments are raw JSON, and tool
 * results. The runtime works on `user` / `developer` / `assistant` /
 * `toolResult` with parsed tool arguments, the same shape the mirrored reply
 * has.
 *
 * Image blocks are attachment references; the adapter loads their bytes first
 * and passes them in by attachment id. Images it could not load become a text
 * note.
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { asObject, asRecord, type Image } from './prompt.js'

/** One tool schema the runtime hands to Cursor. */
export interface CursorTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** One message in the runtime's transcript. */
export interface CursorTranscriptMessage {
  role: 'user' | 'developer' | 'assistant' | 'toolResult'
  content: unknown[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

/** What one request carries. */
export interface CursorTranscript {
  systemPrompt: string
  tools: CursorTool[]
  messages: CursorTranscriptMessage[]
}

const IMAGE_NOTE = '[image attachment not forwarded to Cursor]'

/** Loaded image bytes, keyed by attachment id. */
export type Images = ReadonlyMap<string, Image>

/** The durable attachment reference an image block carries. */
export type CursorImageRef = ImageAttachmentRef

/** Attachment references of the images a request carries, skipping offloaded ones. */
export function imageRefs(options: GenerateOptions): CursorImageRef[] {
  const refs = new Map<string, CursorImageRef>()
  for (const message of options.messages ?? []) {
    const content = asRecord(message)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = asRecord(block)
      const attachment = asRecord(record?.attachment)
      if (
        record?.type === 'image' &&
        record.offloaded !== true &&
        typeof attachment?.attachmentId === 'string' &&
        typeof attachment.mediaType === 'string'
      ) {
        refs.set(
          attachment.attachmentId,
          attachment as unknown as CursorImageRef,
        )
      }
    }
  }
  return [...refs.values()]
}

function blocks(
  content: unknown,
  images?: Images,
): { type: string; text?: string; data?: string; mimeType?: string }[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const out: {
    type: string
    text?: string
    data?: string
    mimeType?: string
  }[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (block?.type === 'text' && block.text) {
      out.push({ type: 'text', text: String(block.text) })
    } else if (block?.type === 'image') {
      const attachment = asRecord(block.attachment)
      const image =
        block.offloaded === true
          ? undefined
          : images?.get(String(attachment?.attachmentId))
      out.push(
        image
          ? {
              type: 'image',
              data: image.data,
              ...(image.mimeType === undefined
                ? {}
                : { mimeType: image.mimeType }),
            }
          : { type: 'text', text: IMAGE_NOTE },
      )
    } else if (block?.type === 'file') {
      const attachment = asRecord(block.attachment)
      out.push({
        type: 'text',
        text: `[file attachment: ${String(attachment?.name ?? attachment?.path ?? 'file')}]`,
      })
    }
  }
  return out
}

function plainText(content: unknown): string {
  return blocks(content)
    .map((block) => block.text ?? '')
    .join('\n')
}

function assistantBlocks(content: unknown): unknown[] {
  const out: unknown[] = []
  for (const raw of Array.isArray(content) ? content : []) {
    const block = asRecord(raw)
    if (block?.type === 'text' && block.text) {
      out.push({ type: 'text', text: String(block.text) })
    } else if (block?.type === 'reasoning' && block.text) {
      out.push({ type: 'thinking', thinking: String(block.text) })
    } else if (block?.type === 'tool-call') {
      out.push({
        type: 'toolCall',
        id: String(block.id),
        name: String(block.name),
        arguments: asObject(block.arguments),
      })
    }
  }
  return out
}

/** Convert one request into the runtime transcript. */
export function readRequest(
  options: GenerateOptions,
  images?: Images,
): CursorTranscript {
  let systemPrompt = typeof options.system === 'string' ? options.system : ''
  const messages: CursorTranscriptMessage[] = []
  const toolNames = new Map<string, string>()
  for (const raw of options.messages ?? []) {
    const message = asRecord(raw)
    switch (message?.role) {
      case 'system':
        systemPrompt = plainText(message.content)
        break
      case 'developer': {
        const content = blocks(message.content, images)
        if (content.length > 0) messages.push({ role: 'developer', content })
        break
      }
      case 'user':
        messages.push({
          role: 'user',
          content: blocks(message.content, images),
        })
        break
      case 'assistant': {
        const content = assistantBlocks(message.content)
        for (const rawBlock of content) {
          const block = asRecord(rawBlock)
          if (block?.type === 'toolCall') {
            toolNames.set(String(block.id), String(block.name))
          }
        }
        messages.push({ role: 'assistant', content })
        break
      }
      case 'tool': {
        const source = asRecord(message.source)
        const id = String(message.toolCallId ?? source?.callId ?? '')
        const toolName = toolNames.get(id)
        messages.push({
          role: 'toolResult',
          toolCallId: id,
          ...(toolName === undefined ? {} : { toolName }),
          isError: Boolean(message.isError),
          content: blocks(message.content, images),
        })
        break
      }
    }
  }
  const tools: CursorTool[] = (options.tools ?? [])
    .filter((tool) => tool?.name)
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      parameters:
        tool.parameters !== null && typeof tool.parameters === 'object'
          ? (tool.parameters as Record<string, unknown>)
          : { type: 'object', properties: {} },
    }))
  return { systemPrompt, tools, messages }
}
