import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

import {
  buildGatewayRequest,
  extractChoice,
  mapFinishReason,
  normalizeConfig,
  parseProviderPayload,
  readSseData,
  usageFromProvider,
} from './protocol.mjs'

function responseError(message, response) {
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-gateway-request-id')
  return new LlmError(message, 'PROVIDER_HTTP', {
    status: response.status,
    ...(requestId ? { requestId } : {}),
  })
}

function textContent(payload) {
  const choice = extractChoice(payload)
  const content = choice.message?.content
  return typeof content === 'string' ? content : ''
}

function toolCallDelta(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return undefined
  const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {}
  const id = typeof toolCall.id === 'string' ? toolCall.id : ''
  const args = typeof fn.arguments === 'string' ? fn.arguments : ''
  const name = typeof fn.name === 'string' ? fn.name : undefined
  if (id === '' && args === '' && name === undefined) return undefined
  return {
    index: Number.isInteger(toolCall.index) ? toolCall.index : 0,
    id,
    ...(name === undefined ? {} : { name }),
    argumentsDelta: args,
  }
}

/** LlmAdapter that can reach the model only through the skill-state gateway. */
export class SkillStateLlmAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = normalizeConfig(config)
  }

  providerInfo(provider) {
    if (provider !== this.config.provider) throw new Error(`unknown skill-state provider route: ${provider}`)
    return { id: provider, name: 'skill-state gateway' }
  }

  async *stream(options) {
    let request
    try {
      request = buildGatewayRequest(options, this.config)
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('stable non-empty sessionId')) {
        throw new LlmError(error.message, 'INVALID_SESSION', { cause: error })
      }
      throw error
    }
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: options.signal,
    })
    if (!response.ok) throw responseError('skill-state gateway rejected the model request', response)

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      let payload
      try {
        payload = await response.json()
      } catch (error) {
        throw new LlmError('skill-state gateway returned invalid JSON', 'INVALID_PROVIDER_RESPONSE', { cause: error })
      }
      const text = textContent(payload)
      if (text !== '') yield { type: 'block-start', index: 0, blockType: 'text' }
      if (text !== '') yield { type: 'text-delta', index: 0, text }
      if (text !== '') yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      const usage = usageFromProvider(payload.usage)
      if (usage !== undefined) yield { type: 'usage', usage }
      yield {
        type: 'finish',
        reason: mapFinishReason(extractChoice(payload).finish_reason),
        ...(payload.id ? { replayState: { response: { id: payload.id } } } : {}),
      }
      return
    }

    let text = ''
    let reasoning = ''
    let textStarted = false
    let reasoningStarted = false
    let nextBlockIndex = 0
    let textIndex
    let reasoningIndex
    let finishReason = 'stop'
    let usage
    let responseId
    const toolCalls = new Map()
    for await (const data of readSseData(response.body)) {
      const payload = parseProviderPayload(data)
      if (payload.done) break
      if (payload.invalid) throw new LlmError('skill-state gateway returned invalid SSE data', 'INVALID_PROVIDER_RESPONSE')
      responseId ??= typeof payload.id === 'string' ? payload.id : undefined
      usage ??= usageFromProvider(payload.usage)
      const choice = extractChoice(payload)
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
      const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {}
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (!textStarted) {
          textStarted = true
          textIndex = nextBlockIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        text += delta.content
        yield { type: 'text-delta', index: textIndex, text: delta.content }
      }
      const reasoningText = typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' ? delta.reasoning : ''
      if (reasoningText !== '') {
        if (!reasoningStarted) {
          reasoningStarted = true
          reasoningIndex = nextBlockIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        reasoning += reasoningText
        yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoningText }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const rawToolCall of delta.tool_calls) {
          const toolCall = toolCallDelta(rawToolCall)
          if (toolCall === undefined) continue
          const current = toolCalls.get(toolCall.index) ?? {
            index: nextBlockIndex++,
            id: toolCall.id,
            name: toolCall.name ?? '',
            arguments: '',
          }
          if (!toolCalls.has(toolCall.index)) yield { type: 'block-start', index: current.index, blockType: 'tool-call' }
          current.id ||= toolCall.id
          current.name ||= toolCall.name ?? ''
          current.arguments += toolCall.argumentsDelta
          toolCalls.set(toolCall.index, current)
          yield {
            type: 'tool-call-delta',
            index: current.index,
            id: current.id,
            ...(toolCall.name === undefined ? {} : { name: toolCall.name }),
            argumentsDelta: toolCall.argumentsDelta,
          }
        }
      }
    }
    if (textStarted) yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
    if (reasoningStarted) yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } }
    for (const toolCall of toolCalls.values()) {
      yield {
        type: 'block-end',
        index: toolCall.index,
        block: { type: 'tool-call', id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
      }
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield {
      type: 'finish',
      reason: mapFinishReason(finishReason),
      ...(responseId ? { replayState: { response: { id: responseId } } } : {}),
    }
  }
}
