import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGatewayRequest,
  latestObservationFromMessages,
  mapFinishReason,
  normalizeConfig,
  usageFromProvider,
} from '../src/protocol.mjs'

test('normalizes a gateway-backed route without a credential', () => {
  assert.deepEqual(normalizeConfig({ gatewayBaseUrl: 'http://127.0.0.1:8787/v1' }), {
    gatewayBaseUrl: 'http://127.0.0.1:8787/v1',
    provider: 'skill-state',
    model: 'state-model',
  })
})

test('rejects gateway URLs containing credentials', () => {
  assert.throws(() => normalizeConfig({ gatewayBaseUrl: 'http://user:secret@example.test' }), /must not contain credentials/)
})

test('builds a request with latest observation and no transcript fields', () => {
  const request = buildGatewayRequest({
    provider: 'skill-state',
    model: 'state-model',
    temperature: 0.2,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    system: 'must stay outside the gateway request',
    tools: [{ name: 'hidden', description: 'hidden', parameters: {} }],
  }, normalizeConfig({ gatewayBaseUrl: 'http://127.0.0.1:8787/v1' }))

  assert.equal(request.url, 'http://127.0.0.1:8787/v1/chat/completions')
  assert.equal(request.body.latest_observation.content[0].text, 'hello')
  assert.equal('messages' in request.body, false)
  assert.equal('system' in request.body, false)
  assert.equal('tools' in request.body, false)
})

test('maps usage and terminal finish reasons', () => {
  assert.deepEqual(usageFromProvider({
    prompt_tokens: 4,
    completion_tokens: 3,
    total_tokens: 7,
    prompt_tokens_details: { cached_tokens: 2 },
  }), {
    inputTokens: 4,
    outputTokens: 3,
    totalTokens: 7,
    cacheReadTokens: 2,
  })
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' })
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' })
})

test('projects the latest message only', () => {
  const observation = latestObservationFromMessages([
    { role: 'user', content: [{ type: 'text', text: 'old' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'new' }] },
  ])
  assert.equal(observation.content[0].text, 'new')
})
