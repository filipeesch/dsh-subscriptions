/**
 * How a Cursor failure is classified, described, and made diagnosable.
 *
 * Provider text can echo a credential or the request itself, so this module
 * never prints provider-supplied text. The caller-facing sentence is a local
 * literal, and the one warning line carries a reviewed diagnostic literal from
 * a closed vocabulary plus allowlisted structured fields (an SDK error class
 * name, a known status code). An unrecognized failure says so, and teaching the
 * vocabulary about it is a code change, not a log scrape.
 *
 * The cause decides two things: the sentence, and whether the runtime may
 * replay the turn. A rejected credential and rejected model parameters cannot
 * succeed on retry; a local or transport failure can. When several signals
 * describe one failed run, the most terminal cause wins.
 */

import {
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import { isRejectedParams } from './params.js'
import { ERROR_CODES } from './reply.js'

/** Why an attempt failed, as far as the route can tell without provider text. */
export type FailureCause = 'credential' | 'unreachable' | 'parameters' | 'local'

/** Where the failure happened: while setting up, or during the run. */
export type FailurePhase = 'setup' | 'run'

/** What one failure means for the turn. */
export interface FailureClass {
  readonly cause: FailureCause
  /** Whether replaying the turn on a new agent could succeed. */
  readonly replayable: boolean
}

/** One failure described three ways: for the log, the caller, and the host. */
export interface FailureReport {
  /** The warning line body; the plugin's sink prefixes its name. */
  readonly warning: string
  /** The fixed caller-facing sentence, free of provider text. */
  readonly sentence: string
  /** The terminal code; retryable only once recovery has been spent. */
  readonly code: string
}

/** Most terminal cause wins: a credential rejection outranks a bad parameter. */
const CAUSE_RANK: Readonly<Record<FailureCause, number>> = {
  credential: 0,
  parameters: 1,
  unreachable: 2,
  local: 3,
}

/**
 * SDK codes that mean the credential was rejected. The SDK's message varies
 * with the reason ("expired", "not signed in"), so the terminal shape decides.
 */
const CREDENTIAL_CODES = new Set([
  'auth',
  'authentication',
  'expired_token',
  'forbidden',
  'invalid_api_key',
  'invalid_credentials',
  'permission_denied',
  'token_expired',
  'unauthenticated',
  'unauthorized',
])
const CREDENTIAL_STATUS = new Set([401, 403])
const CREDENTIAL_NAME = /authenticat|unauthori|forbidden|permission/i
/**
 * Free-form credential evidence. A bare `401` is deliberately not enough: the
 * digits appear inside identifiers and byte counts, and reading them as a
 * rejection would stop a recoverable turn from replaying. The status has to be
 * marked as one — `HTTP 401`, `status=403`, `code:401` — or paired with the
 * authentication wording that makes it unambiguous.
 */
const CREDENTIAL_MESSAGE =
  /(?:\bHTTP|\bstatus|\bcode)\s*[/:=]?\s*(?:401|403)\b|\b(?:401|403)\s+(?:unauthori[sz]ed|forbidden|unauthenticated)\b|unauthori[sz]ed|forbidden|invalid api key|authentication|api key (?:is )?(?:expired|invalid)|not signed in|sign.?in (?:is )?(?:required|needs)/i
const UNREACHABLE =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i

/**
 * SDK error classes a warning may name. Membership, not spelling: a provider
 * cannot put an arbitrary string into a field that only these exact values fill.
 */
const REVIEWED_NAMES = new Set([
  'AgentBusyError',
  'AgentNotFoundError',
  'AuthenticationError',
  'ConfigurationError',
  'CursorAgentError',
  'CursorSdkError',
  'FeatureUnavailableError',
  'IntegrationNotConnectedError',
  'NetworkError',
  'RateLimitError',
  'UnknownAgentError',
])
/** Structured field values an unknown error may contribute to a warning. */
const REVIEWED_CODES = new Set([
  'aborted',
  'already_exists',
  'cancelled',
  'canceled',
  'deadline_exceeded',
  'failed_precondition',
  'internal',
  'invalid_argument',
  'not_found',
  'out_of_range',
  'permission_denied',
  'rate_limited',
  'resource_exhausted',
  'unauthenticated',
  'unavailable',
  'unimplemented',
  'unknown',
])
const REVIEWED_STATUS = /^[1-5][0-9]{2}$/
/** Longest detail a warning line carries, in characters. */
const DETAIL_LIMIT = 200

/**
 * The closed vocabulary a warning detail is drawn from, most specific first. A
 * pattern only decides which reviewed literal is printed; the message it
 * matched is never printed.
 */
const DETAIL_VOCABULARY: readonly {
  readonly pattern: RegExp
  readonly detail: string
}[] = [
  {
    pattern: /rate limit|too many requests|429/i,
    detail: 'rate limited',
  },
  {
    pattern: /quota|usage limit|exhausted/i,
    detail: 'quota exhausted',
  },
  {
    pattern: /stream idle timeout|stream progress timeout|timed? ?out/i,
    detail: 'stream timed out',
  },
  {
    pattern:
      /stream (?:was )?closed|bridge closed|premature close|unexpected end/i,
    detail: 'stream closed early',
  },
  {
    pattern: /local store|sqlite|agent store|run store/i,
    detail: 'local store failure',
  },
  {
    pattern: /not found|no such agent|does not exist|archived|lost/i,
    detail: 'agent state lost',
  },
]

/** The parts of an unknown thrown value or reported error the route can read. */
interface FailureFields {
  name: string
  code: string
  status: number | undefined
  message: string
}

/** A value as text, without ever coercing an object into a primitive. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  // An object without a string message (a null-prototype object, a proxy) has
  // no detail worth guessing at, and coercing it can throw.
  return ''
}

/**
 * The fields of an unknown thrown value or reported error.
 *
 * Never throws: reporting a failure must not become a second failure, so an
 * object without readable fields contributes none and the detail falls back to
 * the reviewed placeholder.
 */
function fieldsOf(error: unknown): FailureFields {
  const empty: FailureFields = {
    name: '',
    code: '',
    status: undefined,
    message: '',
  }
  if (error === null || error === undefined) return empty
  if (typeof error !== 'object') {
    return { ...empty, message: textOf(error) }
  }
  try {
    const record = error as Record<string, unknown>
    const name =
      typeof record.name === 'string' && record.name.length > 0
        ? record.name
        : error instanceof Error
          ? error.constructor.name
          : ''
    return {
      name,
      code: typeof record.code === 'string' ? record.code.toLowerCase() : '',
      status: typeof record.status === 'number' ? record.status : undefined,
      message:
        typeof record.message === 'string'
          ? record.message
          : error instanceof Error
            ? error.message
            : '',
    }
  } catch {
    // A proxy or an exotic object can throw from a property read.
    return empty
  }
}

/**
 * Classify one failure.
 * @param error - the thrown value, the run's reported error, or a message.
 * @returns the cause and whether a replay could succeed.
 */
export function classifyFailure(error: unknown): FailureClass {
  const { name, code, status, message } = fieldsOf(error)
  if (
    (status !== undefined && CREDENTIAL_STATUS.has(status)) ||
    CREDENTIAL_CODES.has(code) ||
    CREDENTIAL_NAME.test(name) ||
    CREDENTIAL_MESSAGE.test(message)
  ) {
    return { cause: 'credential', replayable: false }
  }
  if (isRejectedParams(message)) {
    return { cause: 'parameters', replayable: false }
  }
  if (UNREACHABLE.test(message)) {
    return { cause: 'unreachable', replayable: true }
  }
  return { cause: 'local', replayable: true }
}

/**
 * Classify every signal one failed run produced.
 *
 * A run can both throw while streaming and report a structured error when it
 * settles; the terminal evidence has to win, or a rejected credential would be
 * read as a transport blip and retried.
 * @param errors - the thrown value, the reported error, or both.
 * @returns the most terminal cause and whether a replay could succeed.
 */
export function classifyFailures(errors: readonly unknown[]): FailureClass {
  let best: FailureClass = { cause: 'local', replayable: true }
  for (const error of errors) {
    const next = classifyFailure(error)
    if (CAUSE_RANK[next.cause] < CAUSE_RANK[best.cause]) best = next
  }
  return best
}

/** The reviewed sentence one cause always produces. */
function sentenceFor(cause: FailureCause, action: string): string {
  switch (cause) {
    case 'credential':
      return `Cursor rejected the API key while trying to ${action}.`
    case 'parameters':
      return 'Cursor rejected the selected model parameters.'
    case 'unreachable':
      return `Cursor could not be reached while trying to ${action}.`
    default:
      return `Cursor failed while trying to ${action}.`
  }
}

/**
 * Credential-free diagnostics: the caller sees a classified sentence, never
 * provider text.
 * @param error - the failure.
 * @param action - what the route was trying to do, in the form "run the model".
 * @returns the fixed sentence for the failure's cause.
 */
export function safeError(error: unknown, action: string): string {
  return sentenceFor(classifyFailure(error).cause, action)
}

/** The structured fields of one failure that may be printed, if any. */
function structuredFields(error: unknown): string {
  const { name, code, status } = fieldsOf(error)
  const parts: string[] = []
  if (REVIEWED_NAMES.has(name)) parts.push(name)
  if (REVIEWED_CODES.has(code)) parts.push(`code=${code}`)
  if (status !== undefined && REVIEWED_STATUS.test(String(status))) {
    parts.push(`status=${status}`)
  }
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`
}

/** The reviewed literal one failure's message maps to. */
function literalFor(error: unknown): string {
  const { status, message } = fieldsOf(error)
  if (status !== undefined && CREDENTIAL_STATUS.has(status)) {
    return 'credential rejected'
  }
  if (CREDENTIAL_MESSAGE.test(message)) return 'credential rejected'
  if (isRejectedParams(message)) return 'model parameters rejected'
  if (UNREACHABLE.test(message)) return 'transport unreachable'
  for (const entry of DETAIL_VOCABULARY) {
    if (entry.pattern.test(message)) return entry.detail
  }
  return 'unclassified failure'
}

/**
 * Describe a failure for the log without printing provider text.
 * @param errors - the thrown value, the reported error, or both.
 * @returns the reviewed literal plus allowlisted structured fields, at most
 *   {@link DETAIL_LIMIT} characters.
 */
export function reviewedDetail(errors: readonly unknown[]): string {
  const classified = classifyFailures(errors)
  const primary =
    errors.find((error) => classifyFailure(error).cause === classified.cause) ??
    errors[0]
  const detail = `${literalFor(primary)}${structuredFields(primary)}`
  return detail.length <= DETAIL_LIMIT ? detail : detail.slice(0, DETAIL_LIMIT)
}

/**
 * The one warning line a failed turn records.
 * @param input.phase - setup or run.
 * @param input.cause - the classified cause.
 * @param input.detail - the reviewed detail.
 * @param input.beforeOutput - whether the attempt emitted nothing.
 * @returns the warning body; the plugin's sink prefixes its name.
 */
export function failureWarning(input: {
  phase: FailurePhase
  cause: FailureCause
  detail: string
  beforeOutput: boolean
}): string {
  const boundary = input.beforeOutput ? 'before output' : 'after output'
  return `Cursor failed ${boundary} (phase=${input.phase}, cause=${input.cause}): ${input.detail}`
}

/**
 * Describe one failed attempt: the warning to log, the sentence to show, and
 * the code that tells the host whether it may retry.
 * @param input.phase - setup or run.
 * @param input.errors - every signal the failure produced, most terminal first
 *   by nature rather than order.
 * @param input.action - what the route was trying to do.
 * @param input.beforeOutput - whether the attempt emitted nothing.
 * @param input.recoverySpent - whether the route already ran its one replay for
 *   this turn. Only a failure that spent recovery may be retried by the host.
 * @param input.ambiguous - whether the failure's evidence may be incomplete. An
 *   unresolved failure is never offered for a retry: what never arrived is
 *   exactly what a retry must not gamble on.
 * @returns the three descriptions, derived from one classification.
 */
export function describeFailure(input: {
  phase: FailurePhase
  errors: readonly unknown[]
  action: string
  beforeOutput: boolean
  recoverySpent: boolean
  ambiguous?: boolean
}): FailureReport {
  const classified = classifyFailures(input.errors)
  // Eligibility is derived here from the facts, never asserted by the caller:
  // a retryable code requires a spent recovery, no emitted output, a cause a
  // retry could fix, and evidence complete enough to say so.
  const retryable =
    input.recoverySpent &&
    input.beforeOutput &&
    classified.replayable &&
    input.ambiguous !== true
  return {
    warning: failureWarning({
      phase: input.phase,
      cause: classified.cause,
      detail: reviewedDetail(input.errors),
      beforeOutput: input.beforeOutput,
    }),
    sentence: sentenceFor(classified.cause, input.action),
    code: retryable ? ERROR_CODES.unavailable : ERROR_CODES.error,
  }
}

const RETRY_POLICY_PATH = 'dsh-subscriptions: cursor retryPolicy'
let retryPolicy: ResolvedRetryPolicy | undefined

/**
 * The retry policy the `cursor` route publishes to the host.
 *
 * Only the pre-output code is retried, and at most twice, so the host replays a
 * turn the route already deemed safe to replay and never a half-finished one.
 * @returns the resolved policy, built through the host's own resolver so the
 *   backoff defaults stay the host's.
 */
export function cursorRetryPolicy(): ResolvedRetryPolicy {
  retryPolicy ??= resolveRetryPolicy(
    {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: [ERROR_CODES.unavailable],
    },
    RETRY_POLICY_PATH,
  )
  return retryPolicy
}
