import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  StateRuntimeError,
  SessionStateStore,
  applyMergePatch,
  assertRequestEnvelope,
  createRequestEnvelope,
} from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("request envelope and merge patch", () => {
  it("validates the P+Sigma+O envelope and rejects unknown or forbidden fields", () => {
    const envelope = createRequestEnvelope(
      { command: "set", values: [1, true] },
      { session: "s-1" },
      { requestId: "r-1" },
    );
    assert.deepEqual(envelope.p, { command: "set", values: [1, true] });

    assert.throws(
      () => assertRequestEnvelope({ p: {}, sigma: {}, o: {}, extra: true }),
      (error: unknown) => error instanceof StateRuntimeError && error.code === "INVALID_ENVELOPE",
    );
    assert.throws(
      () => assertRequestEnvelope({ p: { transcript: "not accepted" }, sigma: {}, o: {} }),
      (error: unknown) => error instanceof StateRuntimeError && error.code === "INVALID_JSON_VALUE",
    );
  });

  it("recursively merges objects, deletes null properties, and replaces arrays", () => {
    const target = {
      keep: true,
      nested: { old: "removed", preserved: 1 },
      list: [1, 2],
    };
    const patch = {
      nested: { old: null, added: "new" },
      list: [3],
    };

    const merged = applyMergePatch(target, patch);
    assert.deepEqual(merged, {
      keep: true,
      nested: { preserved: 1, added: "new" },
      list: [3],
    });
    assert.deepEqual(target, {
      keep: true,
      nested: { old: "removed", preserved: 1 },
      list: [1, 2],
    });
    assert.throws(
      () => applyMergePatch(target, "replace-root" as never),
      (error: unknown) => error instanceof StateRuntimeError && error.code === "INVALID_PATCH",
    );
  });
});

describe("SessionStateStore", () => {
  it("persists revisions, replays idempotent actions, and rolls back safely", async () => {
    const root = await makeTemporaryRoot();
    const store = new SessionStateStore(root, {
      initialState: { count: 0, nested: { keep: true } },
      clock: () => "2026-01-01T00:00:00.000Z",
      idFactory: () => "action-1",
    });

    const initial = await store.read("session-a");
    assert.equal(initial.revision, 0);
    const applied = await store.applyPatch(
      "session-a",
      { count: 1, nested: { created: "yes" } },
      { expectedRevision: 0, idempotencyKey: "request-1" },
    );
    assert.equal(applied.snapshot.revision, 1);
    assert.equal(applied.replayed, false);

    const replay = await store.applyPatch(
      "session-a",
      { count: 1, nested: { created: "yes" } },
      { expectedRevision: 0, idempotencyKey: "request-1" },
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.snapshot, applied.snapshot);

    await assert.rejects(
      store.applyPatch(
        "session-a",
        { count: 2 },
        { expectedRevision: 0, idempotencyKey: "request-1" },
      ),
      (error: unknown) => error instanceof StateRuntimeError && error.code === "IDEMPOTENCY_CONFLICT",
    );
    await assert.rejects(
      store.applyPatch("session-a", { count: 2 }, { expectedRevision: 0, idempotencyKey: "request-2" }),
      (error: unknown) => error instanceof StateRuntimeError && error.code === "REVISION_CONFLICT",
    );

    const rolledBack = await store.rollbackAction("session-a", "request-1");
    assert.equal(rolledBack.revision, 2);
    assert.deepEqual(rolledBack.state, { count: 0, nested: { keep: true } });
    await assert.rejects(
      store.retryAction("session-a", "request-1"),
      (error: unknown) => error instanceof StateRuntimeError && error.code === "ACTION_CONFLICT",
    );
    assert.deepEqual((await store.read("session-a")).state, rolledBack.state);
  });

  it("leaves state and files unchanged when a patch is invalid", async () => {
    const root = await makeTemporaryRoot();
    const store = new SessionStateStore(root, {
      initialState: { value: 1 },
      limits: { maxPatchBytes: 16 },
    });
    await assert.rejects(
      store.applyPatch("session-b", ["root patch is invalid"]),
      (error: unknown) => error instanceof StateRuntimeError && error.code === "INVALID_PATCH",
    );
    const snapshot = await store.read("session-b");
    assert.equal(snapshot.revision, 0);
    assert.deepEqual(snapshot.state, { value: 1 });
    await assert.rejects(
      store.applyPatch(
        "session-b",
        { value: "x".repeat(50) },
        { idempotencyKey: "too-large" },
      ),
      (error: unknown) => error instanceof StateRuntimeError && error.code === "SERIALIZED_SIZE_LIMIT",
    );
  });

  it("serializes concurrent updates and accepts exactly one stale revision", async () => {
    const root = await makeTemporaryRoot();
    const store = new SessionStateStore(root, { initialState: {} });
    const results = await Promise.allSettled([
      store.applyPatch("session-c", { first: true }, { expectedRevision: 0, idempotencyKey: "c-1" }),
      store.applyPatch("session-c", { second: true }, { expectedRevision: 0, idempotencyKey: "c-2" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof StateRuntimeError);
    assert.equal(rejected.reason.code, "REVISION_CONFLICT");

    const sessionDirectory = join(root, "sessions");
    const sessionEntries = await readdir(sessionDirectory);
    assert.equal(sessionEntries.length, 1);
    const files = await collectFiles(join(sessionDirectory, sessionEntries[0] as string));
    assert.equal(files.some((file) => file.includes(".tmp-")), false);
  });

  it("fails closed when a procedure-bound record is opened without its hash", async () => {
    const root = await makeTemporaryRoot();
    const bound = new SessionStateStore(root, {
      procedureHash: "trusted-procedure-hash",
      initialState: { count: 0 },
    });
    await bound.applyPatch("bound-session", { count: 1 }, {
      expectedRevision: 0,
      idempotencyKey: "bound-turn-1",
    });

    const unbound = new SessionStateStore(root, { initialState: { count: 99 } });
    await assert.rejects(
      unbound.read("bound-session"),
      (error: unknown) => error instanceof StateRuntimeError && error.code === "PROCEDURE_REQUIRED",
    );
    await assert.rejects(
      unbound.readAction("bound-session", "bound-turn-1"),
      (error: unknown) => error instanceof StateRuntimeError && error.code === "PROCEDURE_REQUIRED",
    );
  });
});

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skill-state-core-"));
  temporaryRoots.push(root);
  return root;
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
}
