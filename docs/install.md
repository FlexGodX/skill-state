# Install and configure

The repository requires Node.js 20 or newer. The examples are templates: they
contain provider IDs, loopback URLs, and environment variable names, but no
credentials and no user-specific paths.

## Checkout and local checks

```sh
npm install
npm test
npm run typecheck
```

The root `npm test` builds the core and runs core, gateway, integration, and
plugin tests. The gateway and adapters are dependency-free at runtime. The
development dependencies are installed by npm in the checkout; no global
Python or Node package is required.

## Configure the trusted procedure

Production startup must supply a non-empty trusted procedure. It is the
immutable `P` included in the core projection; clients cannot set or replace it
in a model request. Choose one startup mechanism:

```sh
export SKILL_STATE_PROCEDURE_FILE="$PWD/examples/skill-state-procedure.json"
```

or provide an inline JSON/string value:

```sh
export SKILL_STATE_PROCEDURE='{"id":"skill-state-default","version":1}'
```

An embedding can pass the same value through the `procedure` constructor option
on `createGateway` or `createSkillStateCore`; `createGateway` also accepts the
explicit `procedureFile` option. The gateway resolves the procedure once at
startup and computes a stable SHA-256 `procedureHash` for each session. A
session or commit using a different hash fails with `PROCEDURE_CONFLICT`.
`allowTestProcedureDefault: true` is an explicit test-only escape hatch and
must not be enabled in a deployed host.

## Embed the gateway

The gateway is an embeddable HTTP component. A host application supplies a
core object and the upstream URL; a concrete core can be created with
`createSkillStateCore`. `@skill-state/gateway` declares
`@skill-state/core` as its runtime dependency, so both packages must be
installed or built together; the gateway is not a standalone prompt proxy.
The core must expose `prepareCall` or `buildContext` and
`commitResponse`/`commitState`. This is an embedding sketch, so run it through
the host application's ESM/TypeScript build or its supported TypeScript loader:

```js
import { createSkillStateCore } from "@skill-state/core";
import { createGateway, createHttpServer } from "@skill-state/gateway";

const procedure = { id: "skill-state-default", version: 1 };
const core = createSkillStateCore({ rootDir: ".skill-state", procedure });
const gateway = createGateway({
  core,
  procedure,
  upstreamBaseUrl: process.env.PROVIDER_UPSTREAM_URL,
  upstreamApiKey: process.env.PROVIDER_UPSTREAM_API_KEY,
  upstreamTimeoutMs: 120_000,
});

createHttpServer(gateway).listen(8787, "127.0.0.1");
```

The gateway exposes `GET /healthz` and `GET /capabilities`, plus
`POST /v1/chat/completions` and `POST /v1/responses`. The upstream must return
an assistant text containing the structured `{state_patch, action}` envelope
described in [Architecture](architecture.md). Set
`PROVIDER_UPSTREAM_API_KEY` only in the process environment or a secret store.

When a core is injected, pass the same trusted procedure to both constructors,
or construct the core with that procedure and let the gateway use
`core.procedure`. Their hashes must match. Do not put `procedure` or
`procedureHash` in a client request as a configuration mechanism; the gateway
filters client fields and verifies the core context against its startup hash.

After validating the envelope, the gateway asks core to commit the patch and
record the action for host execution before returning the response. The host
executes that action and sends its result as `action_result` or `tool_result` on
the next request; the gateway forwards that result as the next latest
observation `O`. Core does not execute external actions itself.

The default store directory is `.skill-state` when no `rootDir` is supplied.
Treat it as application data: use filesystem permissions appropriate for the
session state and keep it out of source control.

## Codex CLI custom provider

Copy or merge [`integrations/codex/custom-provider.toml`](../integrations/codex/custom-provider.toml)
through the normal Codex CLI configuration workflow. The equivalent example is
[`examples/codex-provider.toml`](../examples/codex-provider.toml):

```toml
[model_providers.skill_state]
name = "skill-state gateway"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
env_key = "SKILL_STATE_GATEWAY_API_KEY"

[profiles.skill_state]
model = "state-model"
model_provider = "skill_state"
```

Start the gateway on the configured loopback port, set
`SKILL_STATE_GATEWAY_API_KEY` if the gateway or reverse proxy requires it, and
select the `skill_state` profile. The model name is a template and must be
accepted by the configured upstream provider.

Codex Desktop subscription authentication covers the first-party OpenAI route.
It does not authorize an arbitrary `model_providers.skill_state` endpoint. A
custom provider therefore needs its own gateway credential, or an intentionally
unauthenticated gateway bound to a trusted local interface. See the
[Codex integration note](../integrations/codex/README.md).

## DeepSeek Harness adapter

The adapter targets the actual Harness seam rather than editing a Harness
checkout. It extends `LlmAdapter`, registers through the live `LlmRuntime`, and
observes `llm/stream` while delegating to `next()`.

Use [`integrations/deepseek-harness/config.example.json`](../integrations/deepseek-harness/config.example.json)
as a source of field names, then register it in the host composition:

```js
import { applySkillStateLlmPlugin } from "./integrations/deepseek-harness/src/index.mjs";

const dispose = applySkillStateLlmPlugin(ctx, {
  provider: "skill-state",
  model: "state-model",
  gatewayBaseUrl: "http://127.0.0.1:8787/v1",
  apiKeyEnv: "SKILL_STATE_GATEWAY_API_KEY",
  onObservation: (observation) => observationSink.write(observation),
});
```

The host must already provide `@deepseek-ai/dsh-llm` and
`@deepseek-ai/cordis`; the patchable package declares peer dependencies and
does not install or modify them. The adapter fails closed when the gateway URL
is missing or invalid, so a configured route cannot silently fall back to a
direct provider. See the [Harness integration note](../integrations/deepseek-harness/README.md).

## OpenCode provider and hooks

Copy [`integrations/opencode/opencode.provider.json`](../integrations/opencode/opencode.provider.json)
into a repository-local OpenCode configuration and update the relative plugin
path if the fragment moves. It uses `@ai-sdk/openai-compatible` with
`http://127.0.0.1:8787/v1`, so the model route remains gateway-backed. The
plugin records session and tool metadata and adds a routing header; tool
arguments and results are not retained by default.

Set `SKILL_STATE_GATEWAY_API_KEY` in the process environment when required.
Do not edit `~/.config/opencode` as part of installing this repository fragment.
See the [OpenCode integration note](../integrations/opencode/README.md).

## Codex plugin hooks

The plugin scaffold is under [`plugin/skill-state`](../plugin/skill-state/).
Its manifest intentionally contains no unsupported `hooks` field. The host
discovers [`hooks/hooks.json`](../plugin/skill-state/hooks/hooks.json), which
registers `SessionStart`, `SessionEnd`, `PreToolUse`, and `PostToolUse`
observation commands. The default sink is `.skill-state/observations.ndjson`.

Set `SKILL_STATE_OBSERVATION_SINK` to an explicit file or HTTPS endpoint only
when the deployment owns that sink. Set
`SKILL_STATE_CAPTURE_TOOL_PAYLOADS=1` only after checking that tool arguments
and results may be retained; metadata-only observations are the default.

## Health check

After starting the host application, check the interception point before using
a client:

```sh
curl --fail http://127.0.0.1:8787/healthz
curl --fail http://127.0.0.1:8787/capabilities
```

The capabilities response should report both OpenAI-compatible routes and a
configured core/upstream. A successful health check does not prove that a
state patch was committed; inspect the structured response and observation
sink separately.
