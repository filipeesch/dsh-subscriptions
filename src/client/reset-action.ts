/** Explain client-side gating; the server independently revalidates before spending. */
export function resetActionBlock(
  usage: {
    windows?: {
      kind: string
      scope?: string
      usedPercent?: number
      resetsAt?: number
    }[]
    resetCredits?: { id?: string; expiresAt?: number }[]
    resetCreditsError?: string
  },
  now = Date.now(),
): 'resetUseGuard' | 'resetUseRefresh' | 'resetUseRestart' | undefined {
  const weekly = usage.windows?.find(
    (w) => w.kind === 'weekly' && w.scope === undefined,
  )
  const used = weekly?.usedPercent
  if (weekly === undefined || used === undefined || !Number.isFinite(used))
    return 'resetUseRefresh'
  if (used < 80) return 'resetUseGuard'
  if (
    weekly.resetsAt === undefined ||
    weekly.resetsAt <= now ||
    usage.resetCreditsError
  )
    return 'resetUseRefresh'
  if (!usage.resetCredits?.some((c) => c.id)) return 'resetUseRestart'
  if (
    !usage.resetCredits.some(
      (c) => c.id && (c.expiresAt === undefined || c.expiresAt > now),
    )
  )
    return 'resetUseRefresh'
  return undefined
}
