import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSkillStateCore } from "@skill-state/core";
import {
  CHAT_COMPLETIONS_PATH,
  createGateway,
  extractLatestObservation,
  extractSessionId,
  RESPONSES_PATH,
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
        return { projection: {}, sigma: {}, latestObservation: input.latestObservation, prompt: "canonical" };
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
