# Optional benchmark

`packages/bench` is an optional, offline result aggregator. It is off by
default: it is not imported by the core or gateway, the root test command does
not invoke it directly, and no provider credential is read unless an operator
explicitly supplies a live runner.

## Offline aggregation

Give the CLI a JSON array of normalized scenario results:

```sh
node packages/bench/bin/skill-state-bench.mjs \
  --input ./scenario-results.json \
  --format markdown
```

It compares `baseline`/`transcript` and `skill_state`/`state` records and can
report success, quality, latency, token usage, cost, patch errors, and action
errors. Optional thresholds turn the report into a quality gate; a failed gate
exits with status 2. The default path makes no LLM call, network request,
credential read, telemetry request, or prompt/response retention.

## Explicit live runner

Live execution requires both `--live` and a caller-supplied module exporting
`run(scenario)` (or a default function). That runner owns provider credentials,
transport, scenario redaction, and any network access. The benchmark keeps only
normalized metrics returned by the runner.

Use live mode only in an explicitly controlled environment. It is not part of
the normal CI gate and no paper result is reproduced by this package.

The state-centric motivation is described in the
[arXiv abstract](https://arxiv.org/abs/2608.26263v3),
[HTML](https://arxiv.org/html/2608.26263v3), and
[PDF](https://arxiv.org/pdf/2608.26263v3). This benchmark package is an
independent implementation and its local metrics must not be presented as the
paper's reported results.
