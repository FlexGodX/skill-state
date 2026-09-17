import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSkillStateCore } from "@skill-state/core";
import {
  CHAT_COMPLETIONS_PATH,
  createGateway,
  createUpstreamClient,
  ENVELOPE_SCHEMA,
  MAX_DEBUG_CAPTURE_BYTES,
  extractLatestObservation,
  extractSessionId,
  parseStructuredOutput,
  RESPONSES_PATH,
  responsesUsageFromChatUsage,
  validateStructuredEnvelope,
} from "../src/index.mjs";

const TEST_PROCEDURE = Object.freeze({ id: "gateway-test-procedure", version: 1 });

function request(path, body, headers = {}) {
  return new Request(`http://gateway.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function providerChatBody(content) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1,
    model: "fake-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

test("builds P+Sigma+latest O and strips transcript fields before upstream", async () => {
  const coreCalls = [];
  const upstreamCalls = [];
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: {
      async prepareCall(input) {
        coreCalls.push(input);
        return {
          projection: { procedure: TEST_PROCEDURE, account: "p-1" },
          sigma: { mode: "ready" },
          latestObservation: input.latestObservation,
          prompt: JSON.stringify({
            projection: { account: "p-1" },
            sigma: { mode: "ready" },
            latestObservation: input.latestObservation,
          }),
        };
      },
      async commitResponse() {
        return { actionId: "mock-action", replayed: false };
      },
    },
    upstream: async ({ path, body }) => {
      upstreamCalls.push({ path, body });
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(providerChatBody(JSON.stringify({
          state_patch: { set: { "task.status": "done" } },
          action: { type: "notify", payload: { text: "done" } },
        }))),
      };
    },
  });

  const response = await gateway.handle(request("/v1/chat/completions", {
    model: "fake-model",
    session_id: "strip-session",
    stream: false,
    previous_response_id: "old-response-must-not-forward",
    previousResponseId: "old-camel-response-must-not-forward",
    system: "old system prompt must not override core",
    instructions: "old instructions must not override core",
    prompt: "old prompt must not override core",
    context: { transcript: "old context must not override core" },
    messages: [
      { role: "user", content: "old user turn" },
      { role: "assistant", content: "old assistant turn" },
    ],
    action_result: { operation: "lookup", value: 7 },
    latest_observation: { stale: true },
    controls: {
      temperature: 0.3,
      metadata: {
        messages: [{ role: "user", content: "nested old transcript" }],
        previous_response_id: "nested-old-response",
      },
    },
    metadata: {
      messages: [{ role: "user", content: "metadata old transcript" }],
      previous_response_id: "metadata-old-response",
      skill_state_session_id: "metadata-session-must-not-forward",
    },
    temperature: 0.2,
  }));

  assert.equal(response.status, 200);
  assert.equal(coreCalls.length, 1);
  assert.equal(coreCalls[0].protocol, "p+sigma+latest-o/v1");
  assert.deepEqual(coreCalls[0].latestObservation, {
    kind: "action_result",
    value: { operation: "lookup", value: 7 },
  });
  assert.equal(coreCalls[0].request.controls.temperature, 0.2);
  assert.equal("messages" in coreCalls[0].request.controls.metadata, false);
  assert.equal("previous_response_id" in coreCalls[0].request.controls.metadata, false);
  assert.equal("messages" in coreCalls[0], false);
  assert.equal("previous_response_id" in coreCalls[0], false);

  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].path, "/v1/chat/completions");
  assert.deepEqual(upstreamCalls[0].body.messages, [{
    role: "user",
    content: JSON.stringify({
      projection: { account: "p-1" },
      sigma: { mode: "ready" },
      latestObservation: {
        kind: "action_result",
        value: { operation: "lookup", value: 7 },
      },
    }),
  }]);
  assert.equal("previous_response_id" in upstreamCalls[0].body, false);
  assert.equal("previousResponseId" in upstreamCalls[0].body, false);
  assert.equal("system" in upstreamCalls[0].body, false);
  assert.equal("instructions" in upstreamCalls[0].body, false);
  assert.equal("prompt" in upstreamCalls[0].body, false);
  assert.equal("context" in upstreamCalls[0].body, false);
  assert.equal("controls" in upstreamCalls[0].body, false);
  assert.equal(upstreamCalls[0].body.temperature, 0.2);
  assert.equal("messages" in upstreamCalls[0].body.metadata, false);
  assert.equal("previous_response_id" in upstreamCalls[0].body.metadata, false);
  assert.equal("skill_state_session_id" in upstreamCalls[0].body.metadata, false);
  assert.equal(upstreamCalls[0].body.messages[0].content.includes("old user turn"), false);
  assert.equal(upstreamCalls[0].body.messages[0].content.includes("nested old transcript"), false);

  const output = await response.json();
  assert.deepEqual(output.state_patch, { set: { "task.status": "done" } });
  assert.deepEqual(output.action, { type: "notify", payload: { text: "done" } });
});

test("action/tool results take precedence over a stale generic observation", async () => {
  let coreObservation;
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: {
      async prepareCall(input) {
        coreObservation = input.latestObservation;
        return {
          projection: { procedure: TEST_PROCEDURE },
          sigma: {},
          latestObservation: input.latestObservation,
          prompt: "canonical",
        };
      },
      async commitResponse() {},
    },
    upstream: async () => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(providerChatBody(JSON.stringify({ state_patch: {}, action: null }))),
    }),
  });
  const response = await gateway.handle(request("/v1/chat/completions", {
    model: "fake-model",
    session_id: "observation-session",
    latest_observation: { stale: true },
    action_result: { fresh: true },
    messages: [{ role: "user", content: "old" }],
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(coreObservation, { kind: "action_result", value: { fresh: true } });
});

test("fails closed when a production request has no stable session", async () => {
  let coreCalls = 0;
  let upstreamCalls = 0;
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: {
      async prepareCall() {
        coreCalls += 1;
        return { projection: {}, sigma: {}, prompt: "must-not-run" };
      },
      async commitResponse() {},
    },
    upstream: async () => {
      upstreamCalls += 1;
      return { status: 200, contentType: "application/json", body: "{}" };
    },
  });

  const response = await gateway.handle(request("/v1/chat/completions", {
    model: "fake-model",
    messages: [{ role: "user", content: "hello" }],
  }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "missing_session_id");
  assert.equal(coreCalls, 0);
  assert.equal(upstreamCalls, 0);
});

test("uses the trusted session header first and strips all session routing fields upstream", async () => {
  let coreInput;
  let upstreamBody;
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: {
      async prepareCall(input) {
        coreInput = input;
        return {
          projection: { procedure: TEST_PROCEDURE },
          sigma: {},
          latestObservation: input.latestObservation,
          prompt: "canonical",
        };
      },
      async commitResponse() {},
    },
    upstream: async ({ body }) => {
      upstreamBody = body;
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(providerChatBody(JSON.stringify({ state_patch: {}, action: null }))),
      };
    },
  });

  const response = await gateway.handle(request("/v1/chat/completions", {
    model: "fake-model",
    session_id: "body-session",
    sessionId: "body-camel-session",
    state_session_id: "body-legacy-session",
    metadata: {
      skill_state_session_id: "metadata-session",
      client_metadata: { thread_id: "nested-provider-session" },
      keep: "safe-metadata",
    },
    client_metadata: { session_id: "provider-session" },
    prompt_cache_key: "cache-routing-key",
    messages: [{ role: "user", content: "hello" }],
  }, { "x-skill-state-session": "header-session" }));

  assert.equal(response.status, 200);
  assert.equal(coreInput.sessionId, "header-session");
  assert.equal("session_id" in upstreamBody, false);
  assert.equal("sessionId" in upstreamBody, false);
  assert.equal("state_session_id" in upstreamBody, false);
  assert.equal("client_metadata" in upstreamBody, false);
  assert.equal("prompt_cache_key" in upstreamBody, false);
  assert.equal(upstreamBody.metadata.skill_state_session_id, undefined);
  assert.equal(upstreamBody.metadata.client_metadata, undefined);
  assert.equal(upstreamBody.metadata.keep, "safe-metadata");
});

test("uses final Chat tool and Responses function output as latest observation", () => {
  const chatTool = {
    role: "tool",
    tool_call_id: "call-chat",
    content: "fresh chat result",
  };
  assert.deepEqual(
    extractLatestObservation({
      latest_observation: { stale: true },
      messages: [
        { role: "user", content: "old user" },
        { role: "assistant", content: "old assistant" },
        chatTool,
      ],
    }, CHAT_COMPLETIONS_PATH),
    { kind: "tool_result", value: chatTool },
  );

  const responsesTool = {
    type: "function_call_output",
    call_id: "call-response",
    output: "fresh Responses result",
  };
  assert.deepEqual(
    extractLatestObservation({
      input: [
        { role: "user", content: "old user" },
        responsesTool,
      ],
    }, RESPONSES_PATH),
    { kind: "tool_result", value: responsesTool },
  );
});

test("validates session ids and keeps fallback opt-in for tests", async () => {
  assert.equal(extractSessionId({
    body: { metadata: { skill_state_session_id: "metadata-session" } },
    endpoint: CHAT_COMPLETIONS_PATH,
    requestId: "metadata-request",
  }), "metadata-session");
  assert.equal(extractSessionId({
    body: { client_metadata: { session_id: "codex-body-session", thread_id: "codex-thread" } },
    headers: { "session-id": "codex-header-session", "thread-id": "codex-header-thread" },
    endpoint: CHAT_COMPLETIONS_PATH,
    requestId: "provider-request",
  }), "codex-header-session");
  assert.equal(extractSessionId({
    body: { client_metadata: { session_id: "codex-body-session", thread_id: "codex-thread" } },
    headers: { "thread-id": "codex-header-thread" },
    endpoint: CHAT_COMPLETIONS_PATH,
    requestId: "provider-thread-request",
  }), "codex-header-thread");
  assert.equal(extractSessionId({
    body: { client_metadata: { session_id: "codex-body-session", thread_id: "codex-thread" } },
    endpoint: CHAT_COMPLETIONS_PATH,
    requestId: "provider-body-request",
  }), "codex-body-session");
  assert.equal(extractSessionId({
    body: { conversation: "conv_123" },
    endpoint: RESPONSES_PATH,
    requestId: "conversation-request",
  }), "conv_123");

  const invalidGateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: {
      async prepareCall() {
        throw new Error("must not prepare");
      },
      async commitResponse() {},
    },
    upstream: async () => ({ status: 200, contentType: "application/json", body: "{}" }),
  });
  const invalid = await invalidGateway.handle(request("/v1/chat/completions", {
    model: "fake-model",
    session_id: "x".repeat(129),
    messages: [{ role: "user", content: "hello" }],
  }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "invalid_session_id");

  let fallbackSession;
  const fallbackGateway = createGateway({
    procedure: TEST_PROCEDURE,
    allowTestSessionFallback: true,
    core: {
      async prepareCall(input) {
        fallbackSession = input.sessionId;
        return {
          projection: { procedure: TEST_PROCEDURE },
          sigma: {},
          latestObservation: input.latestObservation,
          prompt: "canonical",
        };
      },
      async commitResponse() {},
    },
    upstream: async () => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(providerChatBody(JSON.stringify({ state_patch: {}, action: null }))),
    }),
  });
  const fallback = await fallbackGateway.handle(request("/v1/chat/completions", {
    model: "fake-model",
    messages: [{ role: "user", content: "test only" }],
  }));
  assert.equal(fallback.status, 200);
  assert.match(fallbackSession, /^request-/);
});

test("isolates concurrent state transitions by session", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-state-gateway-concurrent-"));
  try {
    const core = createSkillStateCore({
      rootDir: root,
      procedure: TEST_PROCEDURE,
      initialState: { marker: "unset" },
    });
    const gateway = createGateway({
      core,
      upstream: async ({ body }) => {
        const envelope = JSON.parse(body.messages[0].content);
        const marker = envelope.o.latestObservation.value;
        await new Promise((resolve) => setTimeout(resolve, marker === "A" ? 20 : 0));
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(providerChatBody(JSON.stringify({
            state_patch: { set: { marker } },
            action: null,
          }))),
        };
      },
    });

    await Promise.all([
      gateway.handle(request("/v1/chat/completions", {
        model: "fake-model",
        session_id: "session-a",
        messages: [{ role: "user", content: "A" }],
      })),
      gateway.handle(request("/v1/chat/completions", {
        model: "fake-model",
        session_id: "session-b",
        messages: [{ role: "user", content: "B" }],
      })),
    ]);

    assert.deepEqual((await core.store.read("session-a")).state, { marker: "A" });
    assert.deepEqual((await core.store.read("session-b")).state, { marker: "B" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a provider call when the core cannot commit a transition", async () => {
  let upstreamCalls = 0;
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: {
      async prepareCall(input) {
        return { projection: { procedure: TEST_PROCEDURE }, sigma: {}, latestObservation: input.latestObservation, prompt: "canonical" };
      },
    },
    upstream: async () => {
      upstreamCalls += 1;
      return { status: 200, contentType: "application/json", body: "{}" };
    },
  });
  const response = await gateway.handle(request("/v1/chat/completions", {
    model: "fake-model",
    session_id: "commitless-session",
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "core_commit_unavailable");
  assert.equal(upstreamCalls, 0);
});

test("rejects an invalid state patch and never exposes its action", async () => {
  let upstreamCalls = 0;
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: {
      async prepareCall(input) {
        return {
          projection: { procedure: TEST_PROCEDURE },
          sigma: {},
          latestObservation: input.latestObservation,
          prompt: "canonical prompt",
        };
      },
      async commitResponse() {
        return { actionId: "mock-action", replayed: false };
      },
    },
    upstream: async () => {
      upstreamCalls += 1;
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(providerChatBody(JSON.stringify({
          state_patch: "this-is-not-a-patch",
          action: { type: "must-never-be-emitted" },
        }))),
      };
    },
  });

  const response = await gateway.handle(request("/v1/chat/completions", {
    model: "fake-model",
    session_id: "invalid-output-session",
    messages: [{ role: "user", content: "hello" }],
  }));

  assert.equal(upstreamCalls, 1);
  assert.equal(response.status, 502);
  const output = await response.json();
  assert.equal(output.error.code, "invalid_structured_output");
  assert.equal(output.action, undefined);
});

test("buffers provider SSE until a valid structured envelope is available", async () => {
  const text = JSON.stringify({
    state_patch: { set: { count: 2 } },
    action: null,
  });
  const midpoint = Math.floor(text.length / 2);
  const sse = [
    `data: ${JSON.stringify({ id: "stream-fake", model: "fake-model", choices: [{ delta: { content: text.slice(0, midpoint) } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(midpoint) } }] })}`,
    "data: [DONE]",
  ].join("\n\n") + "\n\n";
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: {
      async prepareCall(input) {
        return {
          projection: { procedure: TEST_PROCEDURE },
          sigma: {},
          latestObservation: input.latestObservation,
          prompt: "canonical",
        };
      },
      async commitResponse() {
        return { actionId: "mock-action", replayed: false };
      },
    },
    upstream: async () => ({ status: 200, contentType: "text/event-stream", body: sse }),
  });

  const response = await gateway.handle(request("/v1/chat/completions", {
    model: "fake-model",
    session_id: "stream-session",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-gateway-stream-buffered"), "true");
  const streamText = await response.text();
  assert.match(streamText, /chat\.completion\.chunk/);
  assert.match(streamText, /state_patch/);
  assert.match(streamText, /data: \[DONE\]/);
});

test("emits Responses SSE event names after validation", async () => {
  const text = JSON.stringify({ state_patch: {}, action: null });
  const sse = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: {
      async prepareCall(input) {
        return {
          projection: { procedure: TEST_PROCEDURE },
          sigma: {},
          latestObservation: input.latestObservation,
          prompt: "canonical",
        };
      },
      async commitResponse() {},
    },
    upstream: async () => ({ status: 200, contentType: "text/event-stream", body: sse }),
  });
  const response = await gateway.handle(request("/v1/responses", {
    model: "fake-model",
    session_id: "responses-session",
    stream: true,
    input: "hello",
  }));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /event: response\.output_text\.delta/);
  assert.match(body, /event: response\.completed/);
});

test("real core bridge strips transcript input and atomically commits a valid response", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-state-gateway-"));
  try {
    const core = createSkillStateCore({
      rootDir: root,
      procedure: TEST_PROCEDURE,
      initialState: { obsolete: "remove-me", task: { status: "waiting" } },
    });
    const upstreamCalls = [];
    const gateway = createGateway({
      core,
      upstream: async ({ body }) => {
        upstreamCalls.push(body);
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(providerChatBody(JSON.stringify({
            state_patch: {
              set: { "task.status": "done" },
              delete: ["obsolete"],
            },
            action: { type: "notify", payload: { text: "done" } },
          }))),
        };
      },
    });

    const response = await gateway.handle(request("/v1/chat/completions", {
      model: "fake-model",
      session_id: "real-session",
      state_revision: 0,
      idempotency_key: "real-turn-1",
      transcript: "must never reach provider",
      procedure: { id: "client-override", version: 99 },
      prompt: "client prompt must never win",
      messages: [{ role: "user", content: "latest observation" }],
    }));

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.equal("transcript" in upstreamCalls[0], false);
    assert.equal("messages" in upstreamCalls[0], true);
    assert.equal(upstreamCalls[0].messages[0].content.includes("must never reach provider"), false);
    assert.match(upstreamCalls[0].messages[0].content, /gateway-test-procedure/);
    assert.equal(upstreamCalls[0].messages[0].content.includes("client-override"), false);
    assert.equal(upstreamCalls[0].messages[0].content.includes("client prompt must never win"), false);

    const snapshot = await core.store.read("real-session");
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.state, { task: { status: "done" } });
    const action = await core.store.readAction("real-session", "real-turn-1");
    assert.equal(action?.status, "applied");
    assert.deepEqual(action?.patch, { task: { status: "done" }, obsolete: null });

    const changedProcedureCore = createSkillStateCore({
      rootDir: root,
      procedure: { id: "different-procedure", version: 1 },
    });
    await assert.rejects(
      changedProcedureCore.prepareCall({
        protocol: "p+sigma+latest-o/v1",
        endpoint: "/v1/chat/completions",
        model: "fake-model",
        sessionId: "real-session",
        expectedRevision: 1,
        idempotencyKey: "real-turn-2",
        latestObservation: "next",
        request: { stream: false, controls: {}, requestId: "real-turn-2" },
      }),
      (error) => error?.code === "PROCEDURE_CONFLICT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real core rejects an invalid response patch without changing Sigma", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-state-gateway-invalid-"));
  try {
    const core = createSkillStateCore({ rootDir: root, procedure: TEST_PROCEDURE, initialState: { count: 1 } });
    const gateway = createGateway({
      core,
      upstream: async () => ({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(providerChatBody(JSON.stringify({
          state_patch: { set: [] },
          action: { type: "must-not-commit" },
        }))),
      }),
    });

    const response = await gateway.handle(request("/v1/chat/completions", {
      model: "fake-model",
      session_id: "invalid-session",
      state_revision: 0,
      idempotency_key: "invalid-turn-1",
      messages: [{ role: "user", content: "latest observation" }],
    }));
    assert.equal(response.status, 422);
    const snapshot = await core.store.read("invalid-session");
    assert.equal(snapshot.revision, 0);
    assert.deepEqual(snapshot.state, { count: 1 });
    assert.equal(await core.store.readAction("invalid-session", "invalid-turn-1"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("health and capabilities expose supported routes", async () => {
  const gateway = createGateway({
    core: {},
    procedure: TEST_PROCEDURE,
    upstreamBaseUrl: "https://provider.invalid",
  });
  const health = await gateway.handle(new Request("http://gateway.test/healthz"));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");

  const capabilities = await gateway.handle(new Request("http://gateway.test/capabilities"));
  const body = await capabilities.json();
  assert.deepEqual(body.endpoints, ["/v1/chat/completions", "/v1/responses"]);
  assert.equal(body.streaming.validation, "buffered");
  assert.equal(body.session.required, true);
  assert.deepEqual(body.session.provider_headers, ["session-id", "thread-id"]);
  assert.equal(body.session.max_length, 128);
});

test("gateway fails closed when production procedure configuration is missing", () => {
  assert.throws(
    () => createGateway({ core: {}, upstreamBaseUrl: "https://provider.invalid" }),
    (error) => error?.code === "procedure_required",
  );
});

const VALID_ENVELOPE = Object.freeze({
  state_patch: { set: { "task.status": "planned" } },
  action: { type: "shell", payload: { cmd: "ls" } },
});
const REASONING_WITH_BRACES = 'Thinking about it... {"o":{"kind":"observation"}} then emit {"state_patch": {} }';

function stubCore() {
  return {
    async prepareCall(input) {
      return { projection: { procedure: TEST_PROCEDURE }, sigma: {}, latestObservation: input.latestObservation, prompt: "canonical" };
    },
    async commitResponse() {
      return { actionId: "mock-action", replayed: false };
    },
  };
}

function gatewayWithProvider(providerBody, options = {}) {
  const upstreamCalls = [];
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: stubCore(),
    upstream: async ({ path, body }) => {
      upstreamCalls.push({ path, body });
      return typeof providerBody === "string"
        ? { status: 200, contentType: "text/event-stream", body: providerBody }
        : { status: 200, contentType: "application/json", body: JSON.stringify(providerBody) };
    },
    ...options,
  });
  return { gateway, upstreamCalls };
}

function sseBody(records) {
  return records.map(([event, data]) => (
    `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}`
  )).join("\n\n") + "\n\n";
}

test("Responses reasoning items with braces are ignored; only the message item is parsed", async () => {
  const { gateway } = gatewayWithProvider({
    id: "resp-lmstudio",
    object: "response",
    model: "qwen3.5",
    output: [
      { id: "rs_1", type: "reasoning", content: [{ type: "reasoning_text", text: REASONING_WITH_BRACES }] },
      { id: "rs_2", type: "reasoning", content: [{ type: "text", text: REASONING_WITH_BRACES }] },
      { id: "fc_1", type: "function_call", name: "shell", arguments: "{\"cmd\":\"ls\"}", text: "{" },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(VALID_ENVELOPE) }],
      },
    ],
  });
  const response = await gateway.handle(request(RESPONSES_PATH, {
    model: "qwen3.5",
    session_id: "responses-reasoning-session",
    input: "hello",
  }));
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.deepEqual(output.state_patch, VALID_ENVELOPE.state_patch);
  assert.deepEqual(output.action, VALID_ENVELOPE.action);
});

test("strips <think> blocks before JSON parsing and keeps fenced-block handling", () => {
  const json = JSON.stringify(VALID_ENVELOPE);
  for (const text of [
    `<think>\n${REASONING_WITH_BRACES}\n</think>\n${json}`,
    `<THINK>first {"a":1}</THINK>\n<think>\nsecond {\n</Think >\n\`\`\`json\n${json}\n\`\`\``,
    `  <think>unterminated reasoning without braces\n${json}`,
  ]) {
    assert.deepEqual(parseStructuredOutput(text), VALID_ENVELOPE);
  }
  assert.throws(
    () => parseStructuredOutput(`<think>${REASONING_WITH_BRACES}</think>`),
    (error) => error?.code === "invalid_structured_output",
  );
});

