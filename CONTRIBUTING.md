# Contributing

Thanks for helping improve `skill-state`. Keep changes focused on the state
runtime, gateway, integration seams, plugin scaffold, documentation, or the
optional benchmark package. Explain the user-visible contract in the pull
request description and keep provider credentials and user-specific paths out
of every change.

## Development setup

Use Node.js 20 or newer:

```sh
npm install
npm test
npm run typecheck
```

The test command covers the core, gateway, integrations, and plugin hooks.
When changing one area, run its focused test command as well. Documentation
changes should preserve the relative links and examples in `README.md` and
`docs/`.

## Change guidelines

- Preserve the gateway as the mandatory provider interception point.
- Keep `P + Σ + latest O` boundaries explicit; do not reintroduce transcript
  replay into provider requests.
- Validate structured provider output before emitting an action or applying a
  patch.
- Keep plugin hooks in their companion directories; do not add unsupported
  manifest fields.
- Keep benchmark live mode opt-in and offline aggregation free of credentials,
  network calls, and telemetry.
- Add or update focused tests for behavior changes. Avoid tests that only copy
  implementation details.
- Run the local secret scan before opening a pull request and remove any
  sensitive data from logs, fixtures, and examples.

## Pull requests

Describe the problem, resulting behavior, validation commands, and any
provider-version assumptions. Call out compatibility or security implications
when changing an adapter, hook, state format, or gateway boundary. A pull
request should be reviewable without access to a user's local Codex,
OpenCode, or DeepSeek Harness configuration.

By contributing, you agree that your contribution may be distributed under
the repository's [MIT License](LICENSE).
