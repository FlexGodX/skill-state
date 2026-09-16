# skill-state-bench

`skill-state-bench` compares a baseline transcript flow with a SKILL.state
flow using the same scenario result records. It is an optional package: it is
not imported by `@skill-state/core` or the provider gateway, and nothing runs
unless the CLI or an exported function is called explicitly.

The default path is an offline aggregation. It does not call an LLM, make a
network request, read provider credentials, store prompt/response bodies, or
send telemetry.

## Input

Pass a JSON array to the CLI with one result per scenario and variant:

```json
[
  {
    "scenario_id": "search-1",
    "mode": "baseline",
    "success": true,
    "quality_score": 0.82,
    "latency_ms": 640,
    "steps": 4,
    "tool_calls": 2,
    "patch_errors": 0,
    "action_errors": 0,
    "usage": {
      "input": 1200,
      "output": 180,
      "cached": 900,
      "reasoning": 40
    },
    "cost_usd": 0.0042,
    "prompt": "this field is accepted as input but is never retained"
  },
  {
    "scenario_id": "search-1",
    "mode": "skill_state",
    "success": true,
    "quality_score": 0.9,
    "latency_ms": 510,
    "steps": 2,
    "tool_calls": 1,
    "usage": {
      "input_tokens": 360,
      "output_tokens": 110,
      "cached_tokens": 300,
      "reasoning_tokens": 20
    },
    "cost_usd": 0.0018,
    "response": { "private": "not retained" }
  }
]
```

`mode` accepts `baseline`/`transcript` and `skill_state`/`skill-state`/`state`.
Usage accepts either short names (`input`, `output`, `cached`, `reasoning`) or
provider names ending in `_tokens`. Missing counters are zero; missing quality
scores are excluded from the quality average. Bodies and unknown fields are
discarded during normalization.

## CLI

The CLI has no default run. Invoke it with an input file explicitly:

```sh
node packages/bench/bin/skill-state-bench.mjs \
  --input ./scenario-results.json \
  --format markdown
```

Formats are `json`, `csv`, and `markdown`; output goes to stdout unless
`--output path` is supplied. Quality thresholds are optional:

```sh
node packages/bench/bin/skill-state-bench.mjs \
  --input ./scenario-results.json \
  --format json \
  --min-success-rate 0.95 \
  --min-quality-score 0.8 \
  --max-latency-regression-pct 10 \
  --max-cost-regression-pct 5 \
  --max-patch-error-rate 0.01 \
  --max-action-error-rate 0.01
```

The process exits with status 2 when the quality gate fails. It still emits the
full report so CI can archive the evidence.

## Optional live runner

Live benchmarking is opt-in and has no built-in provider or network client.
Provide a module that exports `run(scenario)` (or a default function):

```js
export async function run(scenario) {
  // The caller owns credentials, transport, and redaction.
  return {
    scenario_id: scenario.id,
    mode: scenario.mode,
    success: true,
    quality_score: 1,
    latency_ms: 100,
  };
}
```

Then invoke `--live --runner ./my-runner.mjs --input scenarios.json`. The
runner receives scenario definitions and is the only component allowed to
perform a live call. The benchmark still retains only normalized metrics.
