import { createHash } from "node:crypto";
import { StateRuntimeError } from "./errors.js";
import {
  assertJsonValue,
  cloneJson,
  isJsonObject,
  stableStringify,
} from "./json.js";
import { assertMergePatch } from "./merge-patch.js";
import { DEFAULT_STATE_LIMITS, resolveStateLimits } from "./limits.js";
import { createRequestEnvelope } from "./envelope.js";
import { SessionStateStore } from "./store.js";
import type {
  JsonObject,
  JsonValue,
  PendingAction,
  ProcedureSpec,
  SessionSnapshot,
  StateLimits,
} from "./types.js";

export const CORE_PROTOCOL = "p+sigma+latest-o/v1" as const;

export interface CoreCallRequest {
  protocol: typeof CORE_PROTOCOL;
  endpoint: string;
  model: string;
  sessionId?: string;
  expectedRevision?: number;
  idempotencyKey?: string;
  latestObservation: unknown;
  request: {
    stream: boolean;
    controls: Record<string, unknown>;
    requestId: string;
  };
}

export interface CoreContext {
  p: JsonObject;
  sigma: JsonObject;
  o: JsonObject;
  projection: JsonObject;
  procedure: ProcedureSpec;
  procedureHash: string;
  latestObservation: JsonValue;
  prompt: string;
  sessionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  source: "skill-state-core";
}

export interface CoreCommitRequest {
  protocol?: typeof CORE_PROTOCOL;
  sessionId: string;
  expectedRevision?: number;
  idempotencyKey: string;
  procedureHash: string;
  statePatch: unknown;
  action: JsonValue;
}

export interface CoreCommitResult<S extends JsonObject = JsonObject> {
  sessionId: string;
  snapshot: SessionSnapshot<S>;
  patch: JsonObject;
  action: JsonValue;
  actionId: string;
  replayed: boolean;
  pendingAction: PendingAction<S> | undefined;
}

export interface SkillStateCoreOptions {
  rootDir?: string;
  store?: SessionStateStore;
  procedure?: ProcedureSpec;
  allowTestProcedureDefault?: boolean;
  limits?: Partial<StateLimits>;
  initialState?: JsonObject;
  clock?: () => string;
  idFactory?: () => string;
}

/**
 * The concrete gateway bridge. It owns the only state read/write boundary:
 * preparation creates a P/Σ/O envelope, and response commits use the same
 * session revision and idempotency key that were captured for that call.
 */
export class SkillStateCore {
  public readonly limits: StateLimits;
  public readonly store: SessionStateStore;
  public readonly procedure: ProcedureSpec;
  public readonly procedureHash: string;

  public constructor(options: SkillStateCoreOptions = {}) {
    this.limits = resolveStateLimits(options.limits);
    this.procedure = normalizeProcedure(options.procedure, options.allowTestProcedureDefault === true, this.limits);
    this.procedureHash = hashProcedure(this.procedure);
    if (options.store) {
      if (options.store.procedureHash !== this.procedureHash) {
        throw new StateRuntimeError(
          "PROCEDURE_CONFLICT",
          "provided store is bound to a different procedural specification",
        );
      }
      this.store = options.store;
    } else {
      const storeOptions: {
        limits: StateLimits;
        procedureHash: string;
        initialState?: JsonObject;
        clock?: () => string;
        idFactory?: () => string;
      } = { limits: this.limits, procedureHash: this.procedureHash };
      if (options.initialState !== undefined) storeOptions.initialState = options.initialState;
      if (options.clock !== undefined) storeOptions.clock = options.clock;
      if (options.idFactory !== undefined) storeOptions.idFactory = options.idFactory;
      this.store = new SessionStateStore(
        options.rootDir ?? process.env.SKILL_STATE_ROOT ?? ".skill-state",
        storeOptions,
      );
    }
  }

