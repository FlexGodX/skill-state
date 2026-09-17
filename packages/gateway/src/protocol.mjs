const MAX_STRUCTURED_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_STRUCTURED_DEPTH = 40;
const MAX_ACTION_TYPE_LENGTH = 128;
const ENVELOPE_FIELDS = Object.freeze(["state_patch", "action"]);

export const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
export const RESPONSES_PATH = "/v1/responses";
export const SUPPORTED_PATHS = Object.freeze([
  CHAT_COMPLETIONS_PATH,
  RESPONSES_PATH,
]);

export class GatewayError extends Error {
  constructor(status, code, message, details = undefined, options = {}) {
    super(message, options);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.exposeDetails = options.exposeDetails === true;
  }
}

export function isPlainRecord(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasForbiddenKey(key) {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function validateJsonValue(value, depth = 0, seen = new Set()) {
  if (depth > MAX_STRUCTURED_DEPTH) {
    throw new GatewayError(
      502,
      "invalid_structured_output",
      "Structured output exceeds the maximum nesting depth.",
    );
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GatewayError(
        502,
        "invalid_structured_output",
        "Structured output contains a non-finite number.",
      );
    }
    return;
  }
  if (typeof value !== "object") {
    throw new GatewayError(
      502,
      "invalid_structured_output",
      "Structured output contains a non-JSON value.",
    );
  }
  if (seen.has(value)) {
    throw new GatewayError(
      502,
      "invalid_structured_output",
      "Structured output contains a circular value.",
    );
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) validateJsonValue(item, depth + 1, seen);
  } else {
    if (!isPlainRecord(value)) {
      throw new GatewayError(
        502,
        "invalid_structured_output",
        "Structured output contains a non-plain object.",
      );
    }
    for (const [key, item] of Object.entries(value)) {
      if (hasForbiddenKey(key)) {
        throw new GatewayError(
          502,
          "invalid_structured_output",
          "Structured output contains a forbidden object key.",
        );
      }
      validateJsonValue(item, depth + 1, seen);
    }
  }

  seen.delete(value);
}

function checkStructuredOutputSize(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new GatewayError(
      502,
      "invalid_structured_output",
      "Structured output is not serializable JSON.",
    );
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_STRUCTURED_OUTPUT_BYTES) {
    throw new GatewayError(
      502,
      "invalid_structured_output",
      "Structured output is too large.",
    );
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * JSON Schema for the envelope accepted by validateStructuredEnvelope. Both
 * derive their required fields and action.type bounds from the constants
 * above, so the upstream structured-output contract cannot drift from the
 * validator. Extra keys are tolerated by the validator (and dropped), so the
 * schema does not forbid them either; depth/size/prototype-key limits remain
 * validator-only because JSON Schema cannot express them.
 */
export const ENVELOPE_SCHEMA = deepFreeze({
  type: "object",
  properties: {
    state_patch: { type: "object" },
    action: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              minLength: 1,
              maxLength: MAX_ACTION_TYPE_LENGTH,
              pattern: "\\S",
            },
            payload: {},
          },
          required: ["type"],
        },
      ],
    },
  },
  required: [...ENVELOPE_FIELDS],
});

/**
 * Validate the provider's state/action protocol before exposing either part
 * to callers. The state patch is deliberately a JSON merge patch object; a
 * core implementation can apply stricter domain validation after receipt.
 */
export function validateStructuredEnvelope(value) {
  if (!isPlainRecord(value)) {
    throw new GatewayError(
      502,
      "invalid_structured_output",
      "Model output must be a JSON object.",
    );
  }
  for (const field of ENVELOPE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new GatewayError(
        502,
        "invalid_structured_output",
        `Model output is missing ${field}.`,
      );
    }
  }

  const statePatch = value.state_patch;
  if (!isPlainRecord(statePatch)) {
    throw new GatewayError(
      502,
      "invalid_structured_output",
      "state_patch must be a JSON object.",
    );
  }
  const action = value.action;
  if (action !== null) {
    if (!isPlainRecord(action) || typeof action.type !== "string" || action.type.trim() === "") {
      throw new GatewayError(
        502,
        "invalid_structured_output",
        "action must be null or an object with a non-empty type.",
      );
    }
    if (action.type.length > MAX_ACTION_TYPE_LENGTH) {
      throw new GatewayError(
        502,
        "invalid_structured_output",
        "action.type is too long.",
      );
    }
    if (Object.prototype.hasOwnProperty.call(action, "payload")) {
      validateJsonValue(action.payload);
    }
  }

  validateJsonValue(statePatch);
  validateJsonValue(action);
  checkStructuredOutputSize(value);

  return {
    state_patch: statePatch,
    action,
  };
}

