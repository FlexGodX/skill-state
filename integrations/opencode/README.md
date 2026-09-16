# OpenCode provider and plugin

`opencode.provider.json` configures the OpenCode provider id `skill-state` with the
`@ai-sdk/openai-compatible` implementation. The loopback `baseURL` points at the skill-state gateway;
the OpenCode model route therefore cannot bypass the gateway's provider interception. The `env` entry
names an optional gateway credential without placing a key in the repository.

The companion `skill-state.plugin.mjs` uses the OpenCode 1.x plugin hooks for provider model discovery,
session events, chat messages, and tool execution before/after events. Its `chat.headers` hook reads
the actual OpenCode `input.sessionID`, fails clearly when that field is absent, and adds both
`x-skill-state-provider` and `x-skill-state-session`. OpenCode owns the provider request body, so its
tool messages/results remain there for gateway observation extraction; this plugin only adds headers.
It writes metadata-only observations to `.skill-state/observations.ndjson` relative to the OpenCode
process unless `SKILL_STATE_OBSERVATION_SINK` names a file or HTTP endpoint. Tool arguments and results
are not copied into the observation sink.

The plugin is intentionally dependency-free at runtime and can be referenced from a repository-local
OpenCode configuration. If the file is copied elsewhere, update the `plugin` path in the config
fragment; do not edit the user's global OpenCode configuration as part of this integration.
