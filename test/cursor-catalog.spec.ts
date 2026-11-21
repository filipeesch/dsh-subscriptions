import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FALLBACK_MODELS,
  catalogSignature,
  defsOf,
  sameModelIds,
  modelNames,
  resolveModelId,
  values,
} from '../src/providers/cursor/catalog.js'

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

test('parameter definitions read from either catalog or request spelling', () => {
  const parameters = [{ id: 'context', values: [{ value: '200k' }, '1m'] }]
  assert.deepEqual(defsOf({ parameters }), parameters)
  assert.deepEqual(defsOf({ cursorParameters: parameters }), parameters)
  assert.deepEqual(defsOf(undefined), [])
  assert.deepEqual(values(parameters[0]), ['200k', '1m'])
  assert.deepEqual(values(undefined), [])
  // A definition without values offers nothing rather than throwing.
  assert.deepEqual(values({ id: 'thinking' }), [])
})

test('catalog id sets compare order-insensitively', () => {
  assert.equal(sameModelIds(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameModelIds(['a'], ['a', 'b']), false)
  assert.equal(sameModelIds([], []), true)
})

test('the picker signature covers names and parameter definitions', () => {
  const first = [
    {
      id: 'm',
      displayName: 'First',
      parameters: [{ id: 'effort', values: [{ value: 'low' }] }],
    },
  ]
  assert.equal(catalogSignature(first), catalogSignature([...first]))
  const renamed = [{ ...first[0], displayName: 'Second' }]
  const moreEffort = [
    {
      ...first[0],
      parameters: [
        { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] },
      ],
    },
  ]
  assert.notEqual(catalogSignature(first), catalogSignature(renamed))
  assert.notEqual(catalogSignature(first), catalogSignature(moreEffort))
})
