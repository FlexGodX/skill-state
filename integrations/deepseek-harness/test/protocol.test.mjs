import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildGatewayRequest,
  gatewayErrorDiagnostic,
  latestObservationFromMessages,
  latestToolResultFromMessages,
  mapFinishReason,
  normalizeConfig,
  stableSessionId,
  readGatewayErrorMetadata,
  usageFromProvider,
} from '../src/protocol.mjs'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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
    sessionId: 'dsh-session-1',
    temperature: 0.2,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    system: 'must stay outside the gateway request',
    tools: [{ name: 'hidden', description: 'hidden', parameters: {} }],
  }, normalizeConfig({ gatewayBaseUrl: 'http://127.0.0.1:8787/v1' }))

  assert.equal(request.url, 'http://127.0.0.1:8787/v1/chat/completions')
  assert.equal(request.headers['x-skill-state-session'], 'dsh-session-1')
  assert.equal(request.body.session_id, 'dsh-session-1')
  assert.equal(request.body.latest_observation.content[0].text, 'hello')
  assert.equal('messages' in request.body, false)
  assert.equal('system' in request.body, false)
  assert.equal('tools' in request.body, false)
})

test('isolates requests by stable session header without a generated fallback', () => {
  const config = normalizeConfig({ gatewayBaseUrl: 'http://127.0.0.1:8787/v1' })
  const first = buildGatewayRequest({ sessionId: 'session-a', messages: [] }, config)
  const second = buildGatewayRequest({ sessionId: 'session-b', messages: [] }, config)
  assert.equal(first.headers['x-skill-state-session'], 'session-a')
  assert.equal(second.headers['x-skill-state-session'], 'session-b')
  assert.equal(first.body.session_id, 'session-a')
  assert.equal(second.body.session_id, 'session-b')
  assert.throws(() => stableSessionId({}), /stable non-empty sessionId/)
  assert.throws(() => buildGatewayRequest({ messages: [] }, config), /stable non-empty sessionId/)
})

test('keeps the newest tool result as a top-level gateway observation', () => {
  const toolResult = {
    type: 'tool-result',
    toolCallId: 'call-1',
    content: [{ type: 'text', text: 'done' }],
    isError: false,
  }
  const messages = [{ role: 'user', content: [toolResult] }]
  const request = buildGatewayRequest({ sessionId: 'session-tools', messages }, normalizeConfig({
    gatewayBaseUrl: 'http://127.0.0.1:8787/v1',
  }))
  assert.deepEqual(latestToolResultFromMessages(messages), {
    type: 'tool-result',
    tool_call_id: 'call-1',
    content: [{ type: 'text', text: 'done' }],
    is_error: false,
  })
  assert.deepEqual(request.body.tool_result, {
    type: 'tool-result',
    tool_call_id: 'call-1',
    content: [{ type: 'text', text: 'done' }],
    is_error: false,
  })
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

test('extracts only safe gateway error metadata and never body messages', async () => {
  const response = new Response(JSON.stringify({
    error: {
      message: 'prompt text must never appear in adapter diagnostics',
      type: 'gateway_error',
      code: 'invalid_structured_output',
      request_id: 'request-1',
    },
  }), {
    status: 502,
    headers: { 'content-type': 'application/json' },
  })

  assert.deepEqual(await readGatewayErrorMetadata(response), {
    code: 'invalid_structured_output',
    category: 'gateway_error',
  })
  assert.equal(gatewayErrorDiagnostic(502, await readGatewayErrorMetadata(response)),
    'status=502, code=invalid_structured_output, category=gateway_error')
  assert.doesNotMatch(gatewayErrorDiagnostic(502, await readGatewayErrorMetadata(response)), /prompt text/u)
})

test('drops malformed or oversized gateway metadata', async () => {
  const malformed = new Response(JSON.stringify({
    error: { message: 'hidden', type: 'gateway error', code: 'bad code' },
  }), { status: 400 })
  assert.deepEqual(await readGatewayErrorMetadata(malformed), {})

  const oversized = new Response(JSON.stringify({
    error: { message: 'hidden', type: 'gateway_error', code: 'valid', padding: 'x'.repeat(16 * 1024) },
  }), { status: 500 })
  assert.deepEqual(await readGatewayErrorMetadata(oversized), {})
})

test('projects the latest message only', () => {
  const observation = latestObservationFromMessages([
    { role: 'user', content: [{ type: 'text', text: 'old' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'new' }] },
  ])
  assert.equal(observation.content[0].text, 'new')
})

test('declares a DSH bundle patch that mounts the session-bound adapter', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.files, [
    'src',
    'cordis.patch.yml',
    'config.example.json',
    'README.md',
    'package.json',
  ])

  const patch = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
  const plugin = readFileSync(join(PACKAGE_ROOT, 'src/index.mjs'), 'utf8')
  assert.match(plugin, /export const inject = \['llm'\]/u)
  assert.match(plugin, /applySkillStateLlmPlugin\.inject = inject/u)
  assert.match(patch, /id: skill-state-llm/u)
  assert.match(patch, /name: '@skill-state\/deepseek-harness-adapter'/u)
  assert.match(patch, /gatewayBaseUrl: !!js process\.env\.SKILL_STATE_GATEWAY_URL/u)
  assert.match(patch, /apiKeyEnv: SKILL_STATE_GATEWAY_API_KEY/u)
})
