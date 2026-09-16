import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateRecords,
  buildBenchmarkReport,
  compareRecords,
  renderCsv,
  renderMarkdown,
  runLiveBenchmark,
} from "../src/index.mjs";
import { main } from "../bin/skill-state-bench.mjs";

function pairRecords() {
  return [
    {
      scenario_id: "one",
      mode: "baseline",
      success: true,
      quality_score: 0.7,
      latency_ms: 100,
      steps: 3,
      tool_calls: 2,
      patch_errors: 0,
      action_errors: 1,
      usage: { input: 100, output: 20, cached: 50, reasoning: 5 },
      cost_usd: 0.01,
    },
    {
      scenario_id: "one",
      mode: "skill_state",
      success: true,
      quality_score: 0.9,
      latency_ms: 80,
      steps: 2,
      tool_calls: 1,
      patch_errors: 0,
      action_errors: 0,
      usage: { input_tokens: 40, output_tokens: 10, cached_tokens: 20, reasoning_tokens: 2 },
      cost_usd: 0.004,
    },
    {
      scenario_id: "two",
      mode: "baseline",
      success: false,
      quality_score: 0.4,
      latency_ms: 300,
      steps: 5,
      tool_calls: 3,
      patch_errors: 1,
      action_errors: 0,
      usage: { input: 200, output: 30, cached: 0, reasoning: 10 },
      cost_usd: 0.02,
    },
    {
      scenario_id: "two",
      mode: "skill-state",
      success: true,
      quality_score: 0.8,
      latency_ms: 120,
      steps: 2,
      tool_calls: 1,
      patch_errors: 0,
      action_errors: 0,
      usage: { input: 60, output: 15, cached: 10, reasoning: 3 },
      cost_usd: 0.006,
    },
  ];
}

test("offline/default paths do not invoke a live runner", async () => {
  let invocations = 0;
  const disabled = await runLiveBenchmark({
    enabled: false,
    scenarios: [{ id: "one" }],
    runner: async () => { invocations += 1; },
  });
  assert.deepEqual(disabled, { invoked: false, records: [] });
  assert.equal(invocations, 0);

  let stdout = "";
  const code = await main([], { stdout: { write: (text) => { stdout += text; } } });
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
});

test("aggregates tokens, cost, latency, steps, tools, errors, and quality gate", () => {
  const comparison = compareRecords(pairRecords());
  assert.equal(comparison.baseline.usage.input, 300);
  assert.equal(comparison.skill_state.usage.output, 25);
  assert.equal(comparison.baseline.cost_usd.total, 0.03);
  assert.equal(comparison.skill_state.latency_ms.p95, 120);
  assert.equal(comparison.baseline.errors.action.total, 1);
  assert.equal(comparison.skill_state.steps.mean, 2);
  assert.equal(comparison.skill_state.success_rate, 1);
  assert.equal(comparison.scenario_sets.paired, 2);

  const report = buildBenchmarkReport(pairRecords(), {
    minSuccessRate: 1,
    minQualityScore: 0.8,
    maxLatencyRegressionPct: 0,
    maxCostRegressionPct: 0,
    maxPatchErrorRate: 0,
    maxActionErrorRate: 0,
  });
  assert.equal(report.quality_gate.passed, true);
  assert.match(renderCsv(report), /quality_gate_passed/);
  assert.match(renderMarkdown(report), /Quality gate: \*\*passed\*\*/);

  const failing = buildBenchmarkReport(pairRecords(), { minQualityScore: 0.95 });
  assert.equal(failing.quality_gate.passed, false);
  assert.equal(failing.quality_gate.failures[0].metric, "skill_state.quality_score.mean");
});

test("normalization redacts prompt and response bodies", () => {
  const report = buildBenchmarkReport([
    {
      scenario_id: "private",
      mode: "baseline",
      success: true,
      prompt: "secret prompt should not survive",
      response: { secret: "response" },
      usage: { input: 1 },
    },
    {
      scenario_id: "private",
      mode: "skill_state",
      success: true,
      prompt: "another secret",
      response: "secret response",
      usage: { input: 1 },
    },
  ]);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("secret prompt"), false);
  assert.equal(serialized.includes("secret response"), false);
  assert.equal(serialized.includes("prompt"), false);
  assert.equal(serialized.includes("response"), false);
});

test("live runner is called only when explicitly enabled and output is redacted", async () => {
  const seen = [];
  const result = await runLiveBenchmark({
    enabled: true,
    scenarios: [{ id: "live-1", mode: "baseline" }],
    runner: {
      async run(scenario) {
        seen.push(scenario.id);
        return {
          scenario_id: scenario.id,
          mode: scenario.mode,
          success: true,
          quality_score: 1,
          latency_ms: 5,
          prompt: "must be discarded",
        };
      },
    },
  });
  assert.deepEqual(seen, ["live-1"]);
  assert.equal(result.invoked, true);
  assert.equal(result.records[0].prompt, undefined);
});

