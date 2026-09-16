#!/usr/bin/env node

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { argv, stdin, stdout } from 'node:process'
import { pathToFileURL } from 'node:url'

const OBSERVATION_SCHEMA = 'skill-state.observation.v1'

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.length > 0)
}

function eventPhase(eventName) {
  switch (eventName) {
    case 'SessionStart': return 'start'
    case 'SessionEnd': return 'end'
    case 'PreToolUse': return 'before'
    case 'PostToolUse': return 'after'
    default: return 'event'
  }
}

function eventKind(eventName) {
  return eventName === 'PreToolUse' || eventName === 'PostToolUse' ? 'tool' : 'session'
}

function primitiveStatus(value) {
  if (typeof value === 'boolean') return value ? 'ok' : 'error'
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'ok' || normalized === 'success' || normalized === 'succeeded') return 'ok'
  if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') return 'error'
  return undefined
}

/**
 * Project one host hook payload into the stable observation envelope.
 * Tool payloads stay out of the record unless explicitly enabled by the caller.
 */
export function createObservation(eventName, input, observedAt = new Date().toISOString()) {
  const payload = input && typeof input === 'object' ? input : {}
  const toolResponse = payload.tool_response ?? payload.toolResponse ?? payload.output
  const observation = {
    schema: OBSERVATION_SCHEMA,
    kind: eventKind(eventName),
    phase: eventPhase(eventName),
    observed_at: observedAt,
    session_id: firstString(payload.session_id, payload.sessionID, payload.session?.id),
    tool_name: firstString(payload.tool_name, payload.toolName, payload.tool?.name),
    call_id: firstString(payload.tool_call_id, payload.call_id, payload.callID),
  }
  const status = primitiveStatus(
    payload.status
      ?? payload.tool_status
      ?? (toolResponse && typeof toolResponse === 'object' ? toolResponse.status : undefined)
      ?? (toolResponse && typeof toolResponse === 'object' ? toolResponse.is_error : undefined),
  )
  if (status !== undefined) observation.status = status

  if (process.env.SKILL_STATE_CAPTURE_TOOL_PAYLOADS === '1') {
    const toolInput = payload.tool_input ?? payload.toolInput ?? payload.input
    if (toolInput !== undefined) observation.tool_input = toolInput
    if (toolResponse !== undefined) observation.tool_response = toolResponse
  }
  return removeUndefined(observation)
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

async function readStdin() {
  let text = ''
  for await (const chunk of stdin) text += chunk
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return { parse_error: true }
  }
}

async function postObservation(url, observation) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(observation),
  })
  if (!response.ok) throw new Error(`observation sink returned HTTP ${response.status}`)
}

/**
 * Persist an observation to a file or an explicitly configured HTTP sink.
 * The default path is relative to the host process working directory.
 */
export async function writeObservation(observation) {
  const sink = process.env.SKILL_STATE_OBSERVATION_SINK ?? '.skill-state/observations.ndjson'
  if (/^https?:\/\//u.test(sink)) {
    await postObservation(sink, observation)
    return sink
  }
  const path = resolve(process.cwd(), sink)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(observation)}\n`, 'utf8')
  return path
}

export function allowHookResult() {
  return JSON.stringify({ decision: 'allow' })
}

async function main() {
  const eventIndex = argv.indexOf('--event')
  const eventName = eventIndex >= 0 ? argv[eventIndex + 1] ?? 'Unknown' : 'Unknown'
  const observation = createObservation(eventName, await readStdin())
  try {
    await writeObservation(observation)
  } catch (error) {
    // Observation failures must not block the user's session or tool call.
    console.error(`skill-state observation sink unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  stdout.write(`${allowHookResult()}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
