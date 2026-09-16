# Compatibility matrix

The matrix describes repository contracts and tested seams. A provider or
client version not listed here may still work, but its request and hook
signatures should be checked before deployment.

| Surface | Contract in this repository | Compatibility note |
| --- | --- | --- |
| Node.js | `>=20` for the root, core, gateway, adapters, and plugin hooks | Uses native ESM, `fetch`, `Response`, and Node test APIs |
| npm | Workspace install from the root `package.json` | No lockfile is required by the source tree; CI installs declared ranges |
| Core | `@skill-state/core` `0.1.x`; TypeScript source with strict project settings | Required runtime dependency of the gateway; exposes `createSkillStateCore`, trusted `procedure`/`procedureHash`, `prepareCall`, and `commitResponse` |
| Gateway | `@skill-state/gateway` `0.1.x`, depending on `@skill-state/core` `0.1.0` | Supports `/v1/chat/completions` and `/v1/responses`; resolves trusted procedure at startup, requires a prepare/commit boundary, and buffers streams for validation |
| Trusted procedure | `createGateway({ procedure })`, `createSkillStateCore({ procedure })`, `SKILL_STATE_PROCEDURE`, or `SKILL_STATE_PROCEDURE_FILE` | Required in production; `allowTestProcedureDefault: true` is test-only; client request fields cannot override it |
| Procedure identity | Stable SHA-256 `procedureHash` bound to each session and action record | A changed procedure or mismatched commit fails with `PROCEDURE_CONFLICT` |
| Provider upstream | OpenAI-compatible JSON or SSE response carrying structured `{state_patch, action}` text | Model IDs and upstream features are deployment-specific |
| Action lifecycle | Core commits the patch and records a pending action; host executes it and returns `action_result`/`tool_result` as the next latest observation | Core does not execute external side effects |
| Codex CLI | Custom provider TOML using `wire_api = "responses"` and the gateway `/v1` base URL | Codex Desktop subscription auth does not authorize an arbitrary custom provider |
| Codex plugin | Manifest with `skills` plus companion `hooks/hooks.json` | The manifest must not add an unsupported `hooks` field; hook host discovery is product-specific |
| OpenCode | Provider fragment using `@ai-sdk/openai-compatible`; local plugin hooks | The plugin follows the OpenCode 1.x hook shape; re-check signatures when moving across major versions |
| DeepSeek Harness | `LlmAdapter` registration through `ctx.llm`/`LlmRuntime` and `llm/stream` delegation | The host must provide the Harness packages; this repository does not modify a Harness checkout |
| Benchmark | `skill-state-bench` package, explicitly invoked | Offline aggregation is the default; live execution requires an explicit runner and `--live` |

“Compatible” means that the local protocol and adapter tests pass. It does
not mean that a model follows the structured output contract without a system
prompt or response-format control. Validate the target provider with a health
check and a real, non-sensitive test session before using it for production
state.

## API stability

The repository is pre-1.0. The `p+sigma+latest-o/v1` descriptor and gateway
route names are the current integration contract, but the core and adapter
packages may change until a stable release process is published. Pin a
checkout or package version in deployments and run the integration tests when
upgrading.
