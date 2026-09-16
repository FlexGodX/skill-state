import type { JsonObject } from "./types.js";

export type StateErrorCode =
  | "INVALID_JSON_VALUE"
  | "INVALID_ENVELOPE"
  | "INVALID_PATCH"
  | "SERIALIZED_SIZE_LIMIT"
  | "INVALID_SESSION_ID"
  | "INVALID_IDEMPOTENCY_KEY"
  | "PROCEDURE_REQUIRED"
  | "PROCEDURE_CONFLICT"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "ACTION_NOT_FOUND"
  | "ACTION_CONFLICT"
  | "CORRUPT_STORAGE"
  | "STORAGE_ERROR";

export class StateRuntimeError extends Error {
  public readonly code: StateErrorCode;
  public readonly details: JsonObject;

  public constructor(
    code: StateErrorCode,
    message: string,
    details: JsonObject = {},
  ) {
    super(message);
    this.name = "StateRuntimeError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isStateRuntimeError(error: unknown): error is StateRuntimeError {
  return error instanceof StateRuntimeError;
}