test("Chat ignores reasoning_content and uses only the first choice when n > 1", async () => {
  const second = { state_patch: { set: { other: true } }, action: null };
  const { gateway } = gatewayWithProvider({
    id: "chatcmpl-n2",
    object: "chat.completion",
    created: 1,
    model: "qwen3.5",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(VALID_ENVELOPE), reasoning_content: REASONING_WITH_BRACES },
        finish_reason: "stop",
      },
      { index: 1, message: { role: "assistant", content: JSON.stringify(second) }, finish_reason: "stop" },
    ],
  });
  const response = await gateway.handle(request(CHAT_COMPLETIONS_PATH, {
    model: "qwen3.5",
    session_id: "chat-n2-session",
    n: 2,
  }));
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.deepEqual(output.state_patch, VALID_ENVELOPE.state_patch);
  assert.deepEqual(output.action, VALID_ENVELOPE.action);
});

test("streaming ignores reasoning deltas and non-primary choices", async () => {
  const json = JSON.stringify(VALID_ENVELOPE);
  const responsesSse = sseBody([
    ["response.reasoning_text.delta", { type: "response.reasoning_text.delta", delta: REASONING_WITH_BRACES }],
    ["response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "{summary" }],
    ["response.output_text.delta", { type: "response.output_text.delta", delta: json.slice(0, 10) }],
    ["response.output_text.delta", { type: "response.output_text.delta", delta: json.slice(10) }],
    [null, "[DONE]"],
  ]);
  const responses = gatewayWithProvider(responsesSse).gateway;
  const responsesResult = await responses.handle(request(RESPONSES_PATH, {
    model: "qwen3.5",
    session_id: "responses-stream-reasoning",
    stream: true,
    input: "hello",
  }));
  assert.equal(responsesResult.status, 200);
  assert.match(await responsesResult.text(), /"type":"shell"/);

  const completedOnlySse = sseBody([
    ["response.reasoning_text.delta", { type: "response.reasoning_text.delta", delta: REASONING_WITH_BRACES }],
    ["response.completed", {
      type: "response.completed",
      response: {
        id: "resp-done",
        output: [
          { type: "reasoning", content: [{ type: "reasoning_text", text: REASONING_WITH_BRACES }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: json }] },
        ],
      },
    }],
  ]);
  const completedOnly = gatewayWithProvider(completedOnlySse).gateway;
  const completedResult = await completedOnly.handle(request(RESPONSES_PATH, {
    model: "qwen3.5",
    session_id: "responses-stream-completed",
    stream: true,
    input: "hello",
  }));
  assert.equal(completedResult.status, 200);

  const chatSse = sseBody([
    [null, { id: "chat-stream", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: REASONING_WITH_BRACES } }] }],
    [null, { choices: [{ index: 0, delta: { content: json.slice(0, 7) } }] }],
    [null, { choices: [{ index: 1, delta: { content: '{"state_patch":{},"action":null}' } }] }],
    [null, { choices: [{ index: 0, delta: { content: json.slice(7) } }] }],
    [null, "[DONE]"],
  ]);
  const chat = gatewayWithProvider(chatSse).gateway;
  const chatResult = await chat.handle(request(CHAT_COMPLETIONS_PATH, {
    model: "qwen3.5",
    session_id: "chat-stream-reasoning",
    stream: true,
    n: 2,
  }));
  assert.equal(chatResult.status, 200);
  assert.match(await chatResult.text(), /\\"type\\":\\"shell\\"/);
});

