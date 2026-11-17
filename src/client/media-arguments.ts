import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'

const PROMPT_MAX_LENGTH = 60

/** Structural view of RC3's incremental argument API, absent on older hosts. */
interface IncrementalArguments {
  textPrefix(key: string, maxLength: number): string | undefined
  value(key: string): unknown
  keys(): Iterable<string>
}

/** Read during render: the host republishes preparing calls as arguments grow. */
export function mediaArguments(block: ToolCallBlock): {
  prompt: string
  references: number
} {
  const args = (block as ToolCallBlock & { args?: IncrementalArguments }).args
  const raw =
    'kind' in block
      ? block.call?.argsRaw
      : 'argsRaw' in block
        ? block.argsRaw
        : undefined
  let prompt: string | undefined
  let references: unknown
  if (args !== undefined) {
    prompt = args.textPrefix('prompt', PROMPT_MAX_LENGTH + 1)
    if (!prompt) {
      for (const key of args.keys()) {
        const candidate = args.textPrefix(key, PROMPT_MAX_LENGTH + 1)
        if (candidate) {
          prompt = candidate
          break
        }
      }
    }
    references = args.value('referenceImages')
  } else if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const fields = parsed as Record<string, unknown>
        if (typeof fields.prompt === 'string' && fields.prompt !== '')
          prompt = fields.prompt
        else {
          prompt = Object.values(fields).find(
            (value): value is string =>
              typeof value === 'string' && value !== '',
          )
        }
        references = fields.referenceImages
      }
    } catch {
      // Keep the raw line for malformed or still-truncated arguments.
    }
  }
  const line = (prompt ?? raw ?? '').split('\n', 1)[0] ?? ''
  return {
    prompt:
      line.length > PROMPT_MAX_LENGTH
        ? `${line.slice(0, PROMPT_MAX_LENGTH)}…`
        : line,
    references: Array.isArray(references) ? references.length : 0,
  }
}
