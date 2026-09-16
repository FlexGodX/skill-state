# Codex custom provider

`custom-provider.toml` is a project or user configuration fragment. It routes the Codex Responses
wire to the local skill-state gateway, which is the provider interception point. Change the loopback
port only when the gateway is intentionally bound elsewhere.

`env_key` names the variable Codex may use for gateway authentication. The template has no key and
does not write to `~/.codex`; copy or merge it through the normal Codex configuration workflow.

Codex Desktop subscription authentication applies to the first-party OpenAI provider. It does not
grant access to an arbitrary `model_providers.skill_state` endpoint. A custom route therefore needs
its own gateway credential, or a gateway that is deliberately unauthenticated on a trusted local
interface.

The gateway accepts both `/v1/chat/completions` and `/v1/responses`; this fragment selects
`responses`. The model id is a template value and must match a model accepted by the configured
upstream provider.

The companion Codex lifecycle hooks observe session and tool events, but the current hook seam has
no verified outbound custom-provider request hook. They therefore cannot inject `x-skill-state-session`;
provider interception and stable session propagation must come from the configured client/provider
integration.