test("ENVELOPE_SCHEMA mirrors the envelope validator", () => {
  assert.deepEqual(ENVELOPE_SCHEMA.required, ["state_patch", "action"]);
  assert.deepEqual(ENVELOPE_SCHEMA.properties.state_patch, { type: "object" });
  const [nullBranch, objectBranch] = ENVELOPE_SCHEMA.properties.action.anyOf;
  assert.deepEqual(nullBranch, { type: "null" });
  assert.deepEqual(objectBranch.required, ["type"]);
  assert.equal(Object.prototype.hasOwnProperty.call(objectBranch.properties, "payload"), true);
  const typeSchema = objectBranch.properties.type;
  assert.equal(typeSchema.type, "string");
  assert.equal(typeSchema.minLength, 1);
  assert.equal(new RegExp(typeSchema.pattern).test("   "), false);

  const maxType = "a".repeat(typeSchema.maxLength);
  assert.deepEqual(validateStructuredEnvelope({ state_patch: {}, action: { type: maxType } }).action, { type: maxType });
  for (const invalid of [
    { state_patch: {}, action: { type: `${maxType}a` } },
    { state_patch: {}, action: { type: "   " } },
    { state_patch: {}, action: {} },
    { state_patch: [], action: null },
    { action: null },
    { state_patch: {} },
  ]) {
    assert.throws(() => validateStructuredEnvelope(invalid), (error) => error?.code === "invalid_structured_output");
  }
  assert.equal(Object.isFrozen(ENVELOPE_SCHEMA.properties.action.anyOf[1].properties.type), true);
});

