# Provider gateway

This package exposes an OpenAI-compatible provider gateway for
`/v1/chat/completions` and `/v1/responses`. It depends on the local
`@skill-state/core` package for the mandatory state read/commit boundary and
uses the platform `fetch`/HTTP APIs without adding a second HTTP stack.

## State boundary

Every model call must go through the injected core boundary. The gateway sends
the core only a request descriptor and one `latestObservation`; it never passes
the incoming `messages`, `input`, or `previous_response_id` to the core or to
the provider, including when those keys are nested in controls/metadata. A
core implementation must expose `prepareCall` or `buildContext`, plus
`commitResponse` (or the explicit `commitState` alias):

```js
async prepareCall({
  protocol: "p+sigma+latest-o/v1",
  endpoint: "/v1/chat/completions" | "/v1/responses",
  model,
  latestObservation,
  request: { stream, controls }
}) {
  return {
    projection: /* P */ {},
    sigma: /* Σ */ {},
    latestObservation: /* O */ latestObservation,
    prompt: "canonical model input built from P + Σ + O"
  };
}
```

`buildContext` is accepted as an equivalent method. A result without structured
projection/sigma values or a commit method fails before the provider is called;
there is no prompt-only fallback.

Every production request must carry a stable session id. The gateway resolves it
in this order: `x-skill-state-session`, the provider-stable `session-id` and
`thread-id` headers, body `session_id`/`sessionId` (with the legacy
`state_session_id` alias), `metadata.skill_state_session_id`, Codex's proven
`client_metadata.session_id`/`client_metadata.thread_id`, and finally the
documented Responses `conversation` id. Session ids are trimmed, rejected when
empty or containing control characters, and limited to 128 characters. Missing
or invalid ids return an explicit 400 error. `allowTestSessionFallback` is an
explicit `createGateway` test option and must remain disabled in production.
Provider turn/response ids are per-turn values and are never used as sessions.

The provider session sources are consumed as local routing metadata. The
gateway never forwards them, `client_metadata`, `prompt_cache_key`, or any
transcript/state routing field upstream. The Responses `conversation` id is
documented by [the OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
as the conversation identifier; it is used only to bind the local Sigma.

The request's `action_result` and `tool_result` fields take precedence and are
normalized as the latest observation. A final Chat `role: "tool"` message or a
Responses `function_call_output`, `tool_result`, or tool-role item is preferred
over stale user text. `latest_observation` is used when no action/tool result is
present. If none is present, the last user input is treated as the observation.
This is the only client content the core receives. The provider request
preserves the model and supported generation controls, but drops arbitrary
request keys; client `system`, `instructions`, `prompt`, context, session, and
conversation fields cannot override the canonical prompt returned by core.

## Structured response protocol

The provider must return a JSON object with this shape in its assistant text:

```json
{
  "state_patch": {
    "set": { "path": "value" },
    "delete": ["obsolete.path"]
  },
  "action": {
    "type": "send_message",
    "payload": { "text": "hello" }
  }
}
```

`state_patch` is a JSON object. It may be a merge-patch object or use the
optional `set` and `delete` fields shown above. `action` is either `null` or an
object with a non-empty string `type` and optional JSON `payload`. Prototype
keys and excessively deep/large values are rejected. Invalid model output is
returned as an explicit `502 invalid_structured_output`; it is never emitted
as an action.

The gateway accepts both regular JSON provider responses and SSE provider
responses. Streaming is deliberately buffered until the complete provider
output has been parsed and validated. The gateway then emits OpenAI-shaped SSE
events containing the validated structured object. This adds provider
completion latency to the first client event, and the response includes
`x-gateway-stream-buffered: true` to make that behavior observable.

## Configuration

```js
const gateway = createGateway({
  core: stateCore,
  upstreamBaseUrl: process.env.PROVIDER_UPSTREAM_URL,
  upstreamApiKey: process.env.PROVIDER_UPSTREAM_API_KEY,
  upstreamTimeoutMs: 120_000,
  // Optional upstream overrides (see the table under "Local runtime").
  upstreamReasoningEffort: "none",
  structuredOutput: "json_schema",
  dropTools: true,
  upstreamStream: "auto",
  clientText: "envelope",
  debugDir: undefined,
  upstreamApi: "same",
  envelopeSchema: undefined, // defaults to ENVELOPE_SCHEMA
  promptControls: "all"
});
```

`createHttpServer(gateway)` adapts the gateway to Node's `http` server. The
default implementation never logs request or model payloads. Inject a logger
only when metadata-only operational logging is desired.

`GET /v1/models` (and `GET /models`) is a stateless passthrough to the
provider's `/models` route (same URL join rule as the model routes, query string
preserved) with the same timeout, response-size limit, and authorization
header. The upstream JSON is returned unchanged; upstream failures return a
gateway error (`502`/`503`/`504`), never `404`.

`GET /healthz` reports process health. `GET /capabilities` reports supported
routes, the structured protocol, and the fact that streaming is buffered for
validation.

## Local runtime

Run the loopback-only production entrypoint with:

```sh
npm run start:gateway
```

The entrypoint requires a trusted procedure file and creates the private state
directory before listening. Its defaults are suitable for a local LM Studio
server:

```text
SKILL_STATE_BIND_HOST=127.0.0.1
SKILL_STATE_PORT=8787
SKILL_STATE_ROOT=~/.local/share/skill-state
SKILL_STATE_PROCEDURE_FILE=~/.config/skill-state/procedure.json
PROVIDER_UPSTREAM_URL=http://127.0.0.1:1234/v1
```

