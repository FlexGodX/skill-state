import { hashProcedure } from "@skill-state/core";
import {
  CHAT_COMPLETIONS_PATH,
  ENVELOPE_SCHEMA,
  GatewayError,
  RESPONSES_PATH,
  isPlainRecord,
} from "./protocol.mjs";

export const SESSION_HEADER = "x-skill-state-session";
export const MAX_SESSION_ID_LENGTH = 128;
const APPROVED_METADATA_SESSION_KEY = "skill_state_session_id";
const PROVIDER_SESSION_HEADERS = Object.freeze(["session-id", "thread-id"]);
const PROVIDER_METADATA_SESSION_KEYS = Object.freeze(["session_id", "thread_id"]);

const CONTROL_FIELDS = Object.freeze([
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "n",
  "seed",
  "response_format",
  "tools",
  "tool_choice",
  "user",
  "metadata",
  "reasoning",
  "modalities",
  "audio",
  "parallel_tool_calls",
  "service_tier",
  "store",
  "reasoning_effort",
  "purpose",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "presence_penalty",
  "frequency_penalty",
  "best_of",
  "min_p",
  "top_k",
  "thinking",
  "prediction",
  "max_output_tokens",
  "include",
  "truncation",
  "text",
  "verbosity",
  "background",
  "safety_identifier",
]);

// The provider receives only model routing and documented generation controls
// plus the canonical prompt below. Arbitrary request keys are deliberately
// dropped so fields such as `system`, `instructions`, or `prompt` cannot
// compete with the P+Sigma+latest-O prompt built by core.
const UPSTREAM_FIELDS = new Set(["model", ...CONTROL_FIELDS]);

const TRANSCRIPT_KEYS = new Set([
  "messages",
  "input",
  "previous_response_id",
  "previousResponseId",
  "conversation",
  "conversation_id",
  "conversationId",
  "history",
  "chat_history",
  "transcript",
  "client_metadata",
  "latest_observation",
  "latestObservation",
  "action_result",
  "actionResult",
  "tool_result",
  "toolResult",
  "session_id",
  "state_session_id",
  "sessionId",
  "skill_state_session_id",
  "x-skill-state-session",
  "session-id",
  "thread-id",
  "thread_id",
  "turn_id",
  "turnId",
  "response_id",
  "responseId",
  "prompt_cache_key",
  "state_revision",
  "expected_revision",
  "idempotency_key",
  "state_idempotency_key",
]);

export function sanitizeBoundaryValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeBoundaryValue(item));
  if (!isPlainRecord(value)) return value;
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (TRANSCRIPT_KEYS.has(key) || key === "__proto__" || key === "prototype" || key === "constructor") continue;
    sanitized[key] = sanitizeBoundaryValue(item);
  }
  return sanitized;
}

export function pickRequestControls(body) {
  const controls = {};
  const nested = body.controls;
  if (nested !== undefined && !isPlainRecord(nested)) {
    throw new GatewayError(400, "invalid_controls", "controls must be a JSON object.");
  }
  if (nested) {
    for (const field of CONTROL_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(nested, field)) {
        controls[field] = sanitizeBoundaryValue(nested[field]);
      }
    }
  }
  for (const field of CONTROL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      controls[field] = sanitizeBoundaryValue(body[field]);
    }
  }
  return controls;
}

export const PROMPT_CONTROLS_MODES = Object.freeze(["all", "generation", "none"]);
export const GENERATION_PROMPT_CONTROLS = Object.freeze([
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
]);
const PROMPT_TOOL_FIELDS = Object.freeze(["tools", "tool_choice", "parallel_tool_calls"]);

/**
 * Controls shown to the model inside the canonical prompt (P.controls). This
 * is separate from the upstream body: "generation" keeps only sampling/length
 * controls, so client values the gateway overrides upstream (reasoning,
 * response/text format) and transport fields (include, store, ...) are never
 * shown; "none" shows nothing. Tool definitions are removed in every mode when
 * tools are dropped upstream, so the model never sees tools it cannot call.
 */
