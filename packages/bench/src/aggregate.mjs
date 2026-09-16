import { normalizeRecords } from "./records.mjs";

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values) {
  return values.length === 0 ? null : sum(values) / values.length;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function rate(count, denominator) {
  return denominator === 0 ? 0 : count / denominator;
}

function metricValues(records, field) {
  return records.map((record) => record[field]).filter((value) => value !== null);
}

export function aggregateRecords(input, mode = undefined) {
  const records = normalizeRecords(input);
  const normalizedMode = mode === undefined
    ? undefined
    : String(mode).trim().toLowerCase().replace(/[.-]/g, "_");
  const selected = normalizedMode
    ? records.filter((record) => record.mode === (normalizedMode === "transcript" || normalizedMode === "legacy" ? "baseline" : normalizedMode === "state" || normalizedMode === "skillstate" ? "skill_state" : normalizedMode))
    : records;
  const latency = metricValues(selected, "latency_ms");
  const quality = metricValues(selected, "quality_score");
  const successCount = selected.filter((record) => record.success).length;
  const patchErrors = sum(selected.map((record) => record.patch_errors));
  const actionErrors = sum(selected.map((record) => record.action_errors));
  const usage = {
    input: sum(selected.map((record) => record.usage.input)),
    output: sum(selected.map((record) => record.usage.output)),
    cached: sum(selected.map((record) => record.usage.cached)),
    reasoning: sum(selected.map((record) => record.usage.reasoning)),
  };
  usage.total = usage.input + usage.output;
  usage.input_tokens = usage.input;
  usage.output_tokens = usage.output;
  usage.cached_tokens = usage.cached;
  usage.reasoning_tokens = usage.reasoning;
  usage.total_tokens = usage.total;
  const costTotal = sum(selected.map((record) => record.cost_usd));
  return {
    mode: mode ?? "all",
    scenario_count: selected.length,
    success_count: successCount,
    success_rate: rate(successCount, selected.length),
    quality_score: {
      scored_count: quality.length,
      mean: mean(quality),
      min: quality.length === 0 ? null : Math.min(...quality),
      max: quality.length === 0 ? null : Math.max(...quality),
    },
    latency_ms: {
      measured_count: latency.length,
      mean: mean(latency),
      p50: percentile(latency, 0.5),
      p95: percentile(latency, 0.95),
    },
    steps: {
      total: sum(selected.map((record) => record.steps)),
      mean: mean(selected.map((record) => record.steps)),
    },
    tool_calls: {
      total: sum(selected.map((record) => record.tool_calls)),
      mean: mean(selected.map((record) => record.tool_calls)),
    },
    errors: {
      patch: { total: patchErrors, rate: rate(patchErrors, selected.length) },
      action: { total: actionErrors, rate: rate(actionErrors, selected.length) },
    },
    usage,
    cost_usd: {
      total: costTotal,
      mean: mean(selected.map((record) => record.cost_usd)),
    },
  };
}

function difference(skill, baseline) {
  if (skill === null || skill === undefined || baseline === null || baseline === undefined) return null;
  return skill - baseline;
}

function relativeRegressionPct(skill, baseline) {
  if (skill === null || skill === undefined || baseline === null || baseline === undefined) return null;
  if (baseline === 0) return skill === 0 ? 0 : Infinity;
  return ((skill - baseline) / baseline) * 100;
}

function scenarioSet(records, mode) {
  return new Set(records.filter((record) => record.mode === mode).map((record) => record.scenario_id));
}

export function compareRecords(input) {
  const records = normalizeRecords(input);
  const baseline = aggregateRecords(records, "baseline");
  const skillState = aggregateRecords(records, "skill_state");
  const baselineIds = scenarioSet(records, "baseline");
  const skillIds = scenarioSet(records, "skill_state");
  const baselineOnly = [...baselineIds].filter((id) => !skillIds.has(id));
  const skillStateOnly = [...skillIds].filter((id) => !baselineIds.has(id));
  const paired = [...baselineIds].filter((id) => skillIds.has(id));

  return {
    baseline,
    skill_state: skillState,
    scenario_sets: {
      baseline_only: baselineOnly,
      skill_state_only: skillStateOnly,
      paired: paired.length,
    },
    delta: {
      scenario_count: difference(skillState.scenario_count, baseline.scenario_count),
      success_rate: difference(skillState.success_rate, baseline.success_rate),
      quality_score_mean: difference(skillState.quality_score.mean, baseline.quality_score.mean),
      latency_mean_ms: difference(skillState.latency_ms.mean, baseline.latency_ms.mean),
      latency_regression_pct: relativeRegressionPct(skillState.latency_ms.mean, baseline.latency_ms.mean),
      cost_total_usd: difference(skillState.cost_usd.total, baseline.cost_usd.total),
      cost_regression_pct: relativeRegressionPct(skillState.cost_usd.total, baseline.cost_usd.total),
      steps_mean: difference(skillState.steps.mean, baseline.steps.mean),
      tool_calls_mean: difference(skillState.tool_calls.mean, baseline.tool_calls.mean),
      patch_error_rate: difference(skillState.errors.patch.rate, baseline.errors.patch.rate),
      action_error_rate: difference(skillState.errors.action.rate, baseline.errors.action.rate),
      input_tokens: difference(skillState.usage.input, baseline.usage.input),
      output_tokens: difference(skillState.usage.output, baseline.usage.output),
      cached_tokens: difference(skillState.usage.cached, baseline.usage.cached),
      reasoning_tokens: difference(skillState.usage.reasoning, baseline.usage.reasoning),
    },
  };
}

export function evaluateQualityGate(comparison, options = {}) {
  const thresholds = {
    minSuccessRate: options.minSuccessRate ?? 0,
    minQualityScore: options.minQualityScore ?? 0,
    maxLatencyRegressionPct: options.maxLatencyRegressionPct ?? Infinity,
    maxCostRegressionPct: options.maxCostRegressionPct ?? Infinity,
    maxPatchErrorRate: options.maxPatchErrorRate ?? Infinity,
    maxActionErrorRate: options.maxActionErrorRate ?? Infinity,
    requirePaired: options.requirePaired ?? true,
  };
  const failures = [];
  const skill = comparison.skill_state;
  const delta = comparison.delta;
  if (skill.scenario_count === 0) {
    failures.push({ metric: "skill_state.scenario_count", actual: 0, reason: "no skill_state records" });
  }
  if (skill.success_rate < thresholds.minSuccessRate) {
    failures.push({ metric: "skill_state.success_rate", actual: skill.success_rate, limit: thresholds.minSuccessRate });
  }
  if ((skill.quality_score.mean ?? 0) < thresholds.minQualityScore) {
    failures.push({ metric: "skill_state.quality_score.mean", actual: skill.quality_score.mean, limit: thresholds.minQualityScore });
  }
  if ((delta.latency_regression_pct ?? 0) > thresholds.maxLatencyRegressionPct) {
    failures.push({ metric: "latency_regression_pct", actual: delta.latency_regression_pct, limit: thresholds.maxLatencyRegressionPct });
  }
  if ((delta.cost_regression_pct ?? 0) > thresholds.maxCostRegressionPct) {
    failures.push({ metric: "cost_regression_pct", actual: delta.cost_regression_pct, limit: thresholds.maxCostRegressionPct });
  }
  if (skill.errors.patch.rate > thresholds.maxPatchErrorRate) {
    failures.push({ metric: "skill_state.errors.patch.rate", actual: skill.errors.patch.rate, limit: thresholds.maxPatchErrorRate });
  }
  if (skill.errors.action.rate > thresholds.maxActionErrorRate) {
    failures.push({ metric: "skill_state.errors.action.rate", actual: skill.errors.action.rate, limit: thresholds.maxActionErrorRate });
  }
  if (thresholds.requirePaired && (comparison.scenario_sets.baseline_only.length > 0 || comparison.scenario_sets.skill_state_only.length > 0)) {
    failures.push({
      metric: "scenario_sets",
      reason: "baseline and skill_state must use the same scenario set",
      baseline_only: comparison.scenario_sets.baseline_only,
      skill_state_only: comparison.scenario_sets.skill_state_only,
    });
  }
  return { passed: failures.length === 0, thresholds, failures };
}
