import { SkillStateLlmAdapter } from './adapter.mjs'
import { latestObservationFromMessages, normalizeConfig, stableSessionId } from './protocol.mjs'

export { SkillStateLlmAdapter } from './adapter.mjs'
export * from './protocol.mjs'

/**
 * Register the adapter on the real DeepSeek Harness LlmRuntime seam.
 * @param {import('@deepseek-ai/dsh-llm').LlmRuntime} runtime - live `ctx.llm` service.
 * @param {Record<string, unknown>} config - gateway-backed adapter settings.
 * @returns {import('@deepseek-ai/dsh-llm').AdapterRegistrationHandle} reversible route registration.
 */
export function registerSkillStateAdapter(runtime, config) {
  const normalized = normalizeConfig(config)
  return runtime.registerAdapter([normalized.provider], new SkillStateLlmAdapter(normalized))
}

/**
 * Install the provider and an observation listener on a Cordis context.
 * The listener delegates every stream to `next()` and never replaces the provider path.
 */
export function applySkillStateLlmPlugin(ctx, config) {
  const normalized = normalizeConfig(config)
  const registration = registerSkillStateAdapter(ctx.llm, normalized)
  const observe = typeof config.onObservation === 'function' ? config.onObservation : undefined
  const disposeObservation = ctx.on('llm/stream', async function* (options, next) {
    const sessionId = stableSessionId(options)
    if (observe !== undefined) {
      try {
        await observe({
          kind: 'model-request',
          provider: options.provider,
          model: options.model,
          latestObservation: latestObservationFromMessages(options.messages),
          sessionId,
          purpose: options.purpose,
        })
      } catch {
        // Observability cannot veto a model request; the gateway remains mandatory.
      }
    }
    for await (const chunk of next()) yield chunk
  })
  return () => {
    disposeObservation?.()
    registration()
  }
}

export default applySkillStateLlmPlugin
