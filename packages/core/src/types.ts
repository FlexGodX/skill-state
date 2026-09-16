export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type ProcedureSpec = string | JsonObject;

/**
 * The public request shape deliberately keeps the protocol surface small:
 * payload (p), session context (sigma), and operation options (o).
 */
export type RequestEnvelope<
  P extends JsonValue = JsonValue,
  Sigma extends JsonObject = JsonObject,
  O extends JsonObject = JsonObject,
> = JsonObject & {
  p: P;
  sigma: Sigma;
  o: O;
};

export interface StateLimits {
  maxEnvelopeBytes: number;
  maxStateBytes: number;
  maxPatchBytes: number;
  maxPendingBytes: number;
  maxDepth: number;
  maxSessionIdLength: number;
  maxIdempotencyKeyLength: number;
}

export interface SessionSnapshot<S extends JsonObject = JsonObject> {
  sessionId: string;
  revision: number;
  state: S;
  updatedAt: string;
}

export type ActionStatus = "pending" | "applied" | "rolled_back";

export interface PendingAction<S extends JsonObject = JsonObject> {
  formatVersion: 1;
  sessionId: string;
  actionId: string;
  idempotencyKey: string;
  baseRevision: number;
  patch: JsonObject;
  patchDigest: string;
  procedureHash?: string;
  before: SessionSnapshot<S>;
  status: ActionStatus;
  createdAt: string;
  appliedAt?: string;
  rollbackAt?: string;
  result?: SessionSnapshot<S>;
  rollbackSnapshot?: SessionSnapshot<S>;
}

export interface ApplyPatchOptions {
  expectedRevision?: number;
  idempotencyKey?: string;
}

export interface ApplyPatchResult<S extends JsonObject = JsonObject> {
  snapshot: SessionSnapshot<S>;
  actionId?: string;
  replayed: boolean;
}

export interface SessionStoreOptions {
  limits?: Partial<StateLimits>;
  procedureHash?: string;
  initialState?: JsonObject;
  clock?: () => string;
  idFactory?: () => string;
}
