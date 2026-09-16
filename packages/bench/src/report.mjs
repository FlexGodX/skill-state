import { aggregateRecords, compareRecords, evaluateQualityGate } from "./aggregate.mjs";
import { normalizeRecords } from "./records.mjs";

function finiteJsonReplacer(_key, value) {
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}

function reportRows(report) {
  const baseline = report.comparison.baseline;
  const skill = report.comparison.skill_state;
  const delta = report.comparison.delta;
  return [
    ["scenario_count", baseline.scenario_count, skill.scenario_count, delta.scenario_count],
    ["success_rate", baseline.success_rate, skill.success_rate, delta.success_rate],
    ["quality_score_mean", baseline.quality_score.mean, skill.quality_score.mean, delta.quality_score_mean],
    ["latency_mean_ms", baseline.latency_ms.mean, skill.latency_ms.mean, delta.latency_mean_ms],
    ["latency_regression_pct", null, null, delta.latency_regression_pct],
    ["steps_mean", baseline.steps.mean, skill.steps.mean, delta.steps_mean],
    ["tool_calls_mean", baseline.tool_calls.mean, skill.tool_calls.mean, delta.tool_calls_mean],
    ["patch_error_rate", baseline.errors.patch.rate, skill.errors.patch.rate, delta.patch_error_rate],
    ["action_error_rate", baseline.errors.action.rate, skill.errors.action.rate, delta.action_error_rate],
    ["input_tokens", baseline.usage.input, skill.usage.input, delta.input_tokens],
    ["output_tokens", baseline.usage.output, skill.usage.output, delta.output_tokens],
    ["cached_tokens", baseline.usage.cached, skill.usage.cached, delta.cached_tokens],
    ["reasoning_tokens", baseline.usage.reasoning, skill.usage.reasoning, delta.reasoning_tokens],
    ["cost_total_usd", baseline.cost_usd.total, skill.cost_usd.total, delta.cost_total_usd],
  ];
}

export function buildBenchmarkReport(input, gateOptions = {}) {
  const records = normalizeRecords(input);
  const comparison = compareRecords(records);
  const qualityGate = evaluateQualityGate(comparison, gateOptions);
  return {
    format_version: 1,
    record_count: records.length,
    comparison,
    quality_gate: qualityGate,
  };
}

export function renderJson(report) {
  return JSON.stringify(report, finiteJsonReplacer, 2) + "\n";
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const string = typeof value === "number" && !Number.isFinite(value) ? "Infinity" : String(value);
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export function renderCsv(report) {
  const rows = [["metric", "baseline", "skill_state", "delta"], ...reportRows(report)];
  rows.push(["quality_gate_passed", "", report.quality_gate.passed, ""]);
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function markdownCell(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number" && !Number.isFinite(value)) return "∞";
  return String(value).replaceAll("|", "\\|");
}

export function renderMarkdown(report) {
  const lines = [
    "# skill-state benchmark",
    "",
    `Records: ${report.record_count}`,
    `Quality gate: **${report.quality_gate.passed ? "passed" : "failed"}**`,
    "",
    "| Metric | Baseline | SKILL.state | Delta |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const row of reportRows(report)) {
    lines.push(`| ${row[0]} | ${markdownCell(row[1])} | ${markdownCell(row[2])} | ${markdownCell(row[3])} |`);
  }
  if (report.quality_gate.failures.length > 0) {
    lines.push("", "## Quality gate failures", "");
    for (const failure of report.quality_gate.failures) {
      lines.push(`- ${failure.metric}: ${failure.reason ?? `actual ${markdownCell(failure.actual)} > limit ${markdownCell(failure.limit)}`}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function renderReport(report, format = "json") {
  if (format === "json") return renderJson(report);
  if (format === "csv") return renderCsv(report);
  if (format === "markdown" || format === "md") return renderMarkdown(report);
  throw new Error(`Unsupported report format: ${format}`);
}

export { aggregateRecords };

