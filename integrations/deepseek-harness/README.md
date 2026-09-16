# DeepSeek Harness adapter

This patchable package uses the actual DeepSeek Harness LLM seam: `SkillStateLlmAdapter` extends
`LlmAdapter`, `registerSkillStateAdapter()` calls `ctx.llm.registerAdapter()`, and
`applySkillStateLlmPlugin()` observes the `llm/stream` waterfall while delegating to `next()`.

The adapter requires `gatewayBaseUrl` at construction and sends the route only to the gateway's
OpenAI-compatible `/v1/chat/completions` endpoint. Every `GenerateOptions` value must contain the
stable DeepSeek Harness `sessionId`; the adapter fails closed when it is absent and sends that same
value in the `x-skill-state-session` header and `session_id` body field. It forwards the latest harness
message as `latest_observation` plus generation controls; conversation history, system text, and tool
schemas do not cross the gateway state boundary. A newest `tool-result` block is also copied to the
top-level `tool_result` body field so the gateway extracts it as the latest observation `O`. A missing
or invalid gateway URL fails before route registration, so a configured adapter cannot silently fall
back to a direct upstream provider.

The package declares peer dependencies instead of installing or changing a DeepSeek Harness checkout.
Copy or link `src/` into a harness composition that already provides `@deepseek-ai/dsh-llm` and
`@deepseek-ai/cordis`. `config.example.json` contains the environment-based settings template;
`apiKeyEnv` is resolved by the adapter only when the named variable is present.

The adapter translates OpenAI JSON/SSE deltas into `StreamChunk` values, buffers terminal usage until
all blocks close, and emits one final `finish`. It does not carry a provider key in source files.
