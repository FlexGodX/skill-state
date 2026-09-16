import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StateRuntimeError, isStateRuntimeError } from "./errors.js";
import {
  assertJsonValue,
  assertSerializedSize,
  cloneJson,
  isJsonObject,
  serializedByteLength,
  stableStringify,
} from "./json.js";
import { applyMergePatch, assertMergePatch, assertStateObject } from "./merge-patch.js";
import { resolveStateLimits } from "./limits.js";
import type {
  ActionStatus,
  ApplyPatchOptions,
  ApplyPatchResult,
  JsonObject,
  PendingAction,
  SessionSnapshot,
  SessionStoreOptions,
  StateLimits,
} from "./types.js";

const STORAGE_FORMAT_VERSION = 1 as const;

interface PersistedSession<S extends JsonObject = JsonObject> extends SessionSnapshot<S> {
  formatVersion: 1;
  procedureHash?: string;
  lastActionId?: string;
}

interface SessionPaths {
  directory: string;
  state: string;
  actions: string;
}

/**
 * Versioned per-session state backed by atomic file replacement.
 *
 * Updates are serialized per session within a store instance. Callers can
 * provide expectedRevision to reject stale writes, while idempotency records
 * make a retried action return the original result rather than apply twice.
 */
export class SessionStateStore<S extends JsonObject = JsonObject> {
  private readonly rootDir: string;
  private readonly limits: StateLimits;
  private readonly initialState: S;
  private readonly clock: () => string;
  private readonly idFactory: () => string;
  public readonly procedureHash: string | undefined;
  private readonly lockTails = new Map<string, Promise<void>>();

