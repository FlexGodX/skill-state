# Integration examples

These examples contain no credentials and no user-specific paths. Start the gateway, then choose one
client fragment:

Before any non-test client starts, configure the gateway's trusted immutable procedure. From the
repository root, the checked-in procedure file can be selected with:

```sh
export SKILL_STATE_PROCEDURE_FILE="$PWD/examples/skill-state-procedure.json"
```

The alternative is `SKILL_STATE_PROCEDURE` or a `procedure` value passed to `createGateway()` or
`createSkillStateCore()`. This is gateway/core startup configuration; it is not a field for any of
the client fragments below. The core computes a stable `procedureHash` per session and rejects a
changed procedure. `allowTestProcedureDefault: true` is for tests only.

- `codex-provider.toml` configures a Codex custom provider and profile.
- `opencode.provider.json` configures the OpenCode provider and plugin.
- `deepseek-harness.json` describes the adapter settings passed to
  `applySkillStateLlmPlugin()`.

The DeepSeek Harness JSON contains only adapter settings. Keep the trusted procedure in the gateway
startup environment or constructor; `procedureFile` is not an adapter option. After the gateway
commits a model patch and records an action, the host executes that action and sends its result as
`action_result` or `tool_result` on the next model request.

The companion Codex plugin under `plugin/skill-state/` records session and tool observations. The
client provider must still point at the gateway so state updates go through the mandatory interception
path.

Read [installation and configuration](../docs/install.md) before copying a fragment, then use the
[architecture](../docs/architecture.md), [compatibility matrix](../docs/compatibility.md), and
[threat model](../docs/threat-model.md) to choose the appropriate host boundaries. The templates are
safe to review in a public repository: provide credentials through the client secret store or process
environment only.
