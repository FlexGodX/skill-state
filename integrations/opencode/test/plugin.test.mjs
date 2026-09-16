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

test('chat.headers propagates the actual OpenCode sessionID', async () => {
  const hooks = await SkillStatePlugin({})
  const first = { headers: { existing: 'keep' } }
  const second = { headers: {} }
  await hooks['chat.headers']({ sessionID: 'opencode-session-a' }, first)
  await hooks['chat.headers']({ sessionID: 'opencode-session-b' }, second)
  assert.equal(first.headers['x-skill-state-provider'], 'skill-state')
  assert.equal(second.headers['x-skill-state-provider'], 'skill-state')
  assert.equal(first.headers['x-skill-state-session'], 'opencode-session-a')
  assert.equal(second.headers['x-skill-state-session'], 'opencode-session-b')
  assert.equal(first.headers.existing, 'keep')
})

test('chat.headers fails clearly without sessionID and leaves provider body untouched', async () => {
  const hooks = await SkillStatePlugin({})
  const toolBody = { messages: [{ role: 'tool', content: 'tool result' }] }
  const output = { headers: { existing: 'keep' }, body: toolBody }
  await assert.rejects(
    hooks['chat.headers']({ sessionID: '' }, output),
    /requires a non-empty input\.sessionID/,
  )
  assert.deepEqual(output, { headers: { existing: 'keep' }, body: toolBody })
})
