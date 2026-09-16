import { StateRuntimeError } from "./errors.js";
import {
  assertBoundedJsonValue,
  assertJsonValue,
  cloneJson,
  isJsonObject,
  serializedByteLength,
} from "./json.js";
import { DEFAULT_STATE_LIMITS } from "./limits.js";
import type { JsonObject, JsonValue, StateLimits } from "./types.js";

export function assertMergePatch(
  value: unknown,
  limits: StateLimits = DEFAULT_STATE_LIMITS,
): JsonObject {
  if (!isJsonObject(value)) {
    throw new StateRuntimeError("INVALID_PATCH", "merge patch must be a JSON object");
  }
  assertBoundedJsonValue(value, "merge patch", limits, limits.maxPatchBytes);
  return cloneJson(value);
}

export function assertStateObject(
  value: unknown,
  limits: StateLimits = DEFAULT_STATE_LIMITS,
): JsonObject {
  if (!isJsonObject(value)) {
    throw new StateRuntimeError("CORRUPT_STORAGE", "session state must be a JSON object");
  }
  assertJsonValue(value, "session state", limits.maxDepth);
  const bytes = serializedByteLength(value);
  if (bytes > limits.maxStateBytes) {
    throw new StateRuntimeError("SERIALIZED_SIZE_LIMIT", "session state exceeds its serialized size limit", {
      bytes,
      maxBytes: limits.maxStateBytes,
    });
  }
  return cloneJson(value);
}

/**
 * RFC 7396-style object recursion with one explicit state rule: null in a
 * patch deletes the containing property and cannot be used to store null.
 * Arrays and scalar values replace the previous value atomically.
 */
export function applyMergePatch(
  target: JsonObject,
  patch: JsonObject,
  limits: StateLimits = DEFAULT_STATE_LIMITS,
): JsonObject {
  const safeTarget = assertStateObject(target, limits);
  const safePatch = assertMergePatch(patch, limits);
  const merged = mergeObject(safeTarget, safePatch, 0, limits.maxDepth);
  return assertStateObject(merged, limits);
}

function mergeObject(
  target: JsonObject,
  patch: JsonObject,
  depth: number,
  maxDepth: number,
): JsonObject {
  if (depth > maxDepth) {
    throw new StateRuntimeError("INVALID_PATCH", "merge patch exceeds the maximum nesting depth");
  }

  const result: JsonObject = cloneJson(target);
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === null) {
      delete result[key];
      continue;
    }

    if (isJsonObject(patchValue)) {
      const current = isJsonObject(result[key]) ? result[key] : {};
      result[key] = mergeObject(current, patchValue, depth + 1, maxDepth);
      continue;
    }

    result[key] = cloneJson(patchValue as JsonValue);
  }
  return result;
}