const CLIENT_CONTROLS = Object.freeze({
  reasoning: { effort: "high", summary: "auto" },
  reasoning_effort: "high",
  tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
  tool_choice: "auto",
  parallel_tool_calls: true,
  response_format: { type: "json_object" },
  text: { verbosity: "low", format: { type: "text" } },
});

async function upstreamBodyFor(path, options, controls = CLIENT_CONTROLS) {
  const { gateway, upstreamCalls } = gatewayWithProvider(
    path === RESPONSES_PATH
      ? { id: "resp", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(VALID_ENVELOPE) }] }] }
      : providerChatBody(JSON.stringify(VALID_ENVELOPE)),
    options,
  );
  const response = await gateway.handle(request(path, {
    model: "qwen3.5",
    session_id: `overrides-${path.replaceAll("/", "-")}`,
    ...structuredClone(controls),
  }));
  assert.equal(response.status, 200);
  assert.equal(upstreamCalls.length, 1);
  return upstreamCalls[0].body;
}

test("upstream overrides force reasoning effort, envelope schema, and drop tools", async () => {
  const options = { upstreamReasoningEffort: "none", structuredOutput: "json_schema" };

  const chat = await upstreamBodyFor(CHAT_COMPLETIONS_PATH, options);
  assert.equal(chat.reasoning_effort, "none");
  assert.deepEqual(chat.response_format, {
    type: "json_schema",
    json_schema: { name: "skill_state_envelope", schema: ENVELOPE_SCHEMA, strict: true },
  });
  assert.deepEqual(chat.text, { verbosity: "low" });
  for (const field of ["tools", "tool_choice", "parallel_tool_calls"]) assert.equal(field in chat, false);

  const responses = await upstreamBodyFor(RESPONSES_PATH, options);
  assert.deepEqual(responses.reasoning, { effort: "none" });
  assert.deepEqual(responses.text, {
    verbosity: "low",
    format: { type: "json_schema", name: "skill_state_envelope", schema: ENVELOPE_SCHEMA, strict: true },
  });
  assert.equal("response_format" in responses, false);
  for (const field of ["tools", "tool_choice", "parallel_tool_calls"]) assert.equal(field in responses, false);
  assert.equal(responses.input, "canonical");

  const lowEffort = await upstreamBodyFor(RESPONSES_PATH, { upstreamReasoningEffort: "low" });
  assert.deepEqual(lowEffort.reasoning, { effort: "low", summary: "auto" });
  assert.deepEqual(lowEffort.tools, CLIENT_CONTROLS.tools);
  assert.deepEqual(lowEffort.response_format, CLIENT_CONTROLS.response_format);

  const keepTools = await upstreamBodyFor(CHAT_COMPLETIONS_PATH, { structuredOutput: "json_schema", dropTools: false });
  assert.deepEqual(keepTools.tools, CLIENT_CONTROLS.tools);
  assert.equal(keepTools.response_format.type, "json_schema");
  assert.equal(keepTools.reasoning_effort, "high");

  const passthrough = await upstreamBodyFor(CHAT_COMPLETIONS_PATH, {});
  assert.deepEqual(passthrough.response_format, CLIENT_CONTROLS.response_format);
  assert.deepEqual(passthrough.reasoning, CLIENT_CONTROLS.reasoning);
  assert.equal(passthrough.reasoning_effort, "high");
  assert.equal(passthrough.tool_choice, "auto");
});

test("createGateway rejects invalid upstream override options", () => {
  for (const options of [
    { upstreamReasoningEffort: "extreme" },
    { structuredOutput: "json_object" },
    { dropTools: "yes" },
  ]) {
    assert.throws(
      () => createGateway({ procedure: TEST_PROCEDURE, core: stubCore(), upstream: async () => ({}), ...options }),
      TypeError,
    );
  }
});

