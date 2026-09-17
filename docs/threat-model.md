# Threat model and deployment boundaries

This document describes the assets and trust boundaries for a local or
single-operator deployment. It is a deployment guide, not a certification or a
guarantee that an arbitrary upstream model is safe.

## Assets

- Provider API keys and gateway authentication values.
- Versioned session state and pending action records under the core store.
- Session/tool observation records and their configured sink.
- Provider requests, structured responses, and action/state patches in memory.
- The client process and its environment.

## Trust boundaries

1. **Client to gateway.** Codex, OpenCode, or DeepSeek Harness sends a model
   request. Treat a client process and all supplied request fields as
   untrusted input.
2. **Gateway to core.** The gateway sends the model, controls, request ID, and
   one latest observation. The core validates bounded JSON and owns the state
   read/write boundary.
3. **Gateway to upstream.** The configured upstream receives one canonical
   prompt and allowed controls. It is an external trust boundary even when the
   gateway listens on loopback.
4. **Hooks to observation sink.** Hook processes can see lifecycle metadata and
   may be configured to see payloads. A file or HTTP sink is a separate trust
   boundary.
5. **Benchmark runner.** The optional live runner is the only component
   allowed to own live credentials and transport. The default aggregator is
   offline.

## Controls in the implementation

| Threat | Control | Residual risk |
| --- | --- | --- |
| Old transcript or hidden client fields reach the provider | Gateway extracts one latest observation and strips `messages`, `input`, `previous_response_id`, and routing fields before constructing one canonical prompt | The canonical prompt can still contain state and the selected observation; operators must define that data boundary |
| Provider output injects an unsafe patch or action | Structured JSON parsing, merge-patch/path checks, prototype-key rejection, depth/size limits, and explicit action validation | The model can still request an allowed action; domain policy must authorize and execute it |
| A retry applies a transition twice | Per-session serialization, expected revisions, idempotency records, and atomic state replacement | Storage corruption or a compromised process can defeat local guarantees |
| Gateway debug captures retain model output | `SKILL_STATE_DEBUG_DIR` is unset by default; when set it is opt-in local payload logging of invalid extracted model text only (never the client request), in a `0700` directory with `0600` files, symlinks refused, 256 KB per file | Model output can echo state or observation contents from the canonical prompt; captures persist until the operator deletes them |
| Observation sink captures secrets | Metadata-only hook records by default; payload capture is opt-in and visibly configured | A client can place sensitive values in metadata or a configured sink can retain them |
| Upstream or client causes a denial of service | Request and JSON limits plus upstream timeout | The gateway has no rate limiter or identity middleware by default |
| Upstream URL redirects or reaches an unintended host | URL is explicit operator configuration; provider credentials are supplied by environment | The gateway does not provide a general SSRF policy or egress firewall |
| Local process reads keys or state | No credentials in repository templates; filesystem/environment permissions remain the host's responsibility | Any process with equivalent user access can read local files and environment values |
| Hook or observation failure blocks model work | Hook failures return an allow decision or log a sink error; the gateway remains the routing boundary | Availability of observations is weaker than availability of model calls |

## Deployment requirements

- Bind a local-only gateway to `127.0.0.1`, or add authentication and an
  authorized reverse proxy before exposing it to another host.
- Supply `PROVIDER_UPSTREAM_API_KEY` and any gateway key through a secret store
  or process environment. Never commit values to templates, tests, or logs.
- Restrict the `.skill-state` directory to the service account and back it up
  only under the deployment's data-retention policy.
- Keep observation sinks on trusted, access-controlled storage. Use HTTPS for
  a remote sink and decide whether the sink should receive metadata only.
- Add application-level authorization before executing actions that can change
  external systems. The gateway validates structure; it is not an approval
  engine.

## Reporting

See [SECURITY.md](../SECURITY.md) for private vulnerability reporting and
credential-rotation guidance. Do not include provider keys, state files, or
raw tool payloads in a public issue.
