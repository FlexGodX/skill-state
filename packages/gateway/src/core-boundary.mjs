import { hashProcedure } from "@skill-state/core";
import {
  CHAT_COMPLETIONS_PATH,
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
} = {}) {
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
          controls: pickRequestControls(body),
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

export function buildUpstreamBody(endpoint, body, prepared) {
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
  upstream.stream = body.stream === true;
  if (endpoint === CHAT_COMPLETIONS_PATH) {
    // Exactly one canonical prompt is sent. This makes it impossible for old
    // client messages to be silently replayed by an OpenAI-compatible server.
    upstream.messages = [{ role: "user", content: prepared.prompt }];
  } else {
    upstream.input = prepared.prompt;
    delete upstream.previous_response_id;
  }
  return upstream;
}