  public async prepareCall(input: CoreCallRequest): Promise<CoreContext> {
    if (input.protocol !== CORE_PROTOCOL) {
      throw new StateRuntimeError("INVALID_ENVELOPE", "unsupported core request protocol");
    }
    if (typeof input.model !== "string" || input.model.trim() === "") {
      throw new StateRuntimeError("INVALID_ENVELOPE", "model must be a non-empty string");
    }
    if (typeof input.request?.requestId !== "string" || input.request.requestId.length === 0) {
      throw new StateRuntimeError("INVALID_ENVELOPE", "requestId must be a non-empty string");
    }

    const sessionId = input.sessionId ?? `request-${input.request.requestId}`;
    const idempotencyKey = input.idempotencyKey ?? input.request.requestId;
    const snapshot = await this.store.read(sessionId);
    if (
      input.expectedRevision !== undefined
      && input.expectedRevision !== snapshot.revision
    ) {
      throw new StateRuntimeError(
        "REVISION_CONFLICT",
        "session revision does not match expectedRevision",
        {
          expectedRevision: input.expectedRevision,
          actualRevision: snapshot.revision,
        },
      );
    }

    const projection = asJsonObject({
      procedure: cloneJson(this.procedure),
      endpoint: input.endpoint,
      model: input.model,
      controls: input.request.controls,
    }, "request projection", this.limits);
    const sigma = asJsonObject({
      revision: snapshot.revision,
      state: snapshot.state,
    }, "session sigma", this.limits);
    const latestObservation = asJsonValue(
      input.latestObservation,
      "latest observation",
      this.limits,
    );
    const o = asJsonObject({ latestObservation }, "latest observation envelope", this.limits);
    const envelope = createRequestEnvelope(projection, sigma, o, this.limits);

    return {
      p: projection,
      sigma,
      o,
      projection,
      latestObservation,
      prompt: stableStringify(envelope),
      procedure: cloneJson(this.procedure),
      procedureHash: this.procedureHash,
      sessionId,
      expectedRevision: input.expectedRevision ?? snapshot.revision,
      idempotencyKey,
      source: "skill-state-core",
    };
  }

  public async buildContext(input: CoreCallRequest): Promise<CoreContext> {
    return this.prepareCall(input);
  }

  public async commitResponse(
    input: CoreCommitRequest,
  ): Promise<CoreCommitResult> {
    if (input.protocol !== undefined && input.protocol !== CORE_PROTOCOL) {
      throw new StateRuntimeError("INVALID_ENVELOPE", "unsupported core response protocol");
    }
    if (input.procedureHash !== this.procedureHash) {
      throw new StateRuntimeError(
        "PROCEDURE_CONFLICT",
        "response procedure does not match the session procedure",
      );
    }
    if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
      throw new StateRuntimeError("INVALID_SESSION_ID", "sessionId must be a non-empty string");
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new StateRuntimeError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey must be a non-empty string");
    }

    const patch = normalizeResponsePatch(input.statePatch, this.limits);
    const action = asJsonValue(input.action, "response action", this.limits);
    const applyOptions: { expectedRevision?: number; idempotencyKey: string } = {
      idempotencyKey: input.idempotencyKey,
    };
    if (input.expectedRevision !== undefined) applyOptions.expectedRevision = input.expectedRevision;
    const applied = await this.store.applyPatch(input.sessionId, patch, applyOptions);
    const pendingAction = await this.store.readAction(input.sessionId, input.idempotencyKey);
    if (!applied.actionId) {
      throw new StateRuntimeError("CORRUPT_STORAGE", "committed response has no action id");
    }
    return {
      sessionId: input.sessionId,
      snapshot: applied.snapshot,
      patch,
      action,
      actionId: applied.actionId,
      replayed: applied.replayed,
      pendingAction,
    };
  }
}

export function createSkillStateCore(options: SkillStateCoreOptions = {}): SkillStateCore {
  return new SkillStateCore(options);
}

