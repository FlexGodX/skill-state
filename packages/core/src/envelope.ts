import { StateRuntimeError } from "./errors.js";
import { assertBoundedJsonValue, cloneJson } from "./json.js";
import { DEFAULT_STATE_LIMITS } from "./limits.js";
import { asRequestEnvelope, validateRequestEnvelope } from "./schema.js";
import type { JsonObject, JsonValue, RequestEnvelope, StateLimits } from "./types.js";

export function assertRequestEnvelope(
  value: unknown,
  limits: StateLimits = DEFAULT_STATE_LIMITS,
): RequestEnvelope {
  assertBoundedJsonValue(value, "request envelope", limits, limits.maxEnvelopeBytes);
  const validation = validateRequestEnvelope(value);
  if (!validation.valid) {
    throw new StateRuntimeError("INVALID_ENVELOPE", "request envelope failed JSON Schema validation", {
      issues: validation.errors.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }
  return cloneJson(asRequestEnvelope(value));
}

export function createRequestEnvelope<
  P extends JsonValue,
  Sigma extends JsonObject,
  O extends JsonObject,
>(
  p: P,
  sigma: Sigma,
  o: O,
  limits: StateLimits = DEFAULT_STATE_LIMITS,
): RequestEnvelope<P, Sigma, O> {
  return assertRequestEnvelope({ p, sigma, o }, limits) as RequestEnvelope<P, Sigma, O>;
}