function lmStudioLikeUpstream(envelope, calls) {
  // Mirrors the verified LM Studio behaviour: json_schema is honoured only for
  // non-streaming calls; streamed output may be free text.
  return async ({ path, body }) => {
    calls.push({ path, body });
    if (body.stream === true) {
      const delta = "Sure! I will run the command now.";
      return {
        status: 200,
        contentType: "text/event-stream",
        body: path === RESPONSES_PATH
          ? sseBody([["response.output_text.delta", { type: "response.output_text.delta", delta }], [null, "[DONE]"]])
          : sseBody([[null, { choices: [{ index: 0, delta: { content: delta } }] }], [null, "[DONE]"]]),
      };
    }
    const text = JSON.stringify(envelope);
    const usage = path === RESPONSES_PATH
      ? { input_tokens: 11, output_tokens: 7, total_tokens: 18 }
      : { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(path === RESPONSES_PATH
        ? {
          id: "resp-nonstream",
          object: "response",
          created_at: 5,
          model: "qwen3.5",
          output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
          usage,
        }
        : { ...providerChatBody(text), id: "chatcmpl-nonstream", usage }),
    };
  };
}

function parseSseStream(text) {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const event = block.match(/^event: (.*)$/m)?.[1];
    const data = block.match(/^data: (.*)$/m)?.[1];
    return { event, data: data === "[DONE]" ? data : JSON.parse(data) };
  });
}

test("streaming clients get synthesized SSE from a non-streaming upstream call", async () => {
  for (const options of [{ structuredOutput: "json_schema" }, { upstreamStream: "false" }]) {
    const calls = [];
    const gateway = createGateway({
      procedure: TEST_PROCEDURE,
      core: stubCore(),
      upstream: lmStudioLikeUpstream(VALID_ENVELOPE, calls),
      ...options,
    });

    const responses = await gateway.handle(request(RESPONSES_PATH, {
      model: "qwen3.5",
      session_id: "codex-stream-session",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      input: "hello",
    }));
    assert.equal(calls.at(-1).body.stream, false);
    assert.equal(responses.status, 200);
    assert.equal(responses.headers.get("x-gateway-stream-buffered"), "true");
    assert.match(responses.headers.get("content-type"), /text\/event-stream/);
    const events = parseSseStream(await responses.text());
    assert.deepEqual(events.map((item) => item.event), [
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.output_item.done",
      "response.completed",
      undefined,
    ]);
    assert.equal(events.at(-1).data, "[DONE]");
    const completed = events.find((item) => item.event === "response.completed").data.response;
    assert.equal(completed.id, "resp-nonstream");
    assert.deepEqual(completed.usage, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });
    assert.deepEqual(completed.action, VALID_ENVELOPE.action);
    assert.equal(events.find((item) => item.event === "response.output_text.done").data.text, JSON.stringify(VALID_ENVELOPE));

    const chat = await gateway.handle(request(CHAT_COMPLETIONS_PATH, {
      model: "qwen3.5",
      session_id: "chat-stream-session",
      stream: true,
    }));
    assert.equal(calls.at(-1).body.stream, false);
    assert.equal(chat.status, 200);
    assert.equal(chat.headers.get("x-gateway-stream-buffered"), "true");
    const chunks = parseSseStream(await chat.text());
    assert.equal(chunks.at(-1).data, "[DONE]");
    const payloads = chunks.slice(0, -1).map((item) => item.data);
    assert.ok(payloads.every((item) => item.object === "chat.completion.chunk" && item.id === "chatcmpl-nonstream"));
    assert.equal(payloads.map((item) => item.choices[0].delta.content ?? "").join(""), JSON.stringify(VALID_ENVELOPE));
    assert.equal(payloads.at(-1).choices[0].finish_reason, "stop");
  }
});

test("upstreamStream true and auto without json_schema keep forwarding the client stream flag", async () => {
  for (const options of [{ upstreamStream: "true", structuredOutput: "json_schema" }, {}]) {
    const calls = [];
    const gateway = createGateway({
      procedure: TEST_PROCEDURE,
      core: stubCore(),
      upstream: lmStudioLikeUpstream(VALID_ENVELOPE, calls),
      ...options,
    });
    const response = await gateway.handle(request(RESPONSES_PATH, {
      model: "qwen3.5",
      session_id: "forward-stream-session",
      stream: true,
      input: "hello",
    }));
    assert.equal(calls[0].body.stream, true);
    // The mocked streamed output is free text, as observed live.
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "invalid_structured_output");

    const nonStream = await gateway.handle(request(RESPONSES_PATH, {
      model: "qwen3.5",
      session_id: "forward-nonstream-session",
      input: "hello",
    }));
    assert.equal(calls[1].body.stream, false);
    assert.equal(nonStream.status, 200);
  }
});

test("GET /v1/models and /models pass through to the upstream models route", async () => {
  const modelList = { object: "list", data: [{ id: "qwen3.5", object: "model" }] };
  const fetchCalls = [];
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: {},
    upstreamBaseUrl: "http://127.0.0.1:1234/v1",
    upstreamApiKey: "models-test-key",
    upstreamFetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return new Response(JSON.stringify(modelList), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  for (const path of ["/v1/models?client_version=0.154.0", "/models"]) {
    const response = await gateway.handle(new Request(`http://gateway.test${path}`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), modelList);
  }
  assert.equal(fetchCalls[0].url, "http://127.0.0.1:1234/v1/models?client_version=0.154.0");
  assert.equal(fetchCalls[1].url, "http://127.0.0.1:1234/v1/models");
  assert.equal(fetchCalls[0].init.method, "GET");
  assert.equal(fetchCalls[0].init.body, undefined);
  assert.equal(fetchCalls[0].init.headers.authorization, "Bearer models-test-key");
  assert.ok(fetchCalls[0].init.signal instanceof AbortSignal);
});

test("GET /v1/models maps upstream failures to gateway errors, not 404", async () => {
  const cases = [
    [async () => new Response("nope", { status: 500 }), 502, "upstream_error"],
    [async () => { throw new Error("connection refused"); }, 502, "upstream_unavailable"],
    [async () => new Response("<html>", { status: 200 }), 502, "invalid_upstream_response"],
    [async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }), 504, "upstream_timeout"],
  ];
  for (const [upstreamFetch, status, code] of cases) {
    const gateway = createGateway({
      procedure: TEST_PROCEDURE,
      core: {},
      upstreamBaseUrl: "http://127.0.0.1:1234/v1",
      upstreamTimeoutMs: 20,
      upstreamFetch,
    });
    const response = await gateway.handle(new Request("http://gateway.test/v1/models"));
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }

  const unconfigured = createGateway({ procedure: TEST_PROCEDURE, core: {}, upstreamBaseUrl: "" });
  const response = await unconfigured.handle(new Request("http://gateway.test/models"));
  assert.equal(response.status, 503);

  const client = createUpstreamClient({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl: async () => new Response("x".repeat(8 * 1024 * 1024 + 1)) });
  await assert.rejects(
    client.request("/v1/models", undefined, { method: "GET", requestId: "big" }),
    (error) => error?.code === "upstream_response_too_large",
  );
});