export const TEST_PROCEDURE: ProcedureSpec = Object.freeze({
  id: "skill-state-test-procedure",
  version: 1,
});

export function normalizeProcedure(
  value: ProcedureSpec | undefined,
  allowTestDefault: boolean,
  limits: StateLimits = DEFAULT_STATE_LIMITS,
): ProcedureSpec {
  const candidate = value === undefined && allowTestDefault ? TEST_PROCEDURE : value;
  if (typeof candidate === "string") {
    if (candidate.trim() === "") {
      throw new StateRuntimeError("PROCEDURE_REQUIRED", "procedure must be non-empty");
    }
    return candidate.trim();
  }
  if (!isJsonObject(candidate) || Object.keys(candidate).length === 0) {
    throw new StateRuntimeError(
      "PROCEDURE_REQUIRED",
      "a non-empty trusted procedure is required",
    );
  }
  assertJsonValue(candidate, "procedure", limits.maxDepth);
  return cloneJson(candidate);
}

export function hashProcedure(procedure: ProcedureSpec): string {
  const value = typeof procedure === "string" ? procedure : stableStringify(procedure);
  return createHash("sha256").update(value).digest("hex");
}

function asJsonValue(value: unknown, label: string, limits: StateLimits): JsonValue {
  assertJsonValue(value, label, limits.maxDepth);
  return cloneJson(value);
}

function asJsonObject(value: unknown, label: string, limits: StateLimits): JsonObject {
  if (!isJsonObject(value)) {
    throw new StateRuntimeError("INVALID_ENVELOPE", `${label} must be a JSON object`);
  }
  assertJsonValue(value, label, limits.maxDepth);
  return cloneJson(value);
}

/**
 * Accept the documented set/delete response shorthand and turn it into the
 * core's explicit merge-patch representation. A plain object remains a merge
 * patch unchanged; null deletes a property at any nested path.
 */
export function normalizeResponsePatch(
  value: unknown,
  limits: StateLimits = DEFAULT_STATE_LIMITS,
): JsonObject {
  const input = assertMergePatch(value, limits);
  const hasShorthand = Object.prototype.hasOwnProperty.call(input, "set")
    || Object.prototype.hasOwnProperty.call(input, "delete");
  if (!hasShorthand) return input;

  const result: JsonObject = {};
  for (const [key, item] of Object.entries(input)) {
    if (key !== "set" && key !== "delete") result[key] = cloneJson(item);
  }

  const set = input.set;
  if (set !== undefined) {
    if (!isJsonObject(set)) {
      throw new StateRuntimeError("INVALID_PATCH", "state_patch.set must be a JSON object");
    }
    for (const [path, item] of Object.entries(set)) {
      setPath(result, path, cloneJson(item));
    }
  }

  const deleted = input.delete;
  if (deleted !== undefined) {
    if (!Array.isArray(deleted) || !deleted.every((item) => typeof item === "string")) {
      throw new StateRuntimeError("INVALID_PATCH", "state_patch.delete must be an array of paths");
    }
    for (const path of deleted) setPath(result, path, null);
  }

  return assertMergePatch(result, limits);
}

function setPath(target: JsonObject, path: string, value: JsonValue): void {
  if (path.length === 0) {
    throw new StateRuntimeError("INVALID_PATCH", "state_patch paths must be non-empty");
  }
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (part.length === 0 || part === "__proto__" || part === "prototype" || part === "constructor") {
      throw new StateRuntimeError("INVALID_PATCH", "state_patch contains an invalid path");
    }
    const existing = current[part];
    if (!isJsonObject(existing)) current[part] = {};
    current = current[part] as JsonObject;
  }
  const leaf = parts.at(-1);
  if (!leaf || leaf === "__proto__" || leaf === "prototype" || leaf === "constructor") {
    throw new StateRuntimeError("INVALID_PATCH", "state_patch contains an invalid path");
  }
  current[leaf] = value;
}
