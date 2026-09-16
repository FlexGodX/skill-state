import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const PROVIDER_ID = 'skill-state'
const MODEL_ID = 'state-model'
const OBSERVATION_SCHEMA = 'skill-state.observation.v1'

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.length > 0)
}

function requiredSessionId(input) {
  const sessionID = input?.sessionID
  if (typeof sessionID !== 'string' || sessionID.trim() === '') {
    throw new Error('skill-state: OpenCode chat.headers requires a non-empty input.sessionID')
  }
  return sessionID.trim()
}

function shouldObserve(eventType) {
  return typeof eventType === 'string'
    && (eventType.startsWith('session.') || eventType.includes('tool'))
}

function eventObservation(event, fallback = {}) {
  const properties = event?.properties && typeof event.properties === 'object' ? event.properties : {}
  return {
    schema: OBSERVATION_SCHEMA,
    kind: event?.type?.includes('tool') ? 'tool' : 'session',
    phase: event?.type ?? 'event',
    observed_at: new Date().toISOString(),
    session_id: firstString(properties.sessionID, properties.session_id, fallback.sessionID),
    tool_name: firstString(properties.tool, properties.toolName, fallback.tool),
    call_id: firstString(properties.callID, properties.call_id, fallback.callID),
  }
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

async function persistObservation(observation) {
  const sink = process.env.SKILL_STATE_OBSERVATION_SINK ?? '.skill-state/observations.ndjson'
  if (/^https?:\/\//u.test(sink)) {
    const response = await fetch(sink, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(observation),
    })
    if (!response.ok) throw new Error(`observation sink returned HTTP ${response.status}`)
    return
  }
  const path = resolve(process.cwd(), sink)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(observation)}\n`, 'utf8')
}

function createObservationWriter() {
  let tail = Promise.resolve()
  return observation => {
    tail = tail
      .then(() => persistObservation(observation))
      .catch(error => console.error(`skill-state observation sink unavailable: ${error.message}`))
  }
}

/**
 * OpenCode plugin for provider registration and session/tool observation hooks.
 * Provider requests remain routed through the configured skill-state gateway.
 */
export const SkillStatePlugin = async () => {
  const writeObservation = createObservationWriter()
  return {
    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        if (provider?.models?.[MODEL_ID]) return {}
        return {
          [MODEL_ID]: {
            id: MODEL_ID,
            name: 'skill-state model',
            reasoning: false,
            tool_call: false,
            attachment: false,
            limit: { context: 8192, output: 2048 },
            modalities: { input: ['text'], output: ['text'] },
          },
        }
      },
    },
    event: async ({ event }) => {
      if (shouldObserve(event?.type)) writeObservation(removeUndefined(eventObservation(event)))
    },
    'chat.message': async (input) => {
      writeObservation(removeUndefined({
        ...eventObservation({ type: 'session.message' }, input),
        message_id: input.messageID,
      }))
    },
    'tool.execute.before': async (input) => {
      writeObservation(removeUndefined({
        ...eventObservation({ type: 'tool.before' }, input),
        phase: 'before',
      }))
    },
    'tool.execute.after': async (input) => {
      writeObservation(removeUndefined({
        ...eventObservation({ type: 'tool.after' }, input),
        phase: 'after',
      }))
    },
    'chat.headers': async (input, output) => {
      const sessionID = requiredSessionId(input)
      if (!output || typeof output.headers !== 'object' || output.headers === null) {
        throw new Error('skill-state: OpenCode chat.headers requires output.headers')
      }
      // OpenCode owns the provider request body, including serialized tool
      // results. This hook only adds routing metadata and never moves results
      // into headers or the observation sink, so gateway O extraction remains
      // body-backed.
      output.headers['x-skill-state-provider'] = PROVIDER_ID
      output.headers['x-skill-state-session'] = sessionID
    },
  }
}

export default SkillStatePlugin