  public constructor(rootDir: string, options: SessionStoreOptions = {}) {
    this.rootDir = rootDir;
    this.limits = resolveStateLimits(options.limits);
    this.procedureHash = options.procedureHash;
    if (this.procedureHash !== undefined && this.procedureHash.length === 0) {
      throw new StateRuntimeError("PROCEDURE_REQUIRED", "procedureHash must be non-empty");
    }
    this.initialState = assertStateObject(
      options.initialState ?? {},
      this.limits,
    ) as S;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  public async read(sessionId: string): Promise<SessionSnapshot<S>> {
    this.assertSessionId(sessionId);
    const record = await this.loadSession(sessionId);
    if (!record) {
      return {
        sessionId,
        revision: 0,
        state: cloneJson(this.initialState),
        updatedAt: this.clock(),
      };
    }
    return this.snapshot(record);
  }

  public async readAction(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<PendingAction<S> | undefined> {
    this.assertSessionId(sessionId);
    this.assertIdempotencyKey(idempotencyKey);
    return this.loadAction(sessionId, idempotencyKey);
  }

  public async applyPatch(
    sessionId: string,
    patchValue: unknown,
    options: ApplyPatchOptions = {},
  ): Promise<ApplyPatchResult<S>> {
    this.assertSessionId(sessionId);
    const patch = assertMergePatch(patchValue, this.limits);
    const idempotencyKey = options.idempotencyKey;
    if (idempotencyKey !== undefined) {
      this.assertIdempotencyKey(idempotencyKey);
    }
    if (options.expectedRevision !== undefined) {
      this.assertRevision(options.expectedRevision);
    }

    return this.withSessionLock(sessionId, async () => {
      const current = await this.loadSession(sessionId);
      const currentSnapshot = current
        ? this.snapshot(current)
        : this.emptySnapshot(sessionId);
      const expectedRevision = options.expectedRevision ?? currentSnapshot.revision;

      let action: PendingAction<S> | undefined;
      if (idempotencyKey !== undefined) {
        action = await this.loadAction(sessionId, idempotencyKey);
        if (action) {
          this.assertMatchingAction(action, patch, expectedRevision);

          if (action.status === "applied") {
            if (!action.result) {
              throw this.corruptStorage("applied action has no result");
            }
            return {
              snapshot: cloneJson(action.result),
              actionId: action.actionId,
              replayed: true,
            };
          }

          if (action.status === "rolled_back") {
            throw new StateRuntimeError(
              "ACTION_CONFLICT",
              "idempotency key belongs to a rolled-back action",
            );
          }

          // A process can stop after the state file is replaced but before the
          // action record is marked applied. The state marker makes that retry
          // safe and repairs the action record without applying the patch again.
          if (
            current
            && current.lastActionId === action.actionId
            && current.revision === action.baseRevision + 1
          ) {
            const recovered = this.snapshot(current);
            const applied: PendingAction<S> = {
              ...action,
              status: "applied",
              appliedAt: this.clock(),
              result: recovered,
            };
            await this.writeAction(applied);
            return {
              snapshot: recovered,
              actionId: action.actionId,
              replayed: true,
            };
          }

          if (currentSnapshot.revision !== action.baseRevision) {
            throw new StateRuntimeError(
              "ACTION_CONFLICT",
              "pending action no longer matches the current session revision",
              {
                expectedRevision: action.baseRevision,
                actualRevision: currentSnapshot.revision,
              },
            );
          }
        }
      }

      if (currentSnapshot.revision !== expectedRevision) {
        throw new StateRuntimeError(
          "REVISION_CONFLICT",
          "session revision does not match expectedRevision",
          {
            expectedRevision,
            actualRevision: currentSnapshot.revision,
          },
        );
      }

      const nextState = assertStateObject(
        applyPatchToSnapshot(currentSnapshot, patch, this.limits),
        this.limits,
      ) as S;
      const nextSnapshot: SessionSnapshot<S> = {
        sessionId,
        revision: currentSnapshot.revision + 1,
        state: nextState,
        updatedAt: this.clock(),
      };

      if (idempotencyKey !== undefined) {
        if (!action) {
          action = {
            formatVersion: STORAGE_FORMAT_VERSION,
            sessionId,
            actionId: this.idFactory(),
            idempotencyKey,
            baseRevision: currentSnapshot.revision,
            patch: cloneJson(patch),
            patchDigest: digestPatch(patch),
            before: cloneJson(currentSnapshot),
            status: "pending",
            createdAt: this.clock(),
          };
          await this.writeAction(action);
        }

        await this.writeSession({
          ...nextSnapshot,
          formatVersion: STORAGE_FORMAT_VERSION,
          lastActionId: action.actionId,
        });

        const applied: PendingAction<S> = {
          ...action,
          status: "applied",
          appliedAt: this.clock(),
          result: cloneJson(nextSnapshot),
        };
        await this.writeAction(applied);
        return {
          snapshot: nextSnapshot,
          actionId: action.actionId,
          replayed: false,
        };
      }

      await this.writeSession({
        ...nextSnapshot,
        formatVersion: STORAGE_FORMAT_VERSION,
      });
      return { snapshot: nextSnapshot, replayed: false };
    });
  }

  /**
   * Replays a pending action using the patch stored on disk. If the action was
   * already applied, the original result is returned; a rolled-back key never
   * silently starts a new action.
   */
  public async retryAction(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<ApplyPatchResult<S>> {
    this.assertSessionId(sessionId);
    this.assertIdempotencyKey(idempotencyKey);
    const action = await this.loadAction(sessionId, idempotencyKey);
    if (!action) {
      throw new StateRuntimeError("ACTION_NOT_FOUND", "no action exists for idempotency key");
    }
    if (action.status === "applied") {
      if (!action.result) {
        throw this.corruptStorage("applied action has no result");
      }
      return {
        snapshot: cloneJson(action.result),
        actionId: action.actionId,
        replayed: true,
      };
    }
    if (action.status === "rolled_back") {
      throw new StateRuntimeError(
        "ACTION_CONFLICT",
        "cannot retry a rolled-back action",
      );
    }
    return this.applyPatch(sessionId, action.patch, {
      expectedRevision: action.baseRevision,
      idempotencyKey,
    });
  }

  /**
   * Rolls back an applied action only while it is the latest state revision.
   * A pending action that has not changed state is simply marked rolled back.
   */
  public async rollbackAction(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<SessionSnapshot<S>> {
    this.assertSessionId(sessionId);
    this.assertIdempotencyKey(idempotencyKey);

    return this.withSessionLock(sessionId, async () => {
      const action = await this.loadAction(sessionId, idempotencyKey);
      if (!action) {
        throw new StateRuntimeError("ACTION_NOT_FOUND", "no action exists for idempotency key");
      }

      const current = await this.loadSession(sessionId);
      const currentSnapshot = current
        ? this.snapshot(current)
        : this.emptySnapshot(sessionId);

      if (action.status === "rolled_back") {
        return cloneJson(action.rollbackSnapshot ?? currentSnapshot);
      }

      if (action.status === "pending") {
        if (
          current
          && current.lastActionId === action.actionId
          && current.revision === action.baseRevision + 1
        ) {
          action.status = "applied";
          action.appliedAt = this.clock();
          action.result = currentSnapshot;
        } else {
          action.status = "rolled_back";
          action.rollbackAt = this.clock();
          action.rollbackSnapshot = cloneJson(currentSnapshot);
          await this.writeAction(action);
          return currentSnapshot;
        }
      }

      if (action.status !== "applied" || !action.result) {
        throw this.corruptStorage("action cannot be rolled back safely");
      }
      if (
        currentSnapshot.revision !== action.result.revision
        || current?.lastActionId !== action.actionId
      ) {
        throw new StateRuntimeError(
          "ACTION_CONFLICT",
          "cannot roll back an action after a later state change",
          {
            actionRevision: action.result.revision,
            actualRevision: currentSnapshot.revision,
          },
        );
      }

      const restored: SessionSnapshot<S> = {
        sessionId,
        revision: currentSnapshot.revision + 1,
        state: cloneJson(action.before.state),
        updatedAt: this.clock(),
      };
      await this.writeSession({
        ...restored,
        formatVersion: STORAGE_FORMAT_VERSION,
      });
      action.status = "rolled_back";
      action.rollbackAt = this.clock();
      action.rollbackSnapshot = cloneJson(restored);
      await this.writeAction(action);
      return restored;
    });
  }

  private async loadSession(sessionId: string): Promise<PersistedSession<S> | undefined> {
    const paths = this.paths(sessionId);
    const raw = await this.readJsonFile(paths.state, this.limits.maxStateBytes, "state record");
    if (raw === undefined) {
      return undefined;
    }
    if (!isJsonObject(raw)) {
      throw this.corruptStorage("state record is not an object");
    }
    const state = raw.state;
    if (!isJsonObject(state)) {
      throw this.corruptStorage("state record has no object state");
    }
    if (
      raw.formatVersion !== STORAGE_FORMAT_VERSION
      || raw.sessionId !== sessionId
      || !isNonNegativeInteger(raw.revision)
      || typeof raw.updatedAt !== "string"
      || (raw.lastActionId !== undefined && typeof raw.lastActionId !== "string")
    ) {
      throw this.corruptStorage("state record has invalid version or fields");
    }
    if (raw.procedureHash !== undefined && this.procedureHash === undefined) {
      throw new StateRuntimeError(
        "PROCEDURE_REQUIRED",
        "session is bound to a procedure but this store has no procedureHash",
      );
    }
    if (this.procedureHash !== undefined && raw.procedureHash !== this.procedureHash) {
      throw new StateRuntimeError(
        "PROCEDURE_CONFLICT",
        "session is bound to a different procedural specification",
      );
    }
    try {
      assertJsonValue(raw, "state record", this.limits.maxDepth);
      const safeState = assertStateObject(state, this.limits) as S;
      const result: PersistedSession<S> = {
        formatVersion: STORAGE_FORMAT_VERSION,
        sessionId,
        revision: raw.revision,
        state: safeState,
        updatedAt: raw.updatedAt,
      };
      if (typeof raw.procedureHash === "string") {
        result.procedureHash = raw.procedureHash;
      }
      if (typeof raw.lastActionId === "string") {
        result.lastActionId = raw.lastActionId;
      }
      return result;
    } catch (error) {
      if (isStateRuntimeError(error)) {
        throw this.corruptStorage("state record failed validation");
      }
      throw error;
    }
  }

  private async loadAction(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<PendingAction<S> | undefined> {
    const raw = await this.readJsonFile(
      this.actionPath(sessionId, idempotencyKey),
      this.limits.maxPendingBytes,
      "pending action",
    );
    if (raw === undefined) {
      return undefined;
    }
    if (!isJsonObject(raw)) {
      throw this.corruptStorage("pending action is not an object");
    }
    if (
      raw.formatVersion !== STORAGE_FORMAT_VERSION
      || raw.sessionId !== sessionId
      || raw.idempotencyKey !== idempotencyKey
      || typeof raw.actionId !== "string"
      || !isNonNegativeInteger(raw.baseRevision)
      || typeof raw.patchDigest !== "string"
      || (raw.procedureHash !== undefined && typeof raw.procedureHash !== "string")
      || !isActionStatus(raw.status)
      || typeof raw.createdAt !== "string"
      || !isJsonObject(raw.patch)
      || !isJsonObject(raw.before)
    ) {
      throw this.corruptStorage("pending action has invalid fields");
    }
    if (raw.procedureHash !== undefined && this.procedureHash === undefined) {
      throw new StateRuntimeError(
        "PROCEDURE_REQUIRED",
        "pending action is bound to a procedure but this store has no procedureHash",
      );
    }
    if (this.procedureHash !== undefined && raw.procedureHash !== this.procedureHash) {
      throw new StateRuntimeError(
        "PROCEDURE_CONFLICT",
        "pending action is bound to a different procedural specification",
      );
    }

    try {
      assertJsonValue(raw, "pending action", this.limits.maxDepth);
      const patch = assertMergePatch(raw.patch, this.limits);
      const before = this.parseSnapshot(raw.before, sessionId);
      const action: PendingAction<S> = {
        formatVersion: STORAGE_FORMAT_VERSION,
        sessionId,
        actionId: raw.actionId,
        idempotencyKey,
        baseRevision: raw.baseRevision,
        patch,
        patchDigest: raw.patchDigest,
        before,
        status: raw.status,
        createdAt: raw.createdAt,
      };
      if (typeof raw.procedureHash === "string") action.procedureHash = raw.procedureHash;
      if (typeof raw.appliedAt === "string") action.appliedAt = raw.appliedAt;
      if (typeof raw.rollbackAt === "string") action.rollbackAt = raw.rollbackAt;
      if (raw.result !== undefined) action.result = this.parseSnapshot(raw.result, sessionId);
      if (raw.rollbackSnapshot !== undefined) {
        action.rollbackSnapshot = this.parseSnapshot(raw.rollbackSnapshot, sessionId);
      }
      return action;
    } catch (error) {
      if (isStateRuntimeError(error)) {
        throw this.corruptStorage("pending action failed validation");
      }
      throw error;
    }
  }

  private parseSnapshot(value: JsonValueLike, sessionId: string): SessionSnapshot<S> {
    if (
      !isJsonObject(value)
      || value.sessionId !== sessionId
      || !isNonNegativeInteger(value.revision)
      || typeof value.updatedAt !== "string"
      || !isJsonObject(value.state)
    ) {
      throw this.corruptStorage("action snapshot has invalid fields");
    }
    return {
      sessionId,
      revision: value.revision,
      state: assertStateObject(value.state, this.limits) as S,
      updatedAt: value.updatedAt,
    };
  }

  private async writeSession(record: PersistedSession<S>): Promise<void> {
    const persisted: PersistedSession<S> = { ...record };
    if (this.procedureHash !== undefined) persisted.procedureHash = this.procedureHash;
    const value: JsonObject = persisted as unknown as JsonObject;
    await this.writeJsonAtomic(
      this.paths(record.sessionId).state,
      value,
      this.limits.maxStateBytes,
      "state record",
    );
  }

  private async writeAction(action: PendingAction<S>): Promise<void> {
    const persisted: PendingAction<S> = { ...action };
    if (this.procedureHash !== undefined) persisted.procedureHash = this.procedureHash;
    await this.writeJsonAtomic(
      this.actionPath(action.sessionId, action.idempotencyKey),
      persisted as unknown as JsonObject,
      this.limits.maxPendingBytes,
      "pending action",
    );
  }

  private async writeJsonAtomic(
    filePath: string,
    value: JsonObject,
    maxBytes: number,
    label: string,
  ): Promise<void> {
    assertJsonValue(value, label, this.limits.maxDepth);
    assertSerializedSize(value, maxBytes, label);
    const serialized = stableStringify(value);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    await mkdir(dirname(filePath), { recursive: true });
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (isStateRuntimeError(error)) {
        throw error;
      }
      throw new StateRuntimeError("STORAGE_ERROR", `${label} could not be written`);
    }
  }

  private async readJsonFile(
    filePath: string,
    maxBytes: number,
    label: string,
  ): Promise<JsonValueLike | undefined> {
    let fileStats;
    try {
      fileStats = await stat(filePath);
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw new StateRuntimeError("STORAGE_ERROR", `${label} could not be inspected`);
    }
    if (fileStats.size > maxBytes) {
      throw new StateRuntimeError("SERIALIZED_SIZE_LIMIT", `${label} exceeds its serialized size limit`, {
        bytes: fileStats.size,
        maxBytes,
      });
    }

    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      throw new StateRuntimeError("STORAGE_ERROR", `${label} could not be read`);
    }
    if (serializedByteLength(text) > maxBytes) {
      throw new StateRuntimeError("SERIALIZED_SIZE_LIMIT", `${label} exceeds its serialized size limit`, {
        bytes: serializedByteLength(text),
        maxBytes,
      });
    }
    try {
      return JSON.parse(text) as JsonValueLike;
    } catch {
      throw this.corruptStorage(`${label} contains invalid JSON`);
    }
  }

  private snapshot(record: PersistedSession<S>): SessionSnapshot<S> {
    return {
      sessionId: record.sessionId,
      revision: record.revision,
      state: cloneJson(record.state),
      updatedAt: record.updatedAt,
    };
  }

  private emptySnapshot(sessionId: string): SessionSnapshot<S> {
    return {
      sessionId,
      revision: 0,
      state: cloneJson(this.initialState),
      updatedAt: this.clock(),
    };
  }

  private assertMatchingAction(
    action: PendingAction<S>,
    patch: JsonObject,
    expectedRevision: number,
  ): void {
    if (
      action.patchDigest !== digestPatch(patch)
      || action.baseRevision !== expectedRevision
    ) {
      throw new StateRuntimeError(
        "IDEMPOTENCY_CONFLICT",
        "idempotency key was reused with a different patch or revision",
      );
    }
  }

  private paths(sessionId: string): SessionPaths {
    const directory = join(this.rootDir, "sessions", encodePathPart(sessionId));
    return {
      directory,
      state: join(directory, "state.json"),
      actions: join(directory, "actions"),
    };
  }

  private actionPath(sessionId: string, idempotencyKey: string): string {
    return join(this.paths(sessionId).actions, `${encodePathPart(idempotencyKey)}.json`);
  }

  private assertSessionId(sessionId: string): void {
    if (
      typeof sessionId !== "string"
      || sessionId.length === 0
      || sessionId.length > this.limits.maxSessionIdLength
      || /[\u0000-\u001f\u007f]/u.test(sessionId)
    ) {
      throw new StateRuntimeError("INVALID_SESSION_ID", "sessionId must be a bounded non-empty string");
    }
  }

  private assertIdempotencyKey(idempotencyKey: string): void {
    if (
      typeof idempotencyKey !== "string"
      || idempotencyKey.length === 0
      || idempotencyKey.length > this.limits.maxIdempotencyKeyLength
      || /[\u0000-\u001f\u007f]/u.test(idempotencyKey)
    ) {
      throw new StateRuntimeError(
        "INVALID_IDEMPOTENCY_KEY",
        "idempotencyKey must be a bounded non-empty string",
      );
    }
  }

  private assertRevision(revision: number): void {
    if (!isNonNegativeInteger(revision)) {
      throw new StateRuntimeError("REVISION_CONFLICT", "expectedRevision must be a non-negative integer");
    }
  }

  private corruptStorage(message: string): StateRuntimeError {
    return new StateRuntimeError("CORRUPT_STORAGE", message);
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lockTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => next);
    this.lockTails.set(sessionId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lockTails.get(sessionId) === queued) {
        this.lockTails.delete(sessionId);
      }
    }
  }
}

type JsonValueLike = JsonObject | JsonValueArray | string | number | boolean | null;
interface JsonValueArray extends Array<JsonValueLike> {}

function applyPatchToSnapshot(
  snapshot: SessionSnapshot,
  patch: JsonObject,
  limits: StateLimits,
): JsonObject {
  return applyMergePatch(snapshot.state, patch, limits);
}

function digestPatch(patch: JsonObject): string {
  return createHash("sha256").update(stableStringify(patch)).digest("hex");
}

function isActionStatus(value: unknown): value is ActionStatus {
  return value === "pending" || value === "applied" || value === "rolled_back";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function encodePathPart(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "ENOENT",
  );
}
