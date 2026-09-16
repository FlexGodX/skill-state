# Security policy

`skill-state` handles provider requests, local session state, observations, and
optional actions. Treat every deployment as an integration boundary and follow
the [threat model](docs/threat-model.md).

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Once this
repository is published, use its GitHub Security Advisory workflow or another
private maintainer contact listed in the repository profile. Before a private
channel is configured, keep the report private and contact the project
maintainers through the hosting account.

Include a clear description, affected path/version, reproduction steps that do
not contain real credentials, and the impact. Redact provider keys, state
files, raw observations, and tool payloads from reports.

## Credential and data response

If a key may have been exposed, revoke or rotate it with the provider first,
then remove it from local logs and repository history. Do not rely on deleting
the working-tree copy alone. Review observation sinks and `.skill-state` data
for retention and access after an incident.

The gateway validates structure and state transitions; it does not provide
authentication, authorization, rate limiting, or an action approval policy by
default. Add those controls at the deployment boundary before exposing the
gateway to an untrusted network.

## Supported versions

The project is pre-1.0. Report issues against the exact checkout or package
version and include Node.js version and adapter/client version when relevant.