export function projectPromptControls(controls, { promptControls = "all", dropTools = false } = {}) {
  if (!PROMPT_CONTROLS_MODES.includes(promptControls)) {
    throw new TypeError(`prompt controls mode must be one of: ${PROMPT_CONTROLS_MODES.join(", ")}`);
  }
  if (promptControls === "none") return {};
  const projected = {};
  for (const [key, value] of Object.entries(controls)) {
    if (promptControls === "generation" && !GENERATION_PROMPT_CONTROLS.includes(key)) continue;
    if (dropTools === true && PROMPT_TOOL_FIELDS.includes(key)) continue;
    projected[key] = value;
  }
  return projected;
}

function contentValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return part.text ?? part.content ?? part.input_text ?? part.output_text ?? "";
    }).join("");
  }
  return value;
}

function toolObservation(value) {
  return { kind: "tool_result", value: sanitizeBoundaryValue(value) };
}

function isToolMessage(message) {
  return isPlainRecord(message) && (
    message.role === "tool"
    || message.role === "function"
    || message.type === "tool_result"
    || message.type === "tool_output"
    || message.type === "function_call_output"
  );
}

function lastMessageObservation(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isToolMessage(message)) return toolObservation(message);
    if (isPlainRecord(message) && message.role === "user") {
      return contentValue(message.content);
    }
  }
  return undefined;
}

function lastInputItem(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (isToolMessage(item)) return toolObservation(item);
    if (isPlainRecord(item) && item.role === "user") return contentValue(item.content ?? item.input ?? item.text);
  }
  return undefined;
}

/**
 * Resolve the one observation allowed into a core build request. Action/tool
 * results win over client text so a tool turn is represented as the latest O.
 */
export function extractLatestObservation(body, endpoint) {
  if (Object.prototype.hasOwnProperty.call(body, "action_result")) {
    return { kind: "action_result", value: body.action_result };
  }
  if (Object.prototype.hasOwnProperty.call(body, "tool_result")) {
    return { kind: "tool_result", value: body.tool_result };
  }
  const value = endpoint === CHAT_COMPLETIONS_PATH
    ? lastMessageObservation(body.messages)
    : lastInputItem(body.input);
  if (isPlainRecord(value) && value.kind === "tool_result") return value;
  if (Object.prototype.hasOwnProperty.call(body, "latest_observation")) {
    return body.latest_observation;
  }
  return value === undefined ? null : { kind: "client_input", value };
}

function resultField(result, names, fallback) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(result, name)) return result[name];
  }
  return fallback;
}

