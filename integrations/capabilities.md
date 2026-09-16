# Integration capability note

The repository artifacts cover three client paths:

| Client | Shipped artifact | Required runtime seam |
| --- | --- | --- |
| Codex | `integrations/codex/custom-provider.toml` | Codex custom provider pointing at the gateway |
| DeepSeek Harness | `integrations/deepseek-harness/` | `LlmAdapter`, `ctx.llm.registerAdapter()`, and `llm/stream` waterfall |
| OpenCode | `integrations/opencode/` | `@ai-sdk/openai-compatible` provider plus OpenCode plugin hooks |

Provider interception is mandatory in each path: the configured provider URL is the skill-state
gateway, and the DeepSeek Harness adapter refuses to construct without `gatewayBaseUrl`. The gateway
owns the P/Σ/O state boundary; adapters send the latest observation and generation controls rather than
replaying a transcript.

Unresolved developer experience items remain outside this patch:

- Codex Desktop does not expose its subscription credential as authorization for arbitrary custom
  providers. The custom-provider fragment therefore names an optional environment credential and
  documents the local unauthenticated case; it cannot make subscription auth work for the gateway.
- Codex and OpenCode do not share a repository-independent config merge or plugin-install command. The
  examples are copyable fragments and deliberately do not edit `~/.codex` or `~/.config/opencode`.
- The core gateway contract currently documents model endpoints and health/capabilities. Observation
  persistence is an optional file or HTTP sink (`SKILL_STATE_OBSERVATION_SINK`) owned by the host; a
  future gateway observation endpoint should adopt the `skill-state.observation.v1` envelope.
- OpenCode plugin hook availability is versioned. The plugin targets the installed 1.x hook names;
  deployments on another major version should validate the provider and tool hook signatures before
  enabling it.
- `dx` is unverified on the current host: no command, alias, function, package, or documented runtime
  seam with that name was found. The authoritative local DeepSeek Harness CLI is `dsh` (Harness
  `0.1.2-alpha.2`), so this repository makes no `dx` compatibility claim. To identify `dx`, provide
  the exact command/package or repository and the expected provider hook and stable session-ID field.