| Variable | Values | Default | Effect on the upstream request |
| --- | --- | --- | --- |
| `PROVIDER_UPSTREAM_TIMEOUT_MS` | positive integer | `120000` | Provider request timeout. |
| `SKILL_STATE_UPSTREAM_REASONING_EFFORT` | `none`, `minimal`, `low`, `medium`, `high` | unset (client values forwarded) | Overrides client values. Responses: `reasoning = {effort}` (client `reasoning.summary` is dropped only for `none`). Chat: `reasoning_effort = effort`. |
| `SKILL_STATE_STRUCTURED_OUTPUT` | `off`, `json_schema` | `off` | `json_schema` forces the envelope schema (`ENVELOPE_SCHEMA`, name `skill_state_envelope`, `strict: true`). Responses: `text.format` (other `text` keys kept). Chat: `response_format`. Client formats are overridden. |
| `SKILL_STATE_DROP_TOOLS` | `true`, `false` | `true` when structured output is `json_schema`, else `false` | Removes `tools`, `tool_choice`, and `parallel_tool_calls`; a tool call cannot satisfy the envelope contract. |
| `SKILL_STATE_UPSTREAM_STREAM` | `auto`, `true`, `false` | `auto` | `true` forwards the client's `stream` flag. `false` always calls the provider with `stream: false`. `auto` behaves as `false` when structured output is `json_schema` (some providers do not enforce `json_schema` on streaming calls), else as `true`. A streaming client still receives the same buffered SSE (`x-gateway-stream-buffered: true`). |
| `SKILL_STATE_CLIENT_TEXT` | `envelope`, `action` | `envelope` | Client-facing assistant text only (not sent upstream). `action` shows `action.payload.text` for `respond`, `action.payload.question` for `ask`, and the compact JSON envelope otherwise. Top-level `state_patch`/`action` and the state commit are unchanged; streamed and non-streamed responses match. |
| `SKILL_STATE_UPSTREAM_API` | `same`, `chat` | `same` | `chat` sends `/v1/responses` client requests to the provider's `/v1/chat/completions` (LM Studio ignores `text.format` on `/v1/responses` but enforces `response_format` on chat, streaming or not). The body is translated: one user message with the canonical prompt, `max_output_tokens` to `max_tokens`, reasoning effort to `reasoning_effort`, envelope schema to `response_format`; shared controls (`temperature`, `top_p`, `stop`, `seed`, penalties) are kept and Responses-only fields (`store`, `include`, `text`, `truncation`, `background`, `previous_response_id`, `reasoning`, `max_tool_calls`) are dropped. Function tools are converted when `SKILL_STATE_DROP_TOOLS=false`. The client still gets a Responses object or Responses SSE with the requested `model` and usage mapped to `input_tokens`/`output_tokens`/`total_tokens` (plus cached/reasoning details). `/v1/chat/completions` clients are unaffected. |
| `SKILL_STATE_ENVELOPE_SCHEMA_FILE` | JSON file path | unset (built-in `ENVELOPE_SCHEMA`) | Replaces only the schema sent upstream for structured output (both APIs); the gateway's envelope validation is unchanged. Read at startup: regular file (symlinks refused), at most 64 KB, a JSON object with `type: "object"` and `required` containing `state_patch` and `action`; otherwise startup fails with `invalid_envelope_schema`. |
| `SKILL_STATE_PROMPT_CONTROLS` | `all`, `generation`, `none` | `all` | What the canonical prompt shows as `P.controls` (the upstream body is unaffected). `all` shows every allowed client control. `generation` shows only `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `max_output_tokens`, `stop`, `seed`, `presence_penalty`, `frequency_penalty`, so client reasoning/format values the gateway overrides and fields such as `include`/`store` are hidden. `none` shows `{}`. In every mode `tools`, `tool_choice`, and `parallel_tool_calls` are hidden when tools are dropped upstream. Controls never affect the procedure hash or idempotency. |
| `SKILL_STATE_DEBUG_DIR` | directory path | unset (disabled) | Opt-in local payload logging: on `invalid_structured_output`, writes the extracted model text and request id to `<dir>/invalid-<requestId>.txt` (dir `0700`, file `0600`, symlinks refused, 256 KB max). The client request is never written. |

Invalid values stop startup. Effective values appear in the startup summary as
`reasoningEffort`, `structuredOutput`, `dropTools`, `upstreamStream`,
`upstreamStreamEffective` (`client` or `off`), `clientText`, `debugDir`,
`upstreamApi`, `envelopeSchemaFile`, `envelopeSchemaSha256` (first 12 hex
characters of the file's SHA-256, or `null` for the built-in schema), and
`promptControls`. For local reasoning
models (for example Qwen in LM Studio), `none` + `json_schema` avoids minutes of
hidden reasoning per turn. Independently of these settings, the gateway reads
the answer only from Responses `message` output items or the first Chat choice,
ignores reasoning items/deltas and `reasoning_content`, and strips
`<think>...</think>` blocks before parsing.

Use `SKILL_STATE_PROCEDURE_FILE` to select either a trusted JSON or Markdown
procedure. `PROVIDER_UPSTREAM_API_KEY` is optional for local LM Studio and is
never included in startup output. `npm --workspace @skill-state/gateway run
start -- --check` validates the bind, state directory, procedure file, and
upstream configuration without starting a listener. The CLI emits only a
metadata startup summary and never logs request, transcript, procedure, or
model payloads. The one exception is `SKILL_STATE_DEBUG_DIR`: an explicit,
opt-in local payload log of invalid model output (see the
[threat model](../../docs/threat-model.md)). Leave it unset in normal operation
and delete captures when debugging is done.

## Core integration work

The core package must expose `prepareCall` (or `buildContext`) and return the
P/Σ/O envelope plus a canonical prompt. It should own projection and state
serialization; the gateway does not reconstruct state or replay transcripts.
The parent package should re-export this boundary and wire its provider URL,
API key, timeout, and core implementation into `createGateway`.
