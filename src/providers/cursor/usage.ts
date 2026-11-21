/**
 * Cursor usage to DSH usage.
 *
 * Cursor reports one cumulative usage per run, at its end, summed over every
 * model call in it, and its `inputTokens` already include cache reads and
 * writes. DSH reads disjoint buckets as one request, so this module separates
 * them and omits a total that would disagree with the buckets.
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Cumulative usage Cursor reports for one run. */
export interface CursorUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Disjoint buckets; Cursor counts cache tokens inside `inputTokens`. */
export function buckets(usage: CursorUsage): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
} {
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const input = Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite)
  const output = usage.outputTokens ?? 0
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  }
}

/**
 * DSH usage for a finished run.
 *
 * A single-call run is reported as is. A multi-call run includes calls DSH never
 * sees, so its cumulative input is no context size: the input buckets keep
 * their ratio but are scaled to `estimatedContext`, and output is the run's
 * real output.
 */
export function runUsage(
  usage: CursorUsage | undefined,
  calls: number,
  estimatedContext: number,
): TokenUsage | undefined {
  if (!usage) return undefined
  const bucket = buckets(usage)
  let { input, cacheRead, cacheWrite } = bucket
  const prompt = input + cacheRead + cacheWrite
  if (calls > 1 && estimatedContext > 0 && prompt > 0) {
    const fit = estimatedContext / prompt
    cacheRead = Math.round(cacheRead * fit)
    cacheWrite = Math.round(cacheWrite * fit)
    input = Math.max(0, estimatedContext - cacheRead - cacheWrite)
  }
  return {
    inputTokens: input,
    outputTokens: bucket.output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}