test("clientText action shows respond/ask text in streamed and non-streamed responses", async () => {
  const cases = [
    [{ state_patch: { set: { n: 1 } }, action: { type: "respond", payload: { text: "Hello there" } } }, "Hello there"],
    [{ state_patch: {}, action: { type: "ask", payload: { question: "Which file?" } } }, "Which file?"],
  ];
  const other = { state_patch: {}, action: { type: "shell", payload: { cmd: "ls" } } };
  cases.push([other, JSON.stringify(other)]);
  const nullAction = { state_patch: {}, action: null };
  cases.push([nullAction, JSON.stringify(nullAction)]);
  const badPayload = { state_patch: {}, action: { type: "respond", payload: { text: 42 } } };
  cases.push([badPayload, JSON.stringify(badPayload)]);

  for (const [envelope, expected] of cases) {
    const commits = [];
    const gateway = createGateway({
      procedure: TEST_PROCEDURE,
      core: { ...stubCore(), async commitResponse(input) { commits.push(input); } },
      upstream: lmStudioLikeUpstream(envelope, []),
      upstreamStream: "false",
      clientText: "action",
    });
    const session = { model: "qwen3.5", session_id: "client-text-session" };

    const chat = await (await gateway.handle(request(CHAT_COMPLETIONS_PATH, session))).json();
    assert.equal(chat.choices[0].message.content, expected);
    assert.deepEqual(chat.action, envelope.action);

    const responses = await (await gateway.handle(request(RESPONSES_PATH, { ...session, input: "x" }))).json();
    assert.equal(responses.output_text, expected);
    assert.equal(responses.output[0].content[0].text, expected);
    assert.deepEqual(responses.action, envelope.action);

    const chatStream = parseSseStream(await (await gateway.handle(request(CHAT_COMPLETIONS_PATH, { ...session, stream: true }))).text());
    assert.equal(chatStream.slice(0, -1).map((item) => item.data.choices[0].delta.content ?? "").join(""), expected);

    const responsesStream = parseSseStream(await (await gateway.handle(request(RESPONSES_PATH, { ...session, stream: true, input: "x" }))).text());
    assert.equal(responsesStream.filter((item) => item.event === "response.output_text.delta").map((item) => item.data.delta).join(""), expected);
    const completed = responsesStream.find((item) => item.event === "response.completed").data.response;
    assert.equal(completed.output_text, expected);
    assert.deepEqual(completed.action, envelope.action);

    assert.equal(commits.length, 4);
    for (const commit of commits) {
      assert.deepEqual(commit.statePatch, envelope.state_patch);
      assert.deepEqual(commit.action, envelope.action);
    }
  }

  const envelope = cases[0][0];
  const defaultGateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: stubCore(),
    upstream: lmStudioLikeUpstream(envelope, []),
  });
  const defaultChat = await (await defaultGateway.handle(request(CHAT_COMPLETIONS_PATH, { model: "m", session_id: "s" }))).json();
  assert.equal(defaultChat.choices[0].message.content, JSON.stringify(envelope));
  assert.throws(
    () => createGateway({ procedure: TEST_PROCEDURE, core: stubCore(), upstream: async () => ({}), clientText: "plain" }),
    TypeError,
  );
  assert.throws(
    () => createGateway({ procedure: TEST_PROCEDURE, core: stubCore(), upstream: async () => ({}), upstreamStream: "sometimes" }),
    TypeError,
  );
});

test("debugDir captures invalid model output privately and is disabled by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-state-debug-"));
  const debugDir = join(root, "captures");
  const clientMarker = "client-request-content-must-not-be-captured";
  const modelText = `not json at all ${"z".repeat(10)}`;
  const upstream = async () => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(providerChatBody(modelText)),
  });
  try {
    const gateway = createGateway({ procedure: TEST_PROCEDURE, core: stubCore(), upstream, debugDir });
    assert.equal((await lstat(debugDir)).mode & 0o777, 0o700);
    const response = await gateway.handle(request(CHAT_COMPLETIONS_PATH, {
      model: "m",
      session_id: "debug-session",
      messages: [{ role: "user", content: clientMarker }],
    }, { "x-request-id": "req-123/../../escape" }));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "invalid_structured_output");

    const files = await readdir(debugDir);
    assert.deepEqual(files, ["invalid-req-123_______escape.txt"]);
    const capturePath = join(debugDir, files[0]);
    assert.equal((await lstat(capturePath)).mode & 0o777, 0o600);
    const capture = await readFile(capturePath, "utf8");
    assert.match(capture, /request_id: req-123\/\.\.\/\.\.\/escape/);
    assert.equal(capture.includes(modelText), true);
    assert.equal(capture.includes(clientMarker), false);

    const huge = createGateway({
      procedure: TEST_PROCEDURE,
      core: stubCore(),
      upstream: async () => ({ status: 200, contentType: "application/json", body: JSON.stringify(providerChatBody("x".repeat(400 * 1024))) }),
      debugDir,
    });
    await huge.handle(request(CHAT_COMPLETIONS_PATH, { model: "m", session_id: "s" }, { "x-request-id": "huge" }));
    const hugeCapture = await readFile(join(debugDir, "invalid-huge.txt"));
    assert.equal(hugeCapture.length <= MAX_DEBUG_CAPTURE_BYTES, true);
    assert.match(hugeCapture.toString("utf8"), /\[truncated\]\n$/);

    const linked = join(root, "linked");
    await symlink(debugDir, linked);
    assert.throws(() => createGateway({ procedure: TEST_PROCEDURE, core: stubCore(), upstream, debugDir: linked }), TypeError);

    const before = (await readdir(debugDir)).length;
    const disabled = createGateway({ procedure: TEST_PROCEDURE, core: stubCore(), upstream });
    const disabledResponse = await disabled.handle(request(CHAT_COMPLETIONS_PATH, { model: "m", session_id: "s" }, { "x-request-id": "disabled" }));
    assert.equal(disabledResponse.status, 502);
    assert.equal((await readdir(debugDir)).length, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const CHAT_UPSTREAM_USAGE = Object.freeze({
  prompt_tokens: 11,
  completion_tokens: 7,
  total_tokens: 18,
  prompt_tokens_details: { cached_tokens: 2 },
  completion_tokens_details: { reasoning_tokens: 3 },
});
const MAPPED_RESPONSES_USAGE = Object.freeze({
  input_tokens: 11,
  output_tokens: 7,
  total_tokens: 18,
  input_tokens_details: { cached_tokens: 2 },
  output_tokens_details: { reasoning_tokens: 3 },
});

function chatOnlyUpstream(envelope, calls) {
  // Mirrors LM Studio chat: schema-shaped output for stream true and false.
  return async ({ path, body }) => {
    calls.push({ path, body });
    if (path !== CHAT_COMPLETIONS_PATH) {
      return { status: 200, contentType: "application/json", body: JSON.stringify({ output_text: "Привет" }) };
    }
    const text = JSON.stringify(envelope);
    if (body.stream === true) {
      return {
        status: 200,
        contentType: "text/event-stream",
        body: sseBody([
          [null, { id: "chatcmpl-up", created: 77, model: "lmstudio-model", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "{thinking" } }], usage: null }],
          [null, { id: "chatcmpl-up", choices: [{ index: 0, delta: { content: text.slice(0, 9) } }], usage: null }],
          [null, { id: "chatcmpl-up", choices: [{ index: 0, delta: { content: text.slice(9) }, finish_reason: "stop" }], usage: null }],
          [null, { id: "chatcmpl-up", choices: [], usage: CHAT_UPSTREAM_USAGE }],
          [null, "[DONE]"],
        ]),
      };
    }
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...providerChatBody(text),
        id: "chatcmpl-up",
        created: 77,
        model: "lmstudio-model",
        usage: CHAT_UPSTREAM_USAGE,
      }),
    };
  };
}

const CODEX_RESPONSES_REQUEST = Object.freeze({
  model: "qwen3.5",
  session_id: "codex-chat-upstream",
  instructions: "codex instructions must not reach upstream",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Скажи привет одним словом." }] }],
  store: false,
  include: ["reasoning.encrypted_content"],
  tools: [
    { type: "function", name: "shell", description: "run", parameters: { type: "object" }, strict: false },
    { type: "local_shell" },
  ],
  tool_choice: "auto",
  parallel_tool_calls: false,
  text: { verbosity: "low" },
  reasoning: { effort: "medium", summary: "auto" },
  max_output_tokens: 500,
  temperature: 0.3,
  top_p: 0.9,
  stop: ["END"],
  seed: 7,
  presence_penalty: 0.1,
  frequency_penalty: 0.2,
  truncation: "auto",
  background: false,
  max_tool_calls: 3,
  previous_response_id: "resp-old",
});

