const DEFAULT_PROVIDER = 'skill-state'
const DEFAULT_MODEL = 'state-model'

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`)
  return value.trim()
}

/**
 * Return the runtime session identity used to isolate gateway state.
 * DeepSeek Harness exposes this as GenerateOptions.sessionId; there is no
 * safe request-local fallback because a generated id would split one agent
 * session across unrelated state cursors.
 */
export function stableSessionId(options) {
  const sessionId = options?.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new TypeError('LLM options must include a stable non-empty sessionId')
  }
  return sessionId.trim()
}

function projectBlock(block) {
  if (!block || typeof block !== 'object' || typeof block.type !== 'string') return { type: 'unknown' }
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return { type: block.type, text: typeof block.text === 'string' ? block.text : '' }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
        arguments: typeof block.arguments === 'string' ? block.arguments : '',
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        tool_call_id: typeof block.toolCallId === 'string' ? block.toolCallId : '',
        content: Array.isArray(block.content) ? block.content.map(projectBlock) : [],
        is_error: block.isError === true,
      }
    case 'image':
      return { type: 'image' }
    default:
      return { type: block.type }
  }
}

/** Project only the latest harness message into the gateway observation slot. */
export function latestObservationFromMessages(messages) {
  if (!Array.isArray(messages)) return { type: 'turn-start' }
  const message = [...messages].reverse().find(item => item && typeof item === 'object')
  if (!message) return { type: 'turn-start' }
  return {
    type: 'message',
    role: typeof message.role === 'string' ? message.role : 'unknown',
    content: Array.isArray(message.content) ? message.content.map(projectBlock) : [],
  }
}

/** Project the newest tool result separately for the gateway observation extractor. */
export function latestToolResultFromMessages(messages) {
  if (!Array.isArray(messages)) return undefined
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) continue
    for (const block of [...message.content].reverse()) {
      if (block?.type === 'tool-result') return projectBlock(block)
    }
  }
  return undefined
}

function gatewayEndpoint(baseUrl) {
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError('gatewayBaseUrl must use http or https')
  if (parsed.username || parsed.password) throw new TypeError('gatewayBaseUrl must not contain credentials')
  const basePath = parsed.pathname.replace(/\/+$/u, '')
  parsed.pathname = basePath.endsWith('/v1') ? `${basePath}/chat/completions` : `${basePath}/v1/chat/completions`
  parsed.search = ''
  parsed.hash = ''
  return parsed
}

/** Validate adapter settings once, before a provider route is registered. */
export function normalizeConfig(config = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('adapter config must be an object')
  const gatewayBaseUrl = nonEmptyString(config.gatewayBaseUrl, 'gatewayBaseUrl')
  gatewayEndpoint(gatewayBaseUrl)
  const provider = config.provider === undefined ? DEFAULT_PROVIDER : nonEmptyString(config.provider, 'provider')
  const model = config.model === undefined ? DEFAULT_MODEL : nonEmptyString(config.model, 'model')
  const apiKeyEnv = config.apiKeyEnv === undefined ? undefined : nonEmptyString(config.apiKeyEnv, 'apiKeyEnv')
  const suppliedApiKey = config.apiKey === undefined
    ? apiKeyEnv === undefined ? undefined : process.env[apiKeyEnv]
    : config.apiKey
  const apiKey = suppliedApiKey === undefined ? undefined : nonEmptyString(suppliedApiKey, 'apiKey')
  return Object.freeze({
    gatewayBaseUrl,
    provider,
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
  })
}

function addControl(controls, key, value) {
  if (value !== undefined) controls[key] = value
}

/** Build the gateway request without forwarding conversation history or tools. */
export function buildGatewayRequest(options, config) {
  const normalized = normalizeConfig(config)
  if (!options || typeof options !== 'object') throw new TypeError('LLM options must be an object')
  const sessionId = stableSessionId(options)
  const toolResult = latestToolResultFromMessages(options.messages)
  const controls = {}
  addControl(controls, 'temperature', options.temperature)
  addControl(controls, 'max_tokens', options.maxTokens)
  addControl(controls, 'stop', Array.isArray(options.stop) ? [...options.stop] : undefined)
  addControl(controls, 'reasoning_effort', options.reasoningEffort)
  addControl(controls, 'purpose', options.purpose)
  const headers = {
    accept: 'text/event-stream, application/json',
    'content-type': 'application/json',
    'x-skill-state-session': sessionId,
  }
  if (normalized.apiKey !== undefined) headers.authorization = `Bearer ${normalized.apiKey}`
  return {
    url: gatewayEndpoint(normalized.gatewayBaseUrl).toString(),
    headers,
    body: {
      model: typeof options.model === 'string' && options.model.length > 0 ? options.model : normalized.model,
      session_id: sessionId,
      latest_observation: latestObservationFromMessages(options.messages),
      ...(toolResult === undefined ? {} : { tool_result: toolResult }),
      stream: true,
      controls,
    },
  }
}

/** Yield complete SSE data fields from a WHATWG or Node readable body. */
export async function* readSseData(body) {
  if (!body) throw new Error('provider response did not include a body')
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines = []
  const flush = function* () {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n')
    dataLines = []
    yield data
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') {
        yield* flush()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
  }
  buffer += decoder.decode()
  if (buffer !== '') {
    const line = buffer.replace(/\r$/u, '')
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  yield* flush()
}

export function parseProviderPayload(data) {
  if (data === '[DONE]') return { done: true }
  try {
    const value = JSON.parse(data)
    return value && typeof value === 'object' ? value : { invalid: true }
  } catch {
    return { invalid: true }
  }
}

export function mapFinishReason(value) {
  if (value === 'tool_calls') return { kind: 'tool-calls' }
  if (value === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

export function usageFromProvider(value) {
  if (!value || typeof value !== 'object') return undefined
  const inputTokens = Number(value.prompt_tokens)
  const outputTokens = Number(value.completion_tokens)
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined
  const total = Number(value.total_tokens)
  const cached = Number(value.prompt_tokens_details?.cached_tokens)
  return {
    inputTokens,
    outputTokens,
    ...(Number.isFinite(total) ? { totalTokens: total } : {}),
    ...(Number.isFinite(cached) && cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}

export function extractChoice(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : []
  return choices[0] && typeof choices[0] === 'object' ? choices[0] : {}
}