function normalizePreparedResult(result, input, methodName, trustedProcedureHash) {
  if (!isPlainRecord(result)) {
    throw new GatewayError(503, "core_invalid_context", "Core returned an invalid context.");
  }

  const prompt = resultField(result, ["prompt", "canonicalPrompt", "canonical_prompt"], undefined);
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new GatewayError(503, "core_invalid_context", "Core context has no non-empty prompt.");
  }

  const projection = resultField(result, ["projection", "P", "p"], undefined);
  const sigma = resultField(result, ["sigma", "Sigma", "Σ", "state"], undefined);
  if (!isPlainRecord(projection) || !isPlainRecord(sigma)) {
    throw new GatewayError(
      503,
      "core_invalid_context",
      "Core context must include structured projection and sigma values.",
    );
  }

  const procedure = resultField(result, ["procedure"], projection.procedure);
  const procedureHash = resultField(result, ["procedureHash", "procedure_hash"], trustedProcedureHash);
  if (trustedProcedureHash !== undefined) {
    let matches = false;
    try {
      matches = typeof procedureHash === "string"
        && procedureHash === trustedProcedureHash
        && procedure !== undefined
        && hashProcedure(procedure) === trustedProcedureHash;
    } catch {
      matches = false;
    }
    if (!matches) {
      throw new GatewayError(
        503,
        "core_invalid_context",
        "Core context procedure does not match trusted startup configuration.",
      );
    }
  }

  const sessionId = resultField(result, ["sessionId", "session_id"], input.sessionId);
  const expectedRevision = resultField(
    result,
    ["expectedRevision", "expected_revision"],
    input.expectedRevision ?? 0,
  );
  const idempotencyKey = resultField(
    result,
    ["idempotencyKey", "idempotency_key"],
    input.idempotencyKey,
  );
  if (typeof sessionId !== "string" || sessionId.length === 0 ||
      !Number.isInteger(expectedRevision) || typeof idempotencyKey !== "string" ||
      idempotencyKey.length === 0) {
    throw new GatewayError(
      503,
      "core_invalid_context",
      "Core context is missing a valid session commit context.",
    );
  }

  return {
    projection,
    sigma,
    latestObservation: resultField(
      result,
      ["latestObservation", "latest_observation", "observation"],
      input.latestObservation,
    ),
    prompt,
    source: methodName,
    upstream: result.upstream,
    sessionId,
    expectedRevision,
    idempotencyKey,
    model: input.model,
    procedure,
    procedureHash,
  };
}

function assertEndpoint(endpoint) {
  if (endpoint !== CHAT_COMPLETIONS_PATH && endpoint !== RESPONSES_PATH) {
    throw new GatewayError(400, "unsupported_endpoint", "Core build requested for an unsupported endpoint.");
  }
}

export function createCoreBoundary(core, {
  trustedProcedureHash,
  allowTestSessionFallback = false,
  promptControls = "all",
  dropTools = false,
} = {}) {
  const promptControlOptions = Object.freeze({ promptControls, dropTools: dropTools === true });
  projectPromptControls({}, promptControlOptions);
  if (!core || typeof core !== "object") {
    return {
      ready: false,
      assertReady() {
        throw new GatewayError(503, "core_unavailable", "Core state API is not configured.");
      },
      async prepare() {
        throw new GatewayError(503, "core_unavailable", "Core state API is not configured.");
      },
      async commit() {
        throw new GatewayError(503, "core_commit_unavailable", "Core state API is not configured.");
      },
    };
  }

  const methodName = ["prepareCall", "buildContext"]
    .find((name) => typeof core[name] === "function");

  const commitMethodName = ["commitResponse", "commitState"]
    .find((name) => typeof core[name] === "function");

  if (!methodName || !commitMethodName) {
    return {
      ready: false,
      assertReady() {
        throw new GatewayError(
          503,
          !methodName ? "core_unavailable" : "core_commit_unavailable",
          !methodName
            ? "Core state API must expose prepareCall or buildContext."
            : "Core state API must expose commitResponse.",
        );
      },
      async prepare() {
        throw new GatewayError(
          503,
          "core_unavailable",
          !methodName
            ? "Core state API must expose prepareCall or buildContext."
            : "Core state API is not ready to commit responses.",
        );
      },
      async commit() {
        throw new GatewayError(
          503,
          "core_commit_unavailable",
          "Core state API must expose commitResponse.",
        );
      },
    };
  }

  return {
    ready: true,
    assertReady() {},
    async prepare({ endpoint, body, headers, requestId }) {
      assertEndpoint(endpoint);
      const input = {
        protocol: "p+sigma+latest-o/v1",
        endpoint,
        model: body.model,
        sessionId: extractSessionId({
          body,
          headers,
          endpoint,
          requestId,
          allowTestSessionFallback,
        }),
        expectedRevision: resolveExpectedRevision(body),
        idempotencyKey: resolveIdempotencyKey(body, requestId),
        latestObservation: extractLatestObservation(body, endpoint),
        request: {
          stream: body.stream === true,
          // Prompt-only projection; the upstream body is built separately and
          // the procedure hash / idempotency key never depend on controls.
          controls: projectPromptControls(pickRequestControls(body), promptControlOptions),
          requestId,
        },
      };

      let result;
      try {
        result = await core[methodName](input);
      } catch (cause) {
        if (cause instanceof GatewayError) throw cause;
        if (cause?.code === "PROCEDURE_CONFLICT") {
          throw new GatewayError(
            409,
            "procedure_conflict",
            "Session is bound to a different trusted procedure.",
          );
        }
        if (cause?.code === "REVISION_CONFLICT") {
          throw new GatewayError(
            409,
            "state_conflict",
            "State revision does not match the request.",
          );
        }
        throw new GatewayError(
          503,
          "core_unavailable",
          "Core state API failed to build the model context.",
          undefined,
          { cause },
        );
      }
      return normalizePreparedResult(result, input, methodName, trustedProcedureHash);
    },
    async commit({ endpoint, prepared, envelope }) {
      if (!commitMethodName) {
        throw new GatewayError(
          503,
          "core_commit_unavailable",
          "Core state API must expose commitResponse.",
        );
      }
      try {
        return await core[commitMethodName]({
          protocol: "p+sigma+latest-o/v1",
          endpoint,
          model: prepared.model,
          sessionId: prepared.sessionId,
          expectedRevision: prepared.expectedRevision,
          idempotencyKey: prepared.idempotencyKey,
          procedureHash: prepared.procedureHash,
          statePatch: envelope.state_patch,
          action: envelope.action,
        });
      } catch (cause) {
        if (cause instanceof GatewayError) throw cause;
        throw mapCommitError(cause);
      }
    },
  };
}

