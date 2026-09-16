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

## DSH profile bundle

The package declares `dsh.bundle.patch`, so `dsh plugin` can install it as a
profile layer instead of mounting the built-in pi-ai route. The layer registers
`skill-state-llm`, which always calls the local gateway and propagates the
stable `GenerateOptions.sessionId` as `x-skill-state-session` and `session_id`.

Keep the existing DSH home/default intact by using a separate profile home:

```sh
export DSH_HOME="$HOME/.dsh-skill-state"
dsh plugin --profile skill-state add --workspace-root \
  @deepseek-ai/dsh-headless@0.1.2-alpha.2 \
  file:/absolute/path/to/skill-state/integrations/deepseek-harness
```

The package layer defaults to `http://127.0.0.1:8787/v1` and `state-model`.
Set `SKILL_STATE_GATEWAY_URL`, `SKILL_STATE_MODEL`, and optionally
`SKILL_STATE_GATEWAY_API_KEY` before launching. Add this `agent-default-model`
entry to `$DSH_HOME/profiles/skill-state/cordis.patch.yml`, selecting the model
loaded in LM Studio:

```yaml
- id: agent-default-model
  config:
    provider: skill-state
    model: qwen/qwen3.5-9b
```

The existing `~/.dsh` home and its LM Studio selection are not changed.
