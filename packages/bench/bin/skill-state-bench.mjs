#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BenchError,
  buildBenchmarkReport,
  renderReport,
  runLiveBenchmark,
} from "../src/index.mjs";

const USAGE = `Usage:
  skill-state-bench --input results.json [--format json|csv|markdown] [--output report]
  skill-state-bench --live --runner ./runner.mjs --input scenarios.json [options]

Options:
  --input FILE                       Offline results or live scenario definitions
  --format FORMAT                   json (default), csv, or markdown
  --output FILE                     Write report to a file instead of stdout
  --live                            Explicitly invoke the supplied runner
  --runner FILE                     ES module exporting run(scenario)
  --min-success-rate N              Quality gate threshold in [0, 1]
  --min-quality-score N             Quality gate threshold in [0, 1]
  --max-latency-regression-pct N    Maximum relative latency regression
  --max-cost-regression-pct N       Maximum relative cost regression
  --max-patch-error-rate N          Maximum SKILL.state patch error rate
  --max-action-error-rate N         Maximum SKILL.state action error rate
  --help                            Show this help
`;

const VALUE_FLAGS = new Set([
  "--input",
  "--format",
  "--output",
  "--runner",
  "--min-success-rate",
  "--min-quality-score",
  "--max-latency-regression-pct",
  "--max-cost-regression-pct",
  "--max-patch-error-rate",
  "--max-action-error-rate",
]);

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new BenchError("invalid_cli", `${flag} requires a value.`);
  return value;
}

function threshold(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new BenchError("invalid_cli", `${flag} must be a non-negative number.`);
  return parsed;
}

export function parseArgs(argv) {
  const options = { format: "json", live: false, gate: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { ...options, help: true };
    if (flag === "--live") {
      options.live = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new BenchError("invalid_cli", `Unknown option: ${flag}`);
    const value = requiredValue(argv, index, flag);
    index += 1;
    if (flag === "--input") options.input = value;
    else if (flag === "--format") options.format = value.toLowerCase();
    else if (flag === "--output") options.output = value;
    else if (flag === "--runner") options.runner = value;
    else if (flag === "--min-success-rate") options.gate.minSuccessRate = threshold(value, flag);
    else if (flag === "--min-quality-score") options.gate.minQualityScore = threshold(value, flag);
    else if (flag === "--max-latency-regression-pct") options.gate.maxLatencyRegressionPct = threshold(value, flag);
    else if (flag === "--max-cost-regression-pct") options.gate.maxCostRegressionPct = threshold(value, flag);
    else if (flag === "--max-patch-error-rate") options.gate.maxPatchErrorRate = threshold(value, flag);
    else if (flag === "--max-action-error-rate") options.gate.maxActionErrorRate = threshold(value, flag);
  }
  return options;
}

async function loadJson(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new BenchError("input_unavailable", "Could not read benchmark input file.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BenchError("invalid_input", "Benchmark input file is not valid JSON.");
  }
}

async function loadRunner(path) {
  if (!path) throw new BenchError("invalid_cli", "--live requires --runner.");
  let module;
  try {
    module = await import(pathToFileURL(resolve(path)).href);
  } catch {
    throw new BenchError("runner_unavailable", "Could not load the live runner module.");
  }
  return module.default ?? module;
}

export async function main(argv = process.argv.slice(2), io = process) {
  const options = parseArgs(argv);
  if (options.help || argv.length === 0) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (!options.input) throw new BenchError("invalid_cli", "--input is required.");
  const input = await loadJson(options.input);
  let reportInput = input;
  if (options.live) {
    const scenarios = Array.isArray(input) ? input : input?.scenarios;
    const runner = await loadRunner(options.runner);
    const result = await runLiveBenchmark({ scenarios, runner, enabled: true });
    reportInput = result.records;
  }
  const report = buildBenchmarkReport(reportInput, options.gate);
  const rendered = renderReport(report, options.format);
  if (options.output) await writeFile(options.output, rendered, "utf8");
  else io.stdout.write(rendered);
  return report.quality_gate.passed ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : "benchmark failed"}\n`);
    process.exitCode = 1;
  });
}