function readHeader(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(name) ?? undefined;
  if (!isPlainRecord(headers)) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined) return value;
  }
  return undefined;
}

function validateSessionId(candidate, source) {
  if (typeof candidate !== "string") {
    throw new GatewayError(400, "invalid_session_id", `${source} must be a string.`);
  }
  const sessionId = candidate.trim();
  if (
    sessionId.length === 0
    || sessionId.length > MAX_SESSION_ID_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(sessionId)
  ) {
    throw new GatewayError(
      400,
      "invalid_session_id",
      `${source} must be a bounded non-empty string (maximum ${MAX_SESSION_ID_LENGTH} characters).`,
    );
  }
  return sessionId;
}

function ownValue(record, key) {
  return isPlainRecord(record) && Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

export function extractSessionId({ body, headers, endpoint, requestId, allowTestSessionFallback = false }) {
  const headerCandidate = readHeader(headers, SESSION_HEADER);
  if (headerCandidate !== undefined) return validateSessionId(headerCandidate, SESSION_HEADER);

  for (const headerName of PROVIDER_SESSION_HEADERS) {
    const providerHeaderCandidate = readHeader(headers, headerName);
    if (providerHeaderCandidate !== undefined) return validateSessionId(providerHeaderCandidate, headerName);
  }

  for (const key of ["session_id", "sessionId", "state_session_id"]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      return validateSessionId(body[key], key);
    }
  }

  const metadataCandidate = ownValue(body.metadata, APPROVED_METADATA_SESSION_KEY);
  if (metadataCandidate !== undefined || (isPlainRecord(body.metadata)
      && Object.prototype.hasOwnProperty.call(body.metadata, APPROVED_METADATA_SESSION_KEY))) {
    return validateSessionId(metadataCandidate, `metadata.${APPROVED_METADATA_SESSION_KEY}`);
  }

  for (const key of PROVIDER_METADATA_SESSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body.client_metadata ?? {}, key)) {
      return validateSessionId(body.client_metadata[key], `client_metadata.${key}`);
    }
  }

  // OpenAI documents Responses `conversation` as the stable conversation id.
  // It is consumed as local routing metadata and is never forwarded upstream.
  if (endpoint === RESPONSES_PATH && Object.prototype.hasOwnProperty.call(body, "conversation")) {
    return validateSessionId(body.conversation, "conversation");
  }

  if (allowTestSessionFallback === true) return validateSessionId(`request-${requestId}`, "test session fallback");
  throw new GatewayError(
    400,
    "missing_session_id",
    `A stable session id is required in ${SESSION_HEADER}, session-id/thread-id, `
      + `session_id/sessionId, metadata.${APPROVED_METADATA_SESSION_KEY}, `
      + "client_metadata.session_id/thread_id, or Responses conversation.",
  );
}