/**
 * Reasoning models may inline their chain of thought as <think>...</think>.
 * Complete blocks are removed wherever they occur. A leading block that was
 * never closed is removed up to the first "{" only when no closing tag exists.
 */
function stripThinkBlocks(text) {
  const withoutBlocks = text.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "");
  const leading = withoutBlocks.trimStart();
  if (/^<think\b[^>]*>/i.test(leading) && !/<\/think\s*>/i.test(withoutBlocks)) {
    const firstBrace = leading.indexOf("{");
    return firstBrace < 0 ? "" : leading.slice(firstBrace);
  }
  return withoutBlocks;
}

function removeCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json|application\/json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function findJsonObject(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  return text.slice(first, last + 1);
}

export function parseStructuredOutput(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new GatewayError(
      502,
      "invalid_structured_output",
      "Model output did not contain structured JSON.",
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_STRUCTURED_OUTPUT_BYTES) {
    throw new GatewayError(
      502,
      "invalid_structured_output",
      "Model output is too large.",
    );
  }

  const candidates = [];
  const cleaned = removeCodeFence(stripThinkBlocks(text));
  candidates.push(cleaned);
  const extracted = findJsonObject(cleaned);
  if (extracted && extracted !== cleaned) candidates.push(extracted);

  let parsed;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // Try the next bounded candidate. No provider text is logged.
    }
  }
  if (parsed === undefined) {
    throw new GatewayError(
      502,
      "invalid_structured_output",
      "Model output was not valid JSON.",
    );
  }
  return validateStructuredEnvelope(parsed);
}

function isReasoningType(type) {
  return typeof type === "string" && type.toLowerCase().includes("reasoning");
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (isReasoningType(part.type)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.output_text === "string") return part.output_text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .join("");
}

function isPrimaryChoice(choice) {
  return choice?.index === undefined || choice?.index === 0;
}

/**
 * Only the first choice is the model answer; additional choices (n > 1) must
 * never be concatenated into it. `reasoning_content` is deliberately ignored.
 */
function textFromChatPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) return "";
  const choice = payload.choices.find(isPrimaryChoice) ?? payload.choices[0];
  return textFromContent(choice?.message?.content ?? choice?.delta?.content ?? choice?.text);
}

/**
 * Responses `output` interleaves reasoning, tool-call, and message items. Only
 * assistant message items carry the answer; reasoning text may contain braces
 * that would otherwise corrupt the JSON search.
 */
function textFromResponsesPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string") return payload.output_text;
  if (Array.isArray(payload.output)) {
    return payload.output
      .filter((item) => item?.type === "message" && (item.role === undefined || item.role === "assistant"))
      .map((item) => textFromContent(item.content))
      .join("");
  }
  return "";
}

export function extractTextFromPayload(endpoint, payload) {
  if (payload && typeof payload === "object" &&
      Object.prototype.hasOwnProperty.call(payload, "state_patch") &&
      Object.prototype.hasOwnProperty.call(payload, "action")) {
    return JSON.stringify(validateStructuredEnvelope(payload));
  }
  return endpoint === RESPONSES_PATH
    ? textFromResponsesPayload(payload)
    : textFromChatPayload(payload);
}

function parseSseRecords(body) {
  const records = [];
  let event = "message";
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) {
      event = "message";
      return;
    }
    records.push({ event, data: dataLines.join("\n") });
    event = "message";
    dataLines = [];
  };

  for (const line of body.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") dataLines.push(value);
  }
  flush();
  return records;
}

function looksLikeSse(body, contentType = "") {
  return contentType.toLowerCase().includes("text/event-stream") ||
    /^\s*(?:event:|data:)/m.test(body);
}

