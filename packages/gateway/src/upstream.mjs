import { GatewayError } from "./protocol.mjs";

const MAX_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024;

function joinUrl(baseUrl, path, search = "") {
  let parsed;
  try {
    parsed = new URL(String(baseUrl ?? ""));
  } catch {
    throw new GatewayError(503, "upstream_unavailable", "Provider upstream URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GatewayError(503, "upstream_unavailable", "Provider upstream URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new GatewayError(503, "upstream_unavailable", "Provider upstream URL must not contain credentials.");
  }
  parsed.search = "";
  parsed.hash = "";
  const base = parsed.toString().replace(/\/+$/, "");
  if (!base) throw new GatewayError(503, "upstream_unavailable", "Provider upstream URL is not configured.");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const query = typeof search === "string" && search !== "" && search !== "?"
    ? (search.startsWith("?") ? search : `?${search}`)
    : "";
  if (base.endsWith("/v1") && normalizedPath.startsWith("/v1/")) {
    return `${base}${normalizedPath.slice(3)}${query}`;
  }
  return `${base}${normalizedPath}${query}`;
}

export function createUpstreamClient({
  baseUrl = process.env.PROVIDER_UPSTREAM_URL,
  apiKey = process.env.PROVIDER_UPSTREAM_API_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
  headers: configuredHeaders = {},
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new GatewayError(503, "upstream_unavailable", "Provider upstream timeout must be positive.");
  }
  if (typeof fetchImpl !== "function") {
    return {
      async request() {
        throw new GatewayError(503, "upstream_unavailable", "No fetch implementation is available.");
      },
    };
  }

  return {
    /**
     * POST `body` as JSON, or GET without a body when `method` is "GET". Both
     * share the timeout, response-size limit, and authorization handling.
     */
    async request(path, body, { requestId, signal: parentSignal, method = "POST", search } = {}) {
      const isGet = method === "GET";
      const url = joinUrl(baseUrl, path, search);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let removeParentAbort;
      if (parentSignal) {
        if (parentSignal.aborted) controller.abort(parentSignal.reason);
        else {
          removeParentAbort = () => controller.abort(parentSignal.reason);
          parentSignal.addEventListener("abort", removeParentAbort, { once: true });
        }
      }

      const headers = {
        ...(isGet ? {} : { "content-type": "application/json" }),
        accept: body?.stream === true ? "text/event-stream, application/json" : "application/json",
        ...configuredHeaders,
      };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      if (requestId) headers["x-request-id"] = requestId;

      let response;
      try {
        response = await fetchImpl(url, {
          method: isGet ? "GET" : "POST",
          headers,
          ...(isGet ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
      } catch (cause) {
        const timedOut = controller.signal.aborted && !parentSignal?.aborted;
        throw new GatewayError(
          timedOut ? 504 : 502,
          timedOut ? "upstream_timeout" : "upstream_unavailable",
          timedOut ? "Provider upstream timed out." : "Provider upstream could not be reached.",
          undefined,
          { cause },
        );
      } finally {
        clearTimeout(timer);
        if (removeParentAbort) parentSignal.removeEventListener("abort", removeParentAbort);
      }

      const responseBody = await response.text();
      if (Buffer.byteLength(responseBody, "utf8") > MAX_UPSTREAM_RESPONSE_BYTES) {
        throw new GatewayError(502, "upstream_response_too_large", "Provider upstream response is too large.");
      }
      if (!response.ok) {
        throw new GatewayError(
          502,
          "upstream_error",
          "Provider upstream returned an error.",
          { status: response.status },
        );
      }
      return {
        status: response.status,
        body: responseBody,
        contentType: response.headers.get("content-type") ?? "",
        headers: response.headers,
      };
    },
  };
}
