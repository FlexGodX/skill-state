# skill-state Codex plugin

This repository-local plugin contains the `skill-state` skill and companion host hooks. The manifest
intentionally omits a `hooks` field: the Codex plugin loader discovers the companion
`hooks/hooks.json`, while the manifest schema rejects unsupported `hooks` entries.

The hooks observe `SessionStart`, `SessionEnd`, `PreToolUse`, and `PostToolUse`. They append one
JSON object per event to `.skill-state/observations.ndjson` relative to the host working directory.
Set `SKILL_STATE_OBSERVATION_SINK` to an explicit file path or an HTTP observation endpoint when a
different sink is needed. Set `SKILL_STATE_CAPTURE_TOOL_PAYLOADS=1` only when tool arguments and
results are safe to retain; identity and status metadata are the default.

Hook failures return `{"decision":"allow"}` so an unavailable observation sink cannot block a
session or tool call. Model requests still need a provider configured through the gateway templates
under `integrations/`; the hooks do not bypass provider interception. The current Codex hook seam has
no verified outbound custom-provider request hook, so it cannot inject `x-skill-state-session`; use an
adapter with a runtime session ID when that header is required.