function resolveExpectedRevision(body) {
  const candidate = body.state_revision ?? body.expected_revision;
  if (candidate === undefined) return undefined;
  if (!Number.isInteger(candidate) || candidate < 0) {
    throw new GatewayError(400, "invalid_state_revision", "state_revision must be a non-negative integer.");
  }
  return candidate;
}

function resolveIdempotencyKey(body, requestId) {
  const candidate = body.idempotency_key ?? body.state_idempotency_key;
  if (candidate === undefined) return requestId;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new GatewayError(400, "invalid_idempotency_key", "idempotency_key must be a non-empty string.");
  }
  return candidate;
}

function mapCommitError(cause) {
  const code = cause?.code;
  if (code === "REVISION_CONFLICT" || code === "IDEMPOTENCY_CONFLICT" || code === "ACTION_CONFLICT") {
    return new GatewayError(409, "state_conflict", "State revision or idempotency check failed.");
  }
  if (code === "INVALID_PATCH" || code === "SERIALIZED_SIZE_LIMIT") {
    return new GatewayError(422, "invalid_state_patch", "Provider state patch was rejected by core.");
  }
  if (code === "INVALID_SESSION_ID" || code === "INVALID_IDEMPOTENCY_KEY") {
    return new GatewayError(400, "invalid_state_request", "State commit request is invalid.");
  }
  return new GatewayError(503, "core_commit_unavailable", "Core state API failed to commit the response.");
}

export const UPSTREAM_REASONING_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high"]);
export const STRUCTURED_OUTPUT_MODES = Object.freeze(["off", "json_schema"]);
export const UPSTREAM_STREAM_MODES = Object.freeze(["auto", "true", "false"]);
export const UPSTREAM_API_MODES = Object.freeze(["same", "chat"]);
export const ENVELOPE_SCHEMA_NAME = "skill_state_envelope";
const TOOL_FIELDS = Object.freeze(["tools", "tool_choice", "parallel_tool_calls"]);
// Responses-only request fields that a Chat Completions upstream must not see
// when a /v1/responses client request is translated (upstreamApi "chat").
const RESPONSES_ONLY_FIELDS = Object.freeze([
  "store",
  "include",
  "text",
  "truncation",
  "background",
  "previous_response_id",
  "reasoning",
  "max_tool_calls",
  "max_output_tokens",
]);

/**
 * An operator-supplied upstream structured-output schema must still describe
 * the envelope root. It is used only upstream; validateStructuredEnvelope
 * remains the gateway's authoritative check.
 */
export function validateEnvelopeSchema(schema) {
  if (!isPlainRecord(schema)) throw new TypeError("envelope schema must be a JSON object");
  if (schema.type !== "object") throw new TypeError('envelope schema must have type "object"');
  if (!Array.isArray(schema.required) ||
      !schema.required.includes("state_patch") || !schema.required.includes("action")) {
    throw new TypeError('envelope schema required must include "state_patch" and "action"');
  }
  return schema;
}

/** The provider route a client endpoint is sent to under `upstreamApi`. */
export function upstreamEndpointFor(endpoint, overrides = undefined) {
  return overrides?.upstreamApi === "chat" ? CHAT_COMPLETIONS_PATH : endpoint;
}

