/**
 * Failure classification, reviewed details, and the warning line.
 *
 * These are unit tests over the module's pure functions. Two contracts matter:
 * the sentences must stay byte-identical to what callers saw before the split,
 * and the detail must come from the module's own vocabulary, never from provider
 * text that could echo a credential or the request.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyFailure,
  classifyFailures,
  cursorRetryPolicy,
  describeFailure,
  failureWarning,
  reviewedDetail,
  safeError,
} from '../src/providers/cursor/failure.js'

test('a rejected credential is terminal, however the SDK states it', () => {
  const cases: unknown[] = [
    Object.assign(new Error('not allowed here'), {
      name: 'AuthenticationError',
      code: 'unauthenticated',
      status: 401,
    }),
    { message: 'something failed', code: 'permission_denied' },
    { message: 'something failed', status: 403 },
    new Error('401 Unauthorized'),
    new Error('API key is expired.'),
    new Error('The user is not signed in'),
  ]
  for (const error of cases) {
    assert.deepEqual(
      classifyFailure(error),
      { cause: 'credential', replayable: false },
      JSON.stringify(error),
    )
  }
})

test('rejected model parameters are not replayed', () => {
  assert.deepEqual(
    classifyFailure(new Error('invalid parameters for registry model claude')),
    { cause: 'parameters', replayable: false },
  )
})

test('a transport failure is replayable', () => {
  assert.deepEqual(classifyFailure(new Error('fetch failed')), {
    cause: 'unreachable',
    replayable: true,
  })
  assert.deepEqual(classifyFailure(new Error('connect ECONNREFUSED')), {
    cause: 'unreachable',
    replayable: true,
  })
})

test('an unclassified failure is local and replayable', () => {
  assert.deepEqual(classifyFailure(new Error('local store open failed')), {
    cause: 'local',
    replayable: true,
  })
  assert.deepEqual(classifyFailure(undefined), {
    cause: 'local',
    replayable: true,
  })
})

test('the most terminal signal wins when a run reports several', () => {
  const network = new Error('fetch failed')
  const expired = Object.assign(new Error('failed'), {
    code: 'unauthenticated',
    status: 401,
  })
  assert.deepEqual(classifyFailures([network, expired]), {
    cause: 'credential',
    replayable: false,
  })
  assert.deepEqual(
    classifyFailures([new Error('local store failed'), expired]),
    {
      cause: 'credential',
      replayable: false,
    },
  )
  assert.deepEqual(
    classifyFailures([
      new Error('local store failed'),
      new Error('invalid parameters for registry model x'),
    ]),
    { cause: 'parameters', replayable: false },
  )
  assert.deepEqual(classifyFailures([]), {
    cause: 'local',
    replayable: true,
  })
})

test('each cause keeps the sentence callers already saw', () => {
  assert.equal(
    safeError(new Error('HTTP 401 Unauthorized'), 'run the model'),
    'Cursor rejected the API key while trying to run the model.',
  )
  assert.equal(
    safeError(
      new Error('invalid parameters for registry model x'),
      'run the model',
    ),
    'Cursor rejected the selected model parameters.',
  )
  assert.equal(
    safeError(new Error('fetch failed'), 'run the model'),
    'Cursor could not be reached while trying to run the model.',
  )
  assert.equal(
    safeError(new Error('local store open failed'), 'run the model'),
    'Cursor failed while trying to run the model.',
  )
  assert.equal(
    safeError(new Error('boom'), 'warm the SDK'),
    'Cursor failed while trying to warm the SDK.',
  )
})

test('the detail is a reviewed literal, never provider text', () => {
  const cases: [unknown, string][] = [
    [new Error('local store open failed'), 'local store failure'],
    [new Error('no such agent abc'), 'agent state lost'],
    [new Error('stream idle timeout after 60s'), 'stream timed out'],
    [new Error('the bridge closed early'), 'stream closed early'],
    [new Error('rate limit exceeded'), 'rate limited'],
    [new Error('quota exhausted for this account'), 'quota exhausted'],
    [new Error('Cursor agent returned HTTP 429'), 'rate limited'],
    [new Error('transport blew up with ENOTFOUND'), 'transport unreachable'],
    // A status is never read out of provider text: a request could contain one.
    [new Error('failed while echoing HTTP 478'), 'unclassified failure'],
    [new Error('404 Unauthorized'), 'credential rejected'],
    [new Error('Unable to parse prompt: PIN 6327'), 'unclassified failure'],
    [undefined, 'unclassified failure'],
  ]
  for (const [error, expected] of cases) {
    assert.equal(reviewedDetail([error]), expected, String(error))
  }
})

test('the detail keeps only allowlisted structured fields', () => {
  assert.equal(
    reviewedDetail([
      Object.assign(new Error('the run failed'), {
        name: 'AuthenticationError',
        code: 'unauthenticated',
        status: 401,
      }),
    ]),
    'credential rejected (AuthenticationError, code=unauthenticated, status=401)',
  )
  assert.equal(
    reviewedDetail([
      Object.assign(new Error('the run failed'), {
        name: 'PRIVATE TEST TRANSCRIPT',
        code: 'not a reviewed code',
        status: 999,
      }),
    ]),
    'unclassified failure',
  )
  // A class name is printed only when it is one of the reviewed ones, whatever
  // its spelling looks like.
  assert.equal(
    reviewedDetail([
      Object.assign(new Error('the run failed'), {
        name: 'PrivateToolResultMarkerError',
      }),
    ]),
    'unclassified failure',
  )
})

test('a warning line bounded by the vocabulary stays one line', () => {
  const long = new Error('x'.repeat(4000))
  const detail = reviewedDetail([long])
  assert.ok(!detail.includes('x'.repeat(20)))
  assert.equal(detail, 'unclassified failure')
})

test('the warning line names the boundary, phase, and cause', () => {
  assert.equal(
    failureWarning({
      phase: 'setup',
      cause: 'local',
      detail: 'local store failure',
      beforeOutput: true,
    }),
    'Cursor failed before output (phase=setup, cause=local): local store failure',
  )
  assert.equal(
    failureWarning({
      phase: 'run',
      cause: 'unreachable',
      detail: 'transport unreachable',
      beforeOutput: false,
    }),
    'Cursor failed after output (phase=run, cause=unreachable): transport unreachable',
  )
})

test('host-retry eligibility is derived from the facts', () => {
  const failed = new Error('local store open failed')
  const report = (input: {
    errors?: unknown[]
    beforeOutput?: boolean
    recoverySpent?: boolean
  }) =>
    describeFailure({
      phase: 'run',
      errors: input.errors ?? [failed],
      action: 'run the model',
      beforeOutput: input.beforeOutput ?? true,
      recoverySpent: input.recoverySpent ?? true,
    })

  const spent = report({})
  assert.equal(spent.code, 'CURSOR_UNAVAILABLE')
  assert.equal(
    spent.warning,
    'Cursor failed before output (phase=run, cause=local): local store failure',
  )
  // No recovery was spent: the host has nothing to replay.
  assert.equal(report({ recoverySpent: false }).code, 'CURSOR_RUN_FAILED')
  // Output was already delivered: a replay would duplicate it.
  assert.equal(report({ beforeOutput: false }).code, 'CURSOR_RUN_FAILED')
  // A rejected credential cannot be fixed by a retry, however it was reached.
  const credential = report({
    errors: [Object.assign(new Error('no'), { status: 401 })],
  })
  assert.equal(credential.code, 'CURSOR_RUN_FAILED')
  assert.equal(
    credential.sentence,
    'Cursor rejected the API key while trying to run the model.',
  )
  // Contradictory caller input cannot buy a retryable code.
  assert.equal(
    describeFailure({
      phase: 'setup',
      errors: [failed],
      action: 'run the model',
      beforeOutput: false,
      recoverySpent: false,
    }).code,
    'CURSOR_RUN_FAILED',
  )
})

test('the route policy retries only the pre-output code', () => {
  const policy = cursorRetryPolicy()
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.mode === 'normal' && policy.maxRetries, 2)
  assert.deepEqual(policy.mode === 'normal' ? policy.retryableCodes : [], [
    'CURSOR_UNAVAILABLE',
  ])
})
