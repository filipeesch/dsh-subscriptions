import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UsageBar, windowTooltip } from '../src/client/UsageBar.js'
import type { UsageWindow } from '../src/client/SubscriptionsSection.js'

const t = ((key: string) => key) as never

const HOUR = 60 * 60_000

test('a stale bar keeps the color it was measured with', () => {
  const now = Date.now()
  const window: UsageWindow = {
    kind: 'other',
    usedPercent: 70,
    startsAt: now - 2 * HOUR,
    resetsAt: now + 8 * HOUR,
    windowDurationMs: 10 * HOUR,
  }
  const fresh = renderToStaticMarkup(
    createElement(UsageBar, {
      window,
      t,
      observedAt: now,
      stateKey: 'cursor:default',
    }),
  )
  assert.match(fresh, /state-warn-label/)
  const stale = renderToStaticMarkup(
    createElement(UsageBar, {
      window,
      t,
      observedAt: now - 3 * HOUR,
      stale: true,
      stateKey: 'cursor:default',
    }),
  )
  assert.match(stale, /state-warn-label/)
})

test('a money window without a share draws no fill', () => {
  const window: UsageWindow = {
    kind: 'other',
    usedAmount: 53_713,
    currency: 'USD',
  }
  const html = renderToStaticMarkup(
    createElement(UsageBar, { window, t, observedAt: Date.now() }),
  )
  assert.match(html, /width:0%/)
  assert.match(html, /alias-label-dimmed/)
  assert.match(windowTooltip(window, t), /usageBarUsed/)
})
