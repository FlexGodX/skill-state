import test from 'node:test'
import assert from 'node:assert/strict'

import SkillStatePlugin, { SkillStatePlugin as NamedSkillStatePlugin } from '../skill-state.plugin.mjs'

test('exports the OpenCode plugin as named and default functions', async () => {
  assert.equal(SkillStatePlugin, NamedSkillStatePlugin)
  const hooks = await SkillStatePlugin({})
  assert.equal(typeof hooks.provider.models, 'function')
  assert.equal(typeof hooks.event, 'function')
  assert.equal(typeof hooks['tool.execute.before'], 'function')
  assert.equal(typeof hooks['tool.execute.after'], 'function')
})

test('provider hook fills the configured model when absent', async () => {
  const hooks = await SkillStatePlugin({})
  const models = await hooks.provider.models({ models: {} }, {})
  assert.equal(models['state-model'].id, 'state-model')
})

test('provider hook preserves an explicit model', async () => {
  const hooks = await SkillStatePlugin({})
  const models = await hooks.provider.models({ models: { 'state-model': {} } }, {})
  assert.deepEqual(models, {})
})