function usageFromPayload(value) {
  if (!value || typeof value !== "object") return undefined;
  const usage = {};
  for (const field of [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "input_tokens",
    "output_tokens",
  ]) {
    if (Number.isFinite(value[field])) usage[field] = value[field];
  }
  const cached = value.prompt_tokens_details?.cached_tokens ?? value.input_tokens_details?.cached_tokens;
  const reasoning = value.completion_tokens_details?.reasoning_tokens ?? value.output_tokens_details?.reasoning_tokens;
  if (Number.isFinite(cached)) usage.prompt_tokens_details = { cached_tokens: cached };
  if (Number.isFinite(reasoning)) usage.completion_tokens_details = { reasoning_tokens: reasoning };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Map Chat Completions usage (raw or as normalized by usageFromPayload) to the
 * Responses usage shape for a /v1/responses client served by a chat upstream.
 */
export function responsesUsageFromChatUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const mapped = {};
  if (Number.isFinite(usage.prompt_tokens)) mapped.input_tokens = usage.prompt_tokens;
  if (Number.isFinite(usage.completion_tokens)) mapped.output_tokens = usage.completion_tokens;
  if (Number.isFinite(usage.total_tokens)) {
    mapped.total_tokens = usage.total_tokens;
  } else if (mapped.input_tokens !== undefined && mapped.output_tokens !== undefined) {
    mapped.total_tokens = mapped.input_tokens + mapped.output_tokens;
  }
  const cached = usage.prompt_tokens_details?.cached_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (Number.isFinite(cached)) mapped.input_tokens_details = { cached_tokens: cached };
  if (Number.isFinite(reasoning)) mapped.output_tokens_details = { reasoning_tokens: reasoning };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export function extractTextFromStream(endpoint, body, contentType = "") {
  if (!looksLikeSse(body, contentType)) {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new GatewayError(
        502,
        "invalid_upstream_response",
        "Upstream returned neither JSON nor SSE.",
      );
    }
    return {
      text: extractTextFromPayload(endpoint, payload),
      upstreamPayload: payload,
      records: [],
      metadata: { id: payload?.id, model: payload?.model, created: payload?.created },
    };
  }

  const records = parseSseRecords(body);
  const chunks = [];
  let completedText = "";
  let metadata = {};
  for (const record of records) {
    if (record.data === "[DONE]") continue;
    let data;
    try {
      data = JSON.parse(record.data);
    } catch {
      continue;
    }
    metadata = {
      id: metadata.id ?? data?.id ?? data?.response?.id,
      model: metadata.model ?? data?.model ?? data?.response?.model,
      created: metadata.created ?? data?.created ?? data?.response?.created_at,
      usage: metadata.usage ?? usageFromPayload(data?.usage ?? data?.response?.usage),
    };
    if (endpoint === CHAT_COMPLETIONS_PATH) {
      // Chunks for other choices (n > 1) carry their own index; only index 0
      // is the answer. delta.reasoning_content is never read.
      const choice = Array.isArray(data?.choices) ? data.choices.find(isPrimaryChoice) : undefined;
      const chunk = choice?.delta?.content ?? choice?.text;
      if (typeof chunk === "string") chunks.push(chunk);
      const messageText = choice?.message?.content;
      if (typeof messageText === "string" && chunks.length === 0) chunks.push(messageText);
    } else {
      const eventType = typeof data?.type === "string" ? data.type : record.event;
      if (isReasoningType(eventType) || isReasoningType(record.event)) continue;
      if (typeof data?.delta === "string" &&
          (record.event.includes("output_text") || eventType.includes("output_text"))) {
        chunks.push(data.delta);
      }
      if (typeof data?.output_text === "string") completedText = data.output_text;
      if (typeof data?.response?.output_text === "string") completedText = data.response.output_text;
      const outputText = textFromResponsesPayload(data) || textFromResponsesPayload(data?.response);
      if (outputText && chunks.length === 0) completedText = outputText;
    }
  }

  return {
    text: chunks.length > 0 ? chunks.join("") : completedText,
    upstreamPayload: null,
    records,
    metadata,
  };
}

export const CLIENT_TEXT_MODES = Object.freeze(["envelope", "action"]);

const CLIENT_TEXT_PAYLOAD_FIELDS = Object.freeze({ respond: "text", ask: "question" });

/**
 * Assistant text shown to the client. "envelope" (default) is the compact JSON
 * envelope. "action" shows `payload.text` for respond and `payload.question`
 * for ask, falling back to the envelope for other actions or non-string
 * payload fields. Top-level `state_patch`/`action` fields are unaffected.
 */
