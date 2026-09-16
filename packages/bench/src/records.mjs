export class BenchError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "BenchError";
    this.code = code;
    this.details = details;
  }
}

function assertRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BenchError("invalid_record", "Each benchmark result must be a JSON object.");
  }
}

function firstPresent(object, fields) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(object, field)) return object[field];
  }
  return undefined;
}

function numberValue(value, field, { integer = false, nullable = false } = {}) {
  if (value === undefined || value === null || value === "") return nullable ? null : 0;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    throw new BenchError("invalid_record", `${field} must be a finite non-negative ${integer ? "integer" : "number"}.`);
  }
  return number;
}

function countValue(value, field) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return value.length;
  return numberValue(value, field, { integer: true });
}

function modeValue(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[.-]/g, "_");
  if (["baseline", "transcript", "legacy"].includes(normalized)) return "baseline";
  if (["skill_state", "state", "skillstate"].includes(normalized)) return "skill_state";
  throw new BenchError("invalid_record", "mode must be baseline or skill_state.");
}

function usageValue(rawUsage, fields, field) {
  const usage = rawUsage ?? {};
  let value = firstPresent(usage, fields);
  if (value === undefined && field === "cached") {
    value = firstPresent(usage.prompt_tokens_details ?? {}, ["cached", "cached_tokens"]);
  }
  if (value === undefined && field === "reasoning") {
    value = firstPresent(usage.completion_tokens_details ?? {}, ["reasoning", "reasoning_tokens"]);
  }
  return countValue(value, `usage.${field}`);
}

function errorValue(raw, aliases, nestedAliases, field) {
  const direct = firstPresent(raw, aliases);
  if (direct !== undefined) return countValue(direct, field);
  const errors = raw.errors;
  if (errors && typeof errors === "object" && !Array.isArray(errors)) {
    const nested = firstPresent(errors, nestedAliases);
    if (nested !== undefined) return Array.isArray(nested) ? nested.length : countValue(nested, field);
  }
  return 0;
}

/**
 * Convert an untrusted scenario result to metrics only. Prompt/response bodies,
 * provider metadata, and unknown fields are intentionally not copied.
 */
export function normalizeRecord(raw, defaults = {}) {
  assertRecord(raw);
  const scenarioId = firstPresent(raw, ["scenario_id", "scenarioId", "id"]) ?? defaults.scenario_id;
  if (typeof scenarioId !== "string" || scenarioId.trim() === "") {
    throw new BenchError("invalid_record", "scenario_id must be a non-empty string.");
  }
  const mode = modeValue(firstPresent(raw, ["mode", "variant", "system"]) ?? defaults.mode);
  const qualityRaw = firstPresent(raw, ["quality_score", "qualityScore", "score"]);
  const qualityScore = qualityRaw === undefined || qualityRaw === null
    ? null
    : numberValue(qualityRaw, "quality_score");
  if (qualityScore !== null && qualityScore > 1) {
    throw new BenchError("invalid_record", "quality_score must be between 0 and 1.");
  }
  const usage = raw.usage ?? raw.token_usage ?? raw.tokens ?? {};
  if (typeof usage !== "object" || Array.isArray(usage)) {
    throw new BenchError("invalid_record", "usage must be a JSON object.");
  }
  const successValue = firstPresent(raw, ["success", "ok"]);
  const success = successValue === undefined
    ? String(raw.status ?? "").toLowerCase() === "success"
    : typeof successValue === "string"
      ? ["true", "1", "ok", "success", "passed"].includes(successValue.toLowerCase())
      : Boolean(successValue);

  const inputTokens = usageValue(usage, ["input", "input_tokens", "prompt_tokens"], "input");
  const outputTokens = usageValue(usage, ["output", "output_tokens", "completion_tokens"], "output");
  const cachedTokens = usageValue(usage, ["cached", "cached_tokens", "cache_read_tokens"], "cached");
  const reasoningTokens = usageValue(usage, ["reasoning", "reasoning_tokens"], "reasoning");
  return {
    scenario_id: scenarioId,
    mode,
    success,
    quality_score: qualityScore,
    latency_ms: numberValue(firstPresent(raw, ["latency_ms", "latencyMs", "latency"]), "latency_ms", { nullable: true }),
    steps: countValue(firstPresent(raw, ["steps", "step_count", "stepCount"]), "steps"),
    tool_calls: countValue(firstPresent(raw, ["tool_calls", "tool_count", "toolCount"]), "tool_calls"),
    patch_errors: errorValue(raw, ["patch_errors", "patchErrors", "patch_error"], ["patch", "patch_errors", "patchErrors"], "patch_errors"),
    action_errors: errorValue(raw, ["action_errors", "actionErrors", "action_error"], ["action", "action_errors", "actionErrors"], "action_errors"),
    usage: {
      input: inputTokens,
      output: outputTokens,
      cached: cachedTokens,
      reasoning: reasoningTokens,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cachedTokens,
      reasoning_tokens: reasoningTokens,
    },
    cost_usd: numberValue(firstPresent(raw, ["cost_usd", "costUsd", "cost"]), "cost_usd"),
  };
}

function expandInput(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") {
    throw new BenchError("invalid_input", "Benchmark input must be an array or an object with records/scenarios.");
  }
  if (Array.isArray(input.records)) return input.records;
  if (Array.isArray(input.scenarios)) {
    const expanded = [];
    for (const scenario of input.scenarios) {
      assertRecord(scenario);
      const scenarioId = scenario.scenario_id ?? scenario.scenarioId ?? scenario.id;
      if (scenario.baseline !== undefined || scenario.skill_state !== undefined || scenario.skillState !== undefined) {
        for (const [mode, result] of [["baseline", scenario.baseline], ["skill_state", scenario.skill_state ?? scenario.skillState]]) {
          if (result === undefined) continue;
          assertRecord(result);
          expanded.push({ ...result, scenario_id: scenarioId, mode });
        }
      } else if (Array.isArray(scenario.results)) {
        for (const result of scenario.results) expanded.push({ ...result, scenario_id: scenarioId });
      } else {
        expanded.push(scenario);
      }
    }
    return expanded;
  }
  throw new BenchError("invalid_input", "Benchmark input must contain records or scenarios.");
}

export function normalizeRecords(input) {
  return expandInput(input).map((record) => normalizeRecord(record));
}

export const redactRecord = normalizeRecord;
