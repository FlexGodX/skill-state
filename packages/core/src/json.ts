import { StateRuntimeError } from "./errors.js";
import type { JsonObject, JsonValue, StateLimits } from "./types.js";

const FORBIDDEN_KEYS = new Set(["transcript", "__proto__", "prototype", "constructor"]);

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function isJsonValue(value: unknown, maxDepth = 100, depth = 0): value is JsonValue {
  if (depth > maxDepth) {
    return false;
  }

  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, maxDepth, depth + 1));
  }

  if (isJsonObject(value)) {
    return Object.entries(value).every(
      ([key, item]) => !FORBIDDEN_KEYS.has(key) && isJsonValue(item, maxDepth, depth + 1),
    );
  }

  return false;
}

export function assertJsonValue(
  value: unknown,
  label = "value",
  maxDepth = 100,
): asserts value is JsonValue {
  if (!isJsonValue(value, maxDepth)) {
    throw new StateRuntimeError("INVALID_JSON_VALUE", `${label} is not a supported JSON value`);
  }
}

export function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as T;
  }

  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = cloneJson(item);
  }
  return result as T;
}

/**
 * Stable JSON is used for byte bounds and digests, so equivalent objects have
 * the same serialized representation regardless of insertion order.
 */
export function stableStringify(value: JsonValue): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] as JsonValue)}`);
  return `{${entries.join(",")}}`;
}

export function serializedByteLength(value: JsonValue): number {
  return new TextEncoder().encode(stableStringify(value)).byteLength;
}

export function assertSerializedSize(
  value: JsonValue,
  maxBytes: number,
  label: string,
): void {
  const bytes = serializedByteLength(value);
  if (bytes > maxBytes) {
    throw new StateRuntimeError("SERIALIZED_SIZE_LIMIT", `${label} exceeds its serialized size limit`, {
      bytes,
      maxBytes,
    });
  }
}

export function assertBoundedJsonValue(
  value: unknown,
  label: string,
  limits: StateLimits,
  maxBytes: number,
): asserts value is JsonValue {
  assertJsonValue(value, label, limits.maxDepth);
  assertSerializedSize(value, maxBytes, label);
}

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}