export function clientTextForEnvelope(envelope, mode = "envelope") {
  if (mode === "action" && envelope.action !== null) {
    const field = Object.prototype.hasOwnProperty.call(CLIENT_TEXT_PAYLOAD_FIELDS, envelope.action.type)
      ? CLIENT_TEXT_PAYLOAD_FIELDS[envelope.action.type]
      : undefined;
    const text = field && isPlainRecord(envelope.action.payload) ? envelope.action.payload[field] : undefined;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(envelope);
}

export function createChatResponse({ envelope, upstreamPayload, metadata = {}, model, requestId, clientText }) {
  const id = upstreamPayload?.id ?? metadata.id ?? `chatcmpl-${requestId}`;
  const created = upstreamPayload?.created ?? metadata.created ?? Math.floor(Date.now() / 1000);
  const response = {
    id,
    object: "chat.completion",
    created,
    model: upstreamPayload?.model ?? metadata.model ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: clientTextForEnvelope(envelope, clientText),
        },
        finish_reason: "stop",
      },
    ],
    state_patch: envelope.state_patch,
    action: envelope.action,
  };
  const usage = upstreamPayload?.usage ?? metadata.usage;
  if (usage) response.usage = usage;
  return response;
}

export function createResponsesResponse({ envelope, upstreamPayload, metadata = {}, model, requestId, clientText }) {
  const id = upstreamPayload?.id ?? metadata.id ?? `resp-${requestId}`;
  const createdAt = upstreamPayload?.created_at ?? metadata.created ?? Math.floor(Date.now() / 1000);
  const text = clientTextForEnvelope(envelope, clientText);
  const response = {
    id,
    object: "response",
    created_at: createdAt,
    model: upstreamPayload?.model ?? metadata.model ?? model,
    status: "completed",
    output: [
      {
        id: `${id}-message`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    output_text: text,
    state_patch: envelope.state_patch,
    action: envelope.action,
  };
  const usage = upstreamPayload?.usage ?? metadata.usage;
  if (usage) response.usage = usage;
  return response;
}

function chunkText(text, chunkSize = 256) {
  const codePoints = Array.from(text);
  const chunks = [];
  for (let index = 0; index < codePoints.length; index += chunkSize) {
    chunks.push(codePoints.slice(index, index + chunkSize).join(""));
  }
  return chunks.length > 0 ? chunks : [""];
}

function sseEvent(value, eventType = undefined) {
  return `${eventType ? `event: ${eventType}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
}

export function createChatStream(args) {
  const response = createChatResponse(args);
  const chunks = chunkText(response.choices[0].message.content);
  let output = "";
  chunks.forEach((content, index) => {
    output += sseEvent({
      id: response.id,
      object: "chat.completion.chunk",
      created: response.created,
      model: response.model,
      choices: [{
        index: 0,
        delta: index === 0 ? { role: "assistant", content } : { content },
        finish_reason: null,
      }],
    });
  });
  output += sseEvent({
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  output += "data: [DONE]\n\n";
  return output;
}

export function createResponsesStream(args) {
  const response = createResponsesResponse(args);
  const message = response.output[0];
  const text = response.output_text;
  let output = "";
  output += sseEvent({
    type: "response.created",
    response: { ...response, status: "in_progress", output: [] },
  }, "response.created");
  output += sseEvent({
    type: "response.output_item.added",
    response_id: response.id,
    output_index: 0,
    item: { id: message.id, type: "message", role: "assistant", content: [] },
  }, "response.output_item.added");
  for (const delta of chunkText(text)) {
    output += sseEvent({
      type: "response.output_text.delta",
      response_id: response.id,
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta,
    }, "response.output_text.delta");
  }
  output += sseEvent({
    type: "response.output_text.done",
    response_id: response.id,
    item_id: message.id,
    output_index: 0,
    content_index: 0,
    text,
  }, "response.output_text.done");
  output += sseEvent({
    type: "response.output_item.done",
    response_id: response.id,
    output_index: 0,
    item: message,
  }, "response.output_item.done");
  output += sseEvent({ type: "response.completed", response }, "response.completed");
  output += "data: [DONE]\n\n";
  return output;
}

export function errorResponseBody(error, requestId) {
  const isGatewayError = error instanceof GatewayError;
  const status = isGatewayError ? error.status : 500;
  const code = isGatewayError ? error.code : "gateway_internal_error";
  const message = isGatewayError ? error.message : "Gateway failed to process the request.";
  const body = {
    error: {
      message,
      type: "gateway_error",
      code,
      request_id: requestId,
    },
  };
  if (isGatewayError && error.exposeDetails && error.details !== undefined) {
    body.error.details = error.details;
  }
  return { status, body };
}
