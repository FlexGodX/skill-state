import test from 'node:test'
import assert from 'node:assert/strict'

import { allowHookResult, createObservation } from '../hooks/observe.mjs'

test('projects session lifecycle payloads without absolute workspace paths', () => {
  const observation = createObservation('SessionStart', {
    session_id: 'session-1',
    cwd: '/private/user/worktree',
  }, '2026-09-16T00:00:00.000Z')

  assert.deepEqual(observation, {
    schema: 'skill-state.observation.v1',
    kind: 'session',
    phase: 'start',
    observed_at: '2026-09-16T00:00:00.000Z',
    session_id: 'session-1',
  })
})

test('projects tool lifecycle identity and status', () => {
  const observation = createObservation('PostToolUse', {
    sessionID: 'session-1',
    toolName: 'read',
    callID: 'call-1',
    tool_response: { status: 'success', output: 'hidden by default' },
  })

  assert.equal(observation.kind, 'tool')
  assert.equal(observation.phase, 'after')
  assert.equal(observation.status, 'ok')
  assert.equal(observation.tool_name, 'read')
  assert.equal('tool_response' in observation, false)
})

test('hook output always permits the observed host action', () => {
  assert.deepEqual(JSON.parse(allowHookResult()), { decision: 'allow' })
})
