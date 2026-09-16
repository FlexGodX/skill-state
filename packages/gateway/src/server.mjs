import { createServer as createNodeServer } from "node:http";
import { readFileSync } from "node:fs";
import { createSkillStateCore, hashProcedure, normalizeProcedure } from "@skill-state/core";
import {
  CHAT_COMPLETIONS_PATH,
  createChatResponse,
  createChatStream,
  createResponsesResponse,
  createResponsesStream,
  errorResponseBody,
  extractTextFromPayload,
  extractTextFromStream,
  GatewayError,
  parseStructuredOutput,
  RESPONSES_PATH,
  SUPPORTED_PATHS,
} from "./protocol.mjs";
import { buildUpstreamBody, createCoreBoundary } from "./core-boundary.mjs";
import { createUpstreamClient } from "./upstream.mjs";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `gw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function responseHeaders(requestId, extra = {}) {
  return {
    "cache-control": "no-store",
    "x-request-id": requestId,
    ...extra,
  };
}

function jsonResponse(body, status, requestId, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(requestId, {
      "content-type": "application/json; charset=utf-8",
      ...extra,
    }),
  });
}

function capabilities(upstreamConfigured, coreConfigured) {
  return {
    object: "gateway.capabilities",
    healthy: true,
    core_configured: coreConfigured,
    upstream_configured: upstreamConfigured,
    endpoints: [CHAT_COMPLETIONS_PATH, RESPONSES_PATH],
    structured_protocol: {
      version: "state-patch-action/v1",
      fields: ["state_patch", "action"],
      action_result_is_latest_observation: true,
    },
    streaming: {
      supported: true,
      validation: "buffered",
      first_event_waits_for_provider_completion: true,
    },
  };
}

async function readJsonBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    throw new GatewayError(400, "invalid_request_body", "Request body could not be read.");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
    throw new GatewayError(413, "request_too_large", "Request body is too large.");
  }
  if (text.trim() === "") {
    throw new GatewayError(400, "invalid_json", "Request body must be JSON.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function assertCompletionRequest(body, defaultModel) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GatewayError(400, "invalid_request", "Request body must be a JSON object.");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new GatewayError(400, "invalid_request", "stream must be a boolean.");
  }
  const model = body.model ?? defaultModel;
  if (typeof model !== "string" || model.trim() === "") {
    throw new GatewayError(400, "missing_model", "A model is required.");
  }
  return { ...body, model };
}

async function callInjectedUpstream(upstream, path, body, options) {
  let result;
  if (typeof upstream === "function") {
    result = await upstream({ path, body, ...options });
  } else if (upstream && typeof upstream.request === "function") {
    result = await upstream.request(path, body, options);
  } else {
    throw new GatewayError(503, "upstream_unavailable", "Provider upstream is not configured.");
  }

  if (result instanceof Response) {
    return {
      status: result.status,
      body: await result.text(),
      contentType: result.headers.get("content-type") ?? "",
      headers: result.headers,
    };
  }
  if (!result || typeof result !== "object") {
    throw new GatewayError(502, "invalid_upstream_response", "Provider upstream returned an invalid response.");
  }
  let responseBody = result.body;
  if (typeof responseBody !== "string") {
    try {
      responseBody = JSON.stringify(responseBody ?? {});
    } catch {
      throw new GatewayError(502, "invalid_upstream_response", "Provider upstream response was not serializable.");
    }
  }
  const status = result.status ?? 200;
  if (status < 200 || status >= 300) {
    throw new GatewayError(502, "upstream_error", "Provider upstream returned an error.", { status });
  }
  return {
    status,
    body: responseBody,
    contentType: result.contentType ?? result.headers?.["content-type"] ?? "",
    headers: result.headers,
  };
}

function parseNonStreamingProviderBody(endpoint, body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new GatewayError(502, "invalid_upstream_response", "Provider upstream returned invalid JSON.");
  }
  const text = extractTextFromPayload(endpoint, payload);
  return { text, payload };
}

function endpointResponse(endpoint, args) {
  return endpoint === CHAT_COMPLETIONS_PATH
    ? createChatResponse(args)
    : createResponsesResponse(args);
}

function endpointStream(endpoint, args) {
  return endpoint === CHAT_COMPLETIONS_PATH
    ? createChatStream(args)
    : createResponsesStream(args);
}

function parseProcedureSource(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readProcedureFile(path) {
  try {
    return parseProcedureSource(readFileSync(path, "utf8"));
  } catch {
    throw new GatewayError(500, "procedure_unavailable", "Trusted procedure startup configuration could not be read.");
  }
}

function resolveTrustedProcedure({ configuredProcedure, configuredCore, procedureFile, allowTestProcedureDefault }) {
  const filePath = procedureFile ?? process.env.SKILL_STATE_PROCEDURE_FILE;
  const fromFile = configuredProcedure === undefined && filePath
    ? readProcedureFile(filePath)
    : undefined;
  const fromEnv = configuredProcedure === undefined && fromFile === undefined
    ? parseProcedureSource(process.env.SKILL_STATE_PROCEDURE)
    : undefined;
  const configured = configuredProcedure ?? fromFile ?? fromEnv ?? configuredCore?.procedure;
  try {
    const procedure = normalizeProcedure(configured, allowTestProcedureDefault === true);
    if (configuredProcedure !== undefined && configuredCore?.procedure !== undefined &&
        hashProcedure(configuredCore.procedure) !== hashProcedure(procedure)) {
      throw new GatewayError(500, "procedure_conflict", "Gateway and core procedure configurations differ.");
    }
    return procedure;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(
      500,
      "procedure_required",
      "A non-empty trusted procedure must be configured at gateway startup.",
    );
  }
}

export function createGateway({
  core: configuredCore,
  stateRootDir = process.env.SKILL_STATE_ROOT ?? ".skill-state",
  procedure: configuredProcedure,
  procedureFile,
  allowTestProcedureDefault = false,
  upstream,
  upstreamBaseUrl = process.env.PROVIDER_UPSTREAM_URL,
  upstreamApiKey = process.env.PROVIDER_UPSTREAM_API_KEY,
  upstreamTimeoutMs = 120_000,
  upstreamFetch,
  upstreamHeaders,
  defaultModel,
} = {}) {
  const procedure = resolveTrustedProcedure({
    configuredProcedure,
    configuredCore,
    procedureFile,
    allowTestProcedureDefault,
  });
  const procedureHash = hashProcedure(procedure);
  const core = configuredCore ?? createSkillStateCore({
    rootDir: stateRootDir,
    procedure,
  });
  const coreBoundary = createCoreBoundary(core, { trustedProcedureHash: procedureHash });
  const upstreamClient = upstream ?? createUpstreamClient({
    baseUrl: upstreamBaseUrl,
    apiKey: upstreamApiKey,
    fetchImpl: upstreamFetch,
    timeoutMs: upstreamTimeoutMs,
    headers: upstreamHeaders,
  });
  const coreConfigured = coreBoundary.ready === true;
  const upstreamConfigured = Boolean(upstream || upstreamBaseUrl);

  const gateway = {
    capabilities() {
      return capabilities(upstreamConfigured, coreConfigured);
    },

    async handle(request) {
      const requestId = request.headers.get("x-request-id") || newRequestId();
      const url = new URL(request.url, "http://skill-state-gateway.local");
      const method = request.method.toUpperCase();

      try {
        if (method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
          return jsonResponse({
            status: "ok",
            core_configured: coreConfigured,
            upstream_configured: upstreamConfigured,
          }, 200, requestId);
        }
        if (method === "GET" && url.pathname === "/capabilities") {
          return jsonResponse(gateway.capabilities(), 200, requestId);
        }
        if (!SUPPORTED_PATHS.includes(url.pathname)) {
          throw new GatewayError(404, "not_found", "Gateway route was not found.");
        }
        if (method !== "POST") {
          throw new GatewayError(405, "method_not_allowed", "Only POST is supported for model routes.");
        }

        const rawBody = await readJsonBody(request);
        const body = assertCompletionRequest(rawBody, defaultModel);
        // A provider call is never attempted when the state transition cannot
        // be committed. This keeps an incomplete core wiring from becoming a
        // silent state bypass after a successful model response.
        coreBoundary.assertReady();
        const prepared = await coreBoundary.prepare({
          endpoint: url.pathname,
          body,
          requestId,
        });
        const upstreamBody = buildUpstreamBody(url.pathname, body, prepared);
        const provider = await callInjectedUpstream(upstreamClient, url.pathname, upstreamBody, {
          requestId,
          signal: request.signal,
        });

        if (body.stream === true) {
          const extracted = extractTextFromStream(url.pathname, provider.body, provider.contentType);
          const envelope = parseStructuredOutput(extracted.text);
          await coreBoundary.commit({
            endpoint: url.pathname,
            prepared,
            envelope,
          });
          const streamBody = endpointStream(url.pathname, {
            envelope,
            upstreamPayload: extracted.upstreamPayload,
            metadata: extracted.metadata,
            model: body.model,
            requestId,
          });
          return new Response(streamBody, {
            status: 200,
            headers: responseHeaders(requestId, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
              "x-gateway-stream-buffered": "true",
            }),
          });
        }

        const extracted = parseNonStreamingProviderBody(url.pathname, provider.body);
        const envelope = parseStructuredOutput(extracted.text);
        await coreBoundary.commit({
          endpoint: url.pathname,
          prepared,
          envelope,
        });
        return jsonResponse(endpointResponse(url.pathname, {
          envelope,
          upstreamPayload: extracted.payload,
          model: body.model,
          requestId,
        }), 200, requestId);
      } catch (error) {
        const { status, body } = errorResponseBody(error, requestId);
        return jsonResponse(body, status, requestId);
      }
    },
  };

  return gateway;
}

async function readNodeBody(request, maxBytes = MAX_REQUEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new GatewayError(413, "request_too_large", "Request body is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createHttpServer(gateway, { httpModule = { createServer: createNodeServer } } = {}) {
  if (!gateway || typeof gateway.handle !== "function") {
    throw new TypeError("createHttpServer requires a gateway created by createGateway");
  }
  return httpModule.createServer(async (incoming, outgoing) => {
    const requestId = incoming.headers["x-request-id"] ?? newRequestId();
    let body = "";
    try {
      if (incoming.method !== "GET" && incoming.method !== "HEAD") body = await readNodeBody(incoming);
      const request = new Request(`http://skill-state-gateway.local${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers: incoming.headers,
        body: body || undefined,
      });
      const response = await gateway.handle(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      outgoing.setHeader("x-request-id", response.headers.get("x-request-id") ?? requestId);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const { status, body: responseBody } = errorResponseBody(error, requestId);
      outgoing.statusCode = status;
      outgoing.setHeader("content-type", "application/json; charset=utf-8");
      outgoing.setHeader("x-request-id", requestId);
      outgoing.end(JSON.stringify(responseBody));
    }
  });
}
