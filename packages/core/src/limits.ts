import type { StateLimits } from "./types.js";

export const DEFAULT_STATE_LIMITS: StateLimits = Object.freeze({
  maxEnvelopeBytes: 64 * 1024,
  maxStateBytes: 128 * 1024,
  maxPatchBytes: 64 * 1024,
  maxPendingBytes: 256 * 1024,
  maxDepth: 32,
  maxSessionIdLength: 128,
  maxIdempotencyKeyLength: 256,
});

export function resolveStateLimits(overrides: Partial<StateLimits> = {}): StateLimits {
  const limits: StateLimits = {
    ...DEFAULT_STATE_LIMITS,
    ...overrides,
  };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }

  return limits;
}
