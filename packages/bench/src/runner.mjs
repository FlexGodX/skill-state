import { BenchError, normalizeRecords } from "./records.mjs";

/**
 * Adapt an explicitly supplied live runner. The benchmark package does not
 * provide transport, credentials, or a default provider implementation.
 */
export function createProviderRunner(runner) {
  if (typeof runner === "function") return { run: runner };
  if (runner && typeof runner.run === "function") return runner;
  throw new BenchError("invalid_runner", "A live runner must export run(scenario).");
}

export async function runLiveBenchmark({ scenarios, runner, enabled = false } = {}) {
  if (!enabled) return { invoked: false, records: [] };
  if (!Array.isArray(scenarios)) {
    throw new BenchError("invalid_scenarios", "Live benchmark scenarios must be an array.");
  }
  const providerRunner = createProviderRunner(runner);
  const results = [];
  for (const scenario of scenarios) {
    const result = await providerRunner.run(scenario);
    if (Array.isArray(result)) results.push(...result);
    else results.push(result);
  }
  return { invoked: true, records: normalizeRecords(results) };
}