/**
 * Validate operator-level upstream overrides once, at gateway construction.
 * `dropTools` defaults to true only when structured output is enforced,
 * because a tool-call response can never satisfy the envelope contract.
 * `upstreamStream` "true" forwards the client's `stream` flag; "false" always
 * calls the provider non-streaming; "auto" (default) is "false" when the
 * envelope schema is enforced, because some OpenAI-compatible providers do
 * not enforce `json_schema` on streaming calls. The gateway buffers and validates
 * either way, so a streaming client still receives SSE.
 * `upstreamApi` "chat" sends /v1/responses client requests to the provider's
 * Chat Completions route (LM Studio enforces json_schema only there).
 */
export function resolveUpstreamOverrides({
  reasoningEffort,
  structuredOutput,
  dropTools,
  upstreamStream,
  upstreamApi,
  envelopeSchema,
} = {}) {
  if (reasoningEffort !== undefined && !UPSTREAM_REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new TypeError(`upstream reasoning effort must be one of: ${UPSTREAM_REASONING_EFFORTS.join(", ")}`);
  }
  const mode = structuredOutput ?? "off";
  if (!STRUCTURED_OUTPUT_MODES.includes(mode)) {
    throw new TypeError(`structured output mode must be one of: ${STRUCTURED_OUTPUT_MODES.join(", ")}`);
  }
  if (dropTools !== undefined && typeof dropTools !== "boolean") {
    throw new TypeError("dropTools must be a boolean");
  }
  const streamMode = upstreamStream ?? "auto";
  if (!UPSTREAM_STREAM_MODES.includes(streamMode)) {
    throw new TypeError(`upstream stream mode must be one of: ${UPSTREAM_STREAM_MODES.join(", ")}`);
  }
  const apiMode = upstreamApi ?? "same";
  if (!UPSTREAM_API_MODES.includes(apiMode)) {
    throw new TypeError(`upstream API mode must be one of: ${UPSTREAM_API_MODES.join(", ")}`);
  }
  if (envelopeSchema !== undefined) validateEnvelopeSchema(envelopeSchema);
  return Object.freeze({
    reasoningEffort,
    structuredOutput: mode,
    upstreamApi: apiMode,
    envelopeSchema,
    dropTools: dropTools ?? mode === "json_schema",
    upstreamStream: streamMode,
    forwardClientStream: streamMode === "true" || (streamMode === "auto" && mode !== "json_schema"),
  });
}

function applyReasoningEffort(endpoint, upstream, effort) {
  if (endpoint === CHAT_COMPLETIONS_PATH) {
    upstream.reasoning_effort = effort;
    // A client `reasoning` object is a competing value; align its effort.
    if (isPlainRecord(upstream.reasoning)) upstream.reasoning = { ...upstream.reasoning, effort };
    return;
  }
  const reasoning = isPlainRecord(upstream.reasoning) ? { ...upstream.reasoning, effort } : { effort };
  if (effort === "none") {
    delete reasoning.summary;
    delete reasoning.generate_summary;
  }
  upstream.reasoning = reasoning;
  if (Object.prototype.hasOwnProperty.call(upstream, "reasoning_effort")) upstream.reasoning_effort = effort;
}

function applyStructuredOutput(endpoint, upstream, envelopeSchema = ENVELOPE_SCHEMA) {
  const schema = structuredClone(envelopeSchema);
  if (endpoint === CHAT_COMPLETIONS_PATH) {
    upstream.response_format = {
      type: "json_schema",
      json_schema: { name: ENVELOPE_SCHEMA_NAME, schema, strict: true },
    };
    if (isPlainRecord(upstream.text) && Object.prototype.hasOwnProperty.call(upstream.text, "format")) {
      const { format: _clientFormat, ...text } = upstream.text;
      upstream.text = text;
    }
    return;
  }
  upstream.text = {
    ...(isPlainRecord(upstream.text) ? upstream.text : {}),
    format: { type: "json_schema", name: ENVELOPE_SCHEMA_NAME, schema, strict: true },
  };
  delete upstream.response_format;
}