test("upstreamApi chat serves /v1/responses clients from the chat upstream (non-stream and SSE)", async () => {
  const calls = [];
  const commits = [];
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: { ...stubCore(), async commitResponse(input) { commits.push(input); } },
    upstream: chatOnlyUpstream(VALID_ENVELOPE, calls),
    upstreamApi: "chat",
    structuredOutput: "json_schema",
    upstreamReasoningEffort: "none",
  });

  const response = await gateway.handle(request(RESPONSES_PATH, CODEX_RESPONSES_REQUEST));
  assert.equal(response.status, 200);
  const upstream = calls[0];
  assert.equal(upstream.path, CHAT_COMPLETIONS_PATH);
  assert.deepEqual(upstream.body.messages, [{ role: "user", content: "canonical" }]);
  assert.equal(upstream.body.model, "qwen3.5");
  assert.equal(upstream.body.stream, false);
  assert.equal(upstream.body.max_tokens, 500);
  assert.equal(upstream.body.reasoning_effort, "none");
  assert.deepEqual(upstream.body.response_format, {
    type: "json_schema",
    json_schema: { name: "skill_state_envelope", schema: ENVELOPE_SCHEMA, strict: true },
  });
  for (const [field, value] of Object.entries({ temperature: 0.3, top_p: 0.9, stop: ["END"], seed: 7, presence_penalty: 0.1, frequency_penalty: 0.2 })) {
    assert.deepEqual(upstream.body[field], value);
  }
  for (const field of [
    "input", "instructions", "store", "include", "text", "truncation", "background", "previous_response_id",
    "reasoning", "max_tool_calls", "max_output_tokens", "tools", "tool_choice", "parallel_tool_calls", "stream_options",
  ]) {
    assert.equal(field in upstream.body, false, field);
  }

  const output = await response.json();
  assert.equal(output.object, "response");
  assert.equal(output.model, "qwen3.5");
  assert.match(output.id, /^resp-/);
  assert.equal(output.created_at, 77);
  assert.equal(output.output_text, JSON.stringify(VALID_ENVELOPE));
  assert.deepEqual(output.action, VALID_ENVELOPE.action);
  assert.deepEqual(output.usage, MAPPED_RESPONSES_USAGE);
  assert.equal(commits[0].endpoint, RESPONSES_PATH);

  // Client stream with the default auto upstream stream: non-streaming chat call, Responses SSE out.
  const autoStream = await gateway.handle(request(RESPONSES_PATH, { ...CODEX_RESPONSES_REQUEST, stream: true }));
  assert.equal(calls[1].path, CHAT_COMPLETIONS_PATH);
  assert.equal(calls[1].body.stream, false);
  assert.equal(autoStream.headers.get("x-gateway-stream-buffered"), "true");
  const autoEvents = parseSseStream(await autoStream.text());
  assert.deepEqual(autoEvents.map((item) => item.event), [
    "response.created",
    "response.output_item.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.output_item.done",
    "response.completed",
    undefined,
  ]);
  const autoCompleted = autoEvents.find((item) => item.event === "response.completed").data.response;
  assert.equal(autoCompleted.model, "qwen3.5");
  assert.deepEqual(autoCompleted.usage, MAPPED_RESPONSES_USAGE);

  // Chat SSE upstream (upstreamStream true): chat stream extraction, reasoning_content ignored.
  const streamCalls = [];
  const streaming = createGateway({
    procedure: TEST_PROCEDURE,
    core: stubCore(),
    upstream: chatOnlyUpstream(VALID_ENVELOPE, streamCalls),
    upstreamApi: "chat",
    structuredOutput: "json_schema",
    upstreamStream: "true",
  });
  const sse = await streaming.handle(request(RESPONSES_PATH, { ...CODEX_RESPONSES_REQUEST, stream: true }));
  assert.equal(sse.status, 200);
  assert.equal(streamCalls[0].path, CHAT_COMPLETIONS_PATH);
  assert.equal(streamCalls[0].body.stream, true);
  assert.deepEqual(streamCalls[0].body.stream_options, { include_usage: true });
  assert.equal(streamCalls[0].body.reasoning_effort, "medium");
  const events = parseSseStream(await sse.text());
  assert.equal(events.filter((item) => item.event === "response.output_text.delta").map((item) => item.data.delta).join(""), JSON.stringify(VALID_ENVELOPE));
  const completed = events.find((item) => item.event === "response.completed").data.response;
  assert.equal(completed.model, "qwen3.5");
  assert.equal(completed.created_at, 77);
  assert.deepEqual(completed.usage, MAPPED_RESPONSES_USAGE);

  // A chat SSE upstream on a non-streaming client still returns a Responses object.
  const nonStreamClient = await streaming.handle(request(RESPONSES_PATH, CODEX_RESPONSES_REQUEST));
  assert.equal(streamCalls[1].body.stream, false);
  assert.equal((await nonStreamClient.json()).object, "response");
});

test("upstreamApi chat converts function tools when tools are kept and leaves chat clients unchanged", async () => {
  const calls = [];
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: stubCore(),
    upstream: chatOnlyUpstream(VALID_ENVELOPE, calls),
    upstreamApi: "chat",
    structuredOutput: "json_schema",
    dropTools: false,
  });
  const response = await gateway.handle(request(RESPONSES_PATH, {
    ...CODEX_RESPONSES_REQUEST,
    tool_choice: { type: "function", name: "shell" },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].body.tools, [{
    type: "function",
    function: { name: "shell", description: "run", parameters: { type: "object" }, strict: false },
  }]);
  assert.deepEqual(calls[0].body.tool_choice, { type: "function", function: { name: "shell" } });
  assert.equal(calls[0].body.parallel_tool_calls, false);

  const chatRequest = {
    model: "qwen3.5",
    session_id: "chat-client",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 10,
    tools: [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }],
    stream: true,
  };
  const sameCalls = [];
  const same = createGateway({
    procedure: TEST_PROCEDURE,
    core: stubCore(),
    upstream: chatOnlyUpstream(VALID_ENVELOPE, sameCalls),
    structuredOutput: "json_schema",
    dropTools: false,
  });
  const chatViaChatMode = await gateway.handle(request(CHAT_COMPLETIONS_PATH, chatRequest));
  const chatViaSameMode = await same.handle(request(CHAT_COMPLETIONS_PATH, chatRequest));
  assert.equal(chatViaChatMode.status, 200);
  assert.equal(chatViaSameMode.status, 200);
  assert.equal(calls[1].path, CHAT_COMPLETIONS_PATH);
  assert.deepEqual(calls[1].body, sameCalls[0].body);
  assert.match(await chatViaChatMode.text(), /chat\.completion\.chunk/);
});

test("upstreamApi same keeps /v1/responses upstream and honours a custom envelope schema", async () => {
  const customSchema = {
    type: "object",
    properties: { state_patch: { type: "object" }, action: { type: ["object", "null"] } },
    required: ["state_patch", "action"],
    additionalProperties: false,
  };
  const calls = [];
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: stubCore(),
    upstream: async ({ path, body }) => {
      calls.push({ path, body });
      const text = JSON.stringify(VALID_ENVELOPE);
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(path === RESPONSES_PATH
          ? { id: "resp-up", model: "lmstudio-model", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1 } }
          : providerChatBody(text)),
      };
    },
    structuredOutput: "json_schema",
    envelopeSchema: customSchema,
  });
  const response = await gateway.handle(request(RESPONSES_PATH, CODEX_RESPONSES_REQUEST));
  assert.equal(response.status, 200);
  assert.equal(calls[0].path, RESPONSES_PATH);
  assert.equal(calls[0].body.input, "canonical");
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.max_output_tokens, 500);
  assert.equal("messages" in calls[0].body, false);
  assert.deepEqual(calls[0].body.text.format.schema, customSchema);
  const output = await response.json();
  assert.equal(output.id, "resp-up");
  assert.deepEqual(output.usage, { input_tokens: 1 });

  await gateway.handle(request(CHAT_COMPLETIONS_PATH, { model: "qwen3.5", session_id: "custom-schema-chat" }));
  assert.deepEqual(calls[1].body.response_format.json_schema.schema, customSchema);

  for (const envelopeSchema of [
    { type: "array", required: ["state_patch", "action"] },
    { type: "object", required: ["state_patch"] },
    { type: "object" },
    [],
  ]) {
    assert.throws(
      () => createGateway({ procedure: TEST_PROCEDURE, core: stubCore(), upstream: async () => ({}), envelopeSchema }),
      TypeError,
    );
  }
  assert.throws(
    () => createGateway({ procedure: TEST_PROCEDURE, core: stubCore(), upstream: async () => ({}), upstreamApi: "responses" }),
    TypeError,
  );
});

