---
name: skill-state
description: Route supported agent clients through the skill-state gateway and inspect the provider and observation integration.
---

# Skill State

Use this skill when a task needs a state-aware model provider or session and tool observations.

## Start with the provider path

Every model request must target the skill-state gateway. Configure one client using the templates in
`integrations/codex/`, `integrations/opencode/`, or `integrations/deepseek-harness/`. Keep the gateway
URL and credential in environment variables or the client's secret store. The gateway builds the
canonical prompt from its core state boundary and the latest observation.

## Add observations

Install the companion hooks from `plugin/skill-state/hooks/`. They record session and tool lifecycle
events as metadata and allow an optional observation sink. Tool payload capture is opt-in; leave it
disabled when arguments or results can contain sensitive data.

## Verify the connection

Check the gateway health and capabilities endpoints, then make one request through the configured
provider route. A successful provider check is not proof that state was updated: inspect the emitted
observation record and the gateway's structured response separately.

## Known limitation

Codex Desktop subscription authentication covers the first-party OpenAI route. It does not authorize
an arbitrary custom provider, so a custom route needs its own gateway credential or an intentionally
unauthenticated local gateway.