function chatToolFromResponsesTool(tool) {
  if (!isPlainRecord(tool) || tool.type !== "function") return undefined;
  if (isPlainRecord(tool.function)) return tool;
  if (typeof tool.name !== "string") return undefined;
  const fn = { name: tool.name };
  for (const key of ["description", "parameters", "strict"]) {
    if (Object.prototype.hasOwnProperty.call(tool, key)) fn[key] = tool[key];
  }
  return { type: "function", function: fn };
}

/**
 * Rewrite a body built from a /v1/responses request into Chat Completions
 * form. Generation controls shared by both APIs (temperature, top_p, stop,
 * seed, penalties, ...) are kept; Responses-only fields are removed.
 */
function translateResponsesBodyToChat(upstream) {
  if (upstream.max_output_tokens !== undefined && upstream.max_tokens === undefined) {
    upstream.max_tokens = upstream.max_output_tokens;
  }
  if (upstream.reasoning_effort === undefined && typeof upstream.reasoning?.effort === "string") {
    upstream.reasoning_effort = upstream.reasoning.effort;
  }
  for (const field of RESPONSES_ONLY_FIELDS) delete upstream[field];
  if (Array.isArray(upstream.tools)) {
    upstream.tools = upstream.tools.map(chatToolFromResponsesTool).filter(Boolean);
    if (upstream.tools.length === 0) {
      delete upstream.tools;
      delete upstream.tool_choice;
      delete upstream.parallel_tool_calls;
    }
  }
  if (isPlainRecord(upstream.tool_choice) && upstream.tool_choice.type === "function" &&
      typeof upstream.tool_choice.name === "string") {
    upstream.tool_choice = { type: "function", function: { name: upstream.tool_choice.name } };
  }
  if (upstream.stream === true) upstream.stream_options = { include_usage: true };
}

/**
 * `endpoint` is the client route. With `overrides.upstreamApi === "chat"` a
 * /v1/responses request is built for the Chat Completions upstream route
 * (see upstreamEndpointFor).
 */
export function buildUpstreamBody(endpoint, body, prepared, overrides = undefined) {
  const upstream = {};
  for (const [key, value] of Object.entries(body)) {
    // Only an explicit allowlist can cross the state boundary. In particular,
    // never forward alternate prompt fields or transcript/state routing data.
    if (!UPSTREAM_FIELDS.has(key)) continue;
    upstream[key] = sanitizeBoundaryValue(value);
  }
  for (const [key, value] of Object.entries(pickRequestControls(body))) {
    upstream[key] = sanitizeBoundaryValue(value);
  }
  const resolved = overrides === undefined ? undefined : resolveUpstreamOverrides(overrides);
  const target = upstreamEndpointFor(endpoint, resolved);
  upstream.stream = body.stream === true;
  if (resolved?.forwardClientStream === false) upstream.stream = false;
  if (target === CHAT_COMPLETIONS_PATH) {
    // Exactly one canonical prompt is sent. This makes it impossible for old
    // client messages to be silently replayed by an OpenAI-compatible server.
    upstream.messages = [{ role: "user", content: prepared.prompt }];
    if (endpoint === RESPONSES_PATH) translateResponsesBodyToChat(upstream);
  } else {
    upstream.input = prepared.prompt;
    delete upstream.previous_response_id;
  }

  if (resolved?.reasoningEffort !== undefined) applyReasoningEffort(target, upstream, resolved.reasoningEffort);
  if (resolved?.structuredOutput === "json_schema") {
    applyStructuredOutput(target, upstream, resolved.envelopeSchema);
  }
  if (resolved?.dropTools === true) {
    for (const field of TOOL_FIELDS) delete upstream[field];
  }
  return upstream;
}