test("responsesUsageFromChatUsage maps chat usage fields", () => {
  assert.deepEqual(responsesUsageFromChatUsage(CHAT_UPSTREAM_USAGE), MAPPED_RESPONSES_USAGE);
  assert.deepEqual(responsesUsageFromChatUsage({ prompt_tokens: 4, completion_tokens: 5 }), {
    input_tokens: 4,
    output_tokens: 5,
    total_tokens: 9,
  });
  assert.equal(responsesUsageFromChatUsage(undefined), undefined);
  assert.equal(responsesUsageFromChatUsage({}), undefined);
});

function capturedCodexBody(overrides = {}) {
  const tools = Array.from({ length: 11 }, (_, index) => ({
    type: "function",
    name: `codex_tool_${index}`,
    description: `Tool ${index} ${"describes a very long capability. ".repeat(20)}`,
    strict: false,
    parameters: {
      type: "object",
      properties: { command: { type: "array", items: { type: "string" } }, workdir: { type: "string" } },
      required: ["command"],
    },
  }));
  return {
    model: "qwen3.5",
    instructions: "codex base instructions",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Скажи привет одним словом." }] }],
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "high", summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "cache-key-must-not-appear",
    client_metadata: { session_id: "codex-captured-session" },
    text: { verbosity: "low", format: { type: "text" } },
    temperature: 0.4,
    max_output_tokens: 256,
    ...overrides,
  };
}

async function promptControlsFor(options, body = capturedCodexBody()) {
  const coreCalls = [];
  const gateway = createGateway({
    procedure: TEST_PROCEDURE,
    core: {
      async prepareCall(input) {
        coreCalls.push(input);
        return { projection: { procedure: TEST_PROCEDURE }, sigma: {}, latestObservation: input.latestObservation, prompt: "canonical" };
      },
      async commitResponse() {},
    },
    upstream: lmStudioLikeUpstream(VALID_ENVELOPE, []),
    upstreamStream: "false",
    ...options,
  });
  const response = await gateway.handle(request(RESPONSES_PATH, body));
  assert.equal(response.status, 200);
  return coreCalls[0].request.controls;
}

test("promptControls all/generation/none project controls into the canonical prompt", async () => {
  const all = await promptControlsFor({});
  assert.equal(all.tools.length, 11);
  assert.equal(all.tool_choice, "auto");
  assert.deepEqual(all.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(all.include, ["reasoning.encrypted_content"]);
  assert.equal(all.store, false);

  const generation = await promptControlsFor({
    promptControls: "generation",
    upstreamReasoningEffort: "none",
    structuredOutput: "json_schema",
    dropTools: false,
  }, capturedCodexBody({ top_p: 0.8, stop: ["END"], seed: 3, presence_penalty: 0.1, frequency_penalty: 0.2, max_tokens: 9, max_completion_tokens: 8, response_format: { type: "json_object" }, reasoning_effort: "high" }));
  assert.deepEqual(generation, {
    temperature: 0.4,
    max_output_tokens: 256,
    top_p: 0.8,
    stop: ["END"],
    seed: 3,
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
    max_tokens: 9,
    max_completion_tokens: 8,
  });

  assert.deepEqual(await promptControlsFor({ promptControls: "none" }), {});

  assert.throws(
    () => createGateway({ procedure: TEST_PROCEDURE, core: stubCore(), upstream: async () => ({}), promptControls: "some" }),
    TypeError,
  );
});

test("tool definitions are hidden from the prompt whenever tools are dropped upstream, even in all mode", async () => {
  for (const options of [{ dropTools: true }, { structuredOutput: "json_schema" }]) {
    const controls = await promptControlsFor({ promptControls: "all", ...options });
    for (const field of ["tools", "tool_choice", "parallel_tool_calls"]) assert.equal(field in controls, false, field);
    assert.deepEqual(controls.reasoning, { effort: "high", summary: "auto" });
  }
  const kept = await promptControlsFor({ structuredOutput: "json_schema", dropTools: false });
  assert.equal(kept.tools.length, 11);
});

test("captured Codex request yields a small canonical prompt with real core and stable state semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-state-prompt-controls-"));
  try {
    const core = createSkillStateCore({ rootDir: root, procedure: TEST_PROCEDURE });
    const upstreamCalls = [];
    const makeGateway = (promptControls) => createGateway({
      core,
      procedure: TEST_PROCEDURE,
      upstream: async ({ path, body }) => {
        upstreamCalls.push({ path, body });
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(providerChatBody(JSON.stringify({ state_patch: { set: { greeted: true } }, action: null }))),
        };
      },
      upstreamApi: "chat",
      structuredOutput: "json_schema",
      upstreamReasoningEffort: "none",
      promptControls,
    });

    const compat = makeGateway("all");
    const fullBody = capturedCodexBody({ client_metadata: { session_id: "codex-all-mode" } });
    assert.equal((await compat.handle(request(RESPONSES_PATH, fullBody))).status, 200);
    const generation = makeGateway("generation");
    const body = capturedCodexBody({ idempotency_key: "turn-1", state_revision: 0 });
    assert.equal((await generation.handle(request(RESPONSES_PATH, body))).status, 200);

    const allPrompt = upstreamCalls[0].body.messages[0].content;
    const prompt = upstreamCalls[1].body.messages[0].content;
    for (const text of [allPrompt, prompt]) {
      for (const hidden of ["codex_tool_", "tool_choice", "parallel_tool_calls", "cache-key-must-not-appear", "client_metadata"]) {
        assert.equal(text.includes(hidden), false, hidden);
      }
    }
    for (const hidden of ["encrypted_content", "\"reasoning\"", "\"store\"", "\"include\"", "verbosity"]) {
      assert.equal(prompt.includes(hidden), false, hidden);
    }
    assert.equal(allPrompt.includes("encrypted_content"), true);
    assert.equal(Buffer.byteLength(prompt, "utf8") < 1024, true, `prompt is ${Buffer.byteLength(prompt, "utf8")} bytes`);
    assert.equal(JSON.stringify(fullBody.tools).length > 10_000, true);
    assert.match(prompt, /"temperature":0\.4/);
    assert.match(prompt, /Скажи привет одним словом/);
    // The upstream body is unaffected by the prompt projection.
    assert.equal(upstreamCalls[1].body.temperature, 0.4);
    assert.equal(upstreamCalls[1].body.max_tokens, 256);

    // Procedure hash and idempotency do not depend on prompt controls. A
    // gateway-level retry of a committed turn behaves identically in every
    // projection mode (the core revision check is unchanged)...
    const sameModeRetry = await generation.handle(request(RESPONSES_PATH, body));
    const otherModeRetry = await makeGateway("none").handle(request(RESPONSES_PATH, body));
    assert.equal(otherModeRetry.status, sameModeRetry.status);
    assert.equal((await otherModeRetry.json()).error?.code, (await sameModeRetry.json()).error?.code);
    assert.equal((await core.store.read("codex-captured-session")).revision, 1);

    // ...contexts built with different controls share the procedure hash and
    // idempotency key, and a commit replay under that key is a replay.
    const contextFor = (controls) => core.prepareCall({
      protocol: "p+sigma+latest-o/v1",
      endpoint: RESPONSES_PATH,
      model: "qwen3.5",
      sessionId: "codex-captured-session",
      idempotencyKey: "turn-1",
      latestObservation: "x",
      request: { stream: false, controls, requestId: "hash-check" },
    });
    const noneContext = await contextFor({});
    const allContext = await contextFor({ tools: fullBody.tools, reasoning: fullBody.reasoning });
    assert.equal(noneContext.procedureHash, allContext.procedureHash);
    assert.equal(noneContext.idempotencyKey, allContext.idempotencyKey);
    assert.notEqual(noneContext.prompt, allContext.prompt);
    const replayed = await core.commitResponse({
      protocol: "p+sigma+latest-o/v1",
      endpoint: RESPONSES_PATH,
      model: "qwen3.5",
      sessionId: "codex-captured-session",
      expectedRevision: 0,
      idempotencyKey: "turn-1",
      procedureHash: allContext.procedureHash,
      statePatch: { set: { greeted: true } },
      action: null,
    });
    assert.equal(replayed.replayed, true);
    const snapshot = await core.store.read("codex-captured-session");
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.state, { greeted: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
