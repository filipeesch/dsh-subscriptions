import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FALLBACK_MODELS,
  contextWindowFor,
  modelNames,
  modelParams,
  preferredContext,
  reasoningInfo,
  resolveModelId,
  smallerContext,
  isRejectedParams,
} from '../src/providers/cursor/models.js'

const catalogModel = {
  id: 'claude-sonnet-5-5',
  displayName: 'Claude Sonnet 5.5',
  parameters: [
    { id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] },
    {
      id: 'effort',
      values: [
        { value: 'low' },
        { value: 'medium' },
        { value: 'high' },
        { value: 'xhigh' },
      ],
    },
    { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
    {
      id: 'context',
      values: [{ value: '50k' }, { value: '200k' }, { value: '1m' }],
    },
  ],
}

test('the largest offered context tier is the default', () => {
  const context = catalogModel.parameters.find((p) => p.id === 'context')
  assert.equal(preferredContext(context)?.value, '1m')
  assert.equal(preferredContext(context, 'max')?.value, '1m')
  assert.equal(preferredContext(context, '200k')?.value, '200k')
  // An unknown preference falls back to the largest, not the smallest.
  assert.equal(preferredContext(context, 'nonsense')?.value, '1m')
  assert.equal(contextWindowFor(catalogModel), 1_000_000)
  assert.equal(contextWindowFor(undefined), 200_000)
})

test('a rejected tier steps down to the next smaller offered tier', () => {
  const params = [{ id: 'context', value: '1m' }]
  assert.deepEqual(smallerContext(catalogModel, params), [
    { id: 'context', value: '200k' },
  ])
  const smallest = [{ id: 'context', value: '50k' }]
  assert.equal(smallerContext(catalogModel, smallest), undefined)
  assert.equal(
    isRejectedParams('invalid parameters for registry model x'),
    true,
  )
  assert.equal(isRejectedParams('other'), false)
})

test('effort maps to the closest advertised value and fast stays off', () => {
  const params = modelParams(catalogModel, 'medium')
  assert.deepEqual(params, [
    { id: 'thinking', value: 'true' },
    { id: 'effort', value: 'medium' },
    { id: 'fast', value: 'false' },
    { id: 'context', value: '1m' },
  ])
  // Reasoning off turns the switch off and drops to the lowest effort.
  const off = modelParams(catalogModel, 'off')
  assert.deepEqual(off, [
    { id: 'thinking', value: 'false' },
    { id: 'fast', value: 'false' },
    { id: 'context', value: '1m' },
  ])
  // A rejected effort level degrades to the nearest lower one.
  assert.equal(
    modelParams(catalogModel, 'max')?.find((p) => p.id === 'effort')?.value,
    'xhigh',
  )
})

test('reasoning info lists offered levels with off when available', () => {
  const info = reasoningInfo(catalogModel)
  assert.deepEqual(
    info?.efforts.map((effort) => effort.id),
    ['off', 'low', 'medium', 'high', 'xhigh'],
  )
  assert.equal(info?.defaultEffort, 'high')
  assert.equal(reasoningInfo({}), undefined)
})

test('shared display names are disambiguated with the model id', () => {
  const names = modelNames([
    { id: 'default', displayName: 'Auto' },
    { id: 'auto-smart', displayName: 'Auto' },
    { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
  ])
  assert.equal(names.get('default'), 'Auto (default)')
  assert.equal(names.get('auto-smart'), 'Auto (auto-smart)')
  assert.equal(names.get('gpt-5.6-sol'), 'GPT-5.6 Sol')
  assert.equal(resolveModelId('auto'), 'default')
  assert.equal(resolveModelId('claude'), 'claude')
  assert.ok(FALLBACK_MODELS.length > 0)
})
