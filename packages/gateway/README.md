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

The request's `action_result` and `tool_result` fields take precedence and are
normalized as the latest observation. `latest_observation` is used when no
action/tool result is present. If none is present, the last user input is
treated as the observation so a compatible client can still start a turn. This
is the only client content the core receives. The provider request preserves
the model and supported generation controls, but drops arbitrary request keys;
client `system`, `instructions`, `prompt`, and context fields cannot override
the canonical prompt returned by core.

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
  upstreamTimeoutMs: 120_000
});
```

`createHttpServer(gateway)` adapts the gateway to Node's `http` server. The
default implementation never logs request or model payloads. Inject a logger
only when metadata-only operational logging is desired.

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

Use `SKILL_STATE_PROCEDURE_FILE` to select either a trusted JSON or Markdown
procedure. `PROVIDER_UPSTREAM_API_KEY` is optional for local LM Studio and is
never included in startup output. `npm --workspace @skill-state/gateway run
start -- --check` validates the bind, state directory, procedure file, and
upstream configuration without starting a listener. The CLI emits only a
metadata startup summary and never logs request, transcript, procedure, or
model payloads.

## Core integration work

The core package must expose `prepareCall` (or `buildContext`) and return the
P/Σ/O envelope plus a canonical prompt. It should own projection and state
serialization; the gateway does not reconstruct state or replay transcripts.
The parent package should re-export this boundary and wire its provider URL,
API key, timeout, and core implementation into `createGateway`.
