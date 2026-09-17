export type GatewayEndpoint = "/v1/chat/completions" | "/v1/responses";

export interface CoreBuildRequest {
  protocol: "p+sigma+latest-o/v1";
  endpoint: GatewayEndpoint;
  model: string;
  sessionId: string;
  expectedRevision?: number;
  idempotencyKey: string;
  latestObservation: unknown;
  request: {
    stream: boolean;
    controls: Record<string, unknown>;
    requestId: string;
  };
}

export interface CoreBuildResult {
  projection: unknown;
  sigma: unknown;
  latestObservation: unknown;
  prompt: string;
  sessionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  procedure: string | Record<string, unknown>;
  procedureHash: string;
}

export interface CoreCommitRequest {
  protocol: "p+sigma+latest-o/v1";
  endpoint: GatewayEndpoint;
  model: string;
  sessionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  procedureHash: string;
  statePatch: Record<string, unknown>;
  action: unknown;
}

export interface CoreStateApi {
  procedure?: string | Record<string, unknown>;
  procedureHash?: string;
  prepareCall?(request: CoreBuildRequest): Promise<CoreBuildResult> | CoreBuildResult;
  buildContext?(request: CoreBuildRequest): Promise<CoreBuildResult> | CoreBuildResult;
  commitResponse?(request: CoreCommitRequest): Promise<unknown> | unknown;
  commitState?(request: CoreCommitRequest): Promise<unknown> | unknown;
}

export interface UpstreamResponse {
  status?: number;
  body: string | Record<string, unknown>;
  contentType?: string;
  headers?: Headers | Record<string, string>;
}

export interface UpstreamClient {
  request(
    endpoint: GatewayEndpoint,
    body: Record<string, unknown> | undefined,
    options: { requestId: string; signal?: AbortSignal; method?: "GET" | "POST"; search?: string },
  ): Promise<UpstreamResponse>;
}

export type UpstreamReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";
export type StructuredOutputMode = "off" | "json_schema";
export type UpstreamStreamMode = "auto" | "true" | "false";
export type ClientTextMode = "envelope" | "action";
export type UpstreamApiMode = "same" | "chat";
export type PromptControlsMode = "all" | "generation" | "none";

export interface UpstreamOverrides {
  /** Overrides client reasoning controls; undefined forwards client values. */
  reasoningEffort?: UpstreamReasoningEffort;
  /** "json_schema" forces the envelope JSON Schema as the upstream output format. Default "off". */
  structuredOutput?: StructuredOutputMode;
  /** Remove tools/tool_choice/parallel_tool_calls. Default: structuredOutput === "json_schema". */
  dropTools?: boolean;
  /** "true" forwards the client stream flag, "false" never streams upstream, "auto" (default) = "false" with json_schema. */
  upstreamStream?: UpstreamStreamMode;
  /** "chat" sends /v1/responses client requests to the provider's /v1/chat/completions. Default "same". */
  upstreamApi?: UpstreamApiMode;
  /** Upstream structured-output schema; defaults to ENVELOPE_SCHEMA. Gateway validation is unchanged. */
  envelopeSchema?: Record<string, unknown>;
}

export interface GatewayOptions {
  core?: CoreStateApi;
  procedure?: string | Record<string, unknown>;
  procedureFile?: string;
  allowTestProcedureDefault?: boolean;
  /** Test-only compatibility fallback; production requests must carry a stable session id. */
  allowTestSessionFallback?: boolean;
  upstream?: UpstreamClient | ((request: {
    path: GatewayEndpoint;
    body: Record<string, unknown> | undefined;
    requestId: string;
    signal?: AbortSignal;
    method?: "GET" | "POST";
    search?: string;
  }) => Promise<UpstreamResponse>);
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  upstreamTimeoutMs?: number;
  upstreamFetch?: typeof fetch;
  upstreamHeaders?: Record<string, string>;
  defaultModel?: string;
  stateRootDir?: string;
  upstreamReasoningEffort?: UpstreamReasoningEffort;
  structuredOutput?: StructuredOutputMode;
  dropTools?: boolean;
  upstreamStream?: UpstreamStreamMode;
  /** Assistant text shown to clients; default "envelope". */
  clientText?: ClientTextMode;
  /** Opt-in local capture of invalid model output (0700 dir, 0600 files, 256 KB max). */
  debugDir?: string;
  upstreamApi?: UpstreamApiMode;
  envelopeSchema?: Record<string, unknown>;
  /** Controls shown in the canonical prompt (P.controls); default "all". Tools are hidden whenever dropTools is effective. */
  promptControls?: PromptControlsMode;
}

export interface Gateway {
  capabilities(): Record<string, unknown>;
  handle(request: Request): Promise<Response>;
}

export function createGateway(options?: GatewayOptions): Gateway;
export function createHttpServer(gateway: Gateway): import("node:http").Server;
export function createCoreBoundary(core?: CoreStateApi, options?: {
  trustedProcedureHash?: string;
  allowTestSessionFallback?: boolean;
  promptControls?: PromptControlsMode;
  dropTools?: boolean;
}): {
  ready: boolean;
  assertReady(): void;
  prepare(args: {
    endpoint: GatewayEndpoint;
    body: Record<string, unknown>;
    headers?: Headers | Record<string, string | string[] | undefined>;
    requestId: string;
  }): Promise<CoreBuildResult & { source: string }>;
  commit(args: { endpoint: GatewayEndpoint; prepared: CoreBuildResult; envelope: { state_patch: Record<string, unknown>; action: unknown } }): Promise<unknown>;
};
export function buildUpstreamBody(
  endpoint: GatewayEndpoint,
  body: Record<string, unknown>,
  prepared: CoreBuildResult,
  overrides?: UpstreamOverrides,
): Record<string, unknown>;
export function resolveUpstreamOverrides(overrides?: UpstreamOverrides): Readonly<{
  reasoningEffort: UpstreamReasoningEffort | undefined;
  structuredOutput: StructuredOutputMode;
  dropTools: boolean;
  upstreamStream: UpstreamStreamMode;
  forwardClientStream: boolean;
  upstreamApi: UpstreamApiMode;
  envelopeSchema: Record<string, unknown> | undefined;
}>;
export const UPSTREAM_API_MODES: readonly UpstreamApiMode[];
export function upstreamEndpointFor(endpoint: GatewayEndpoint, overrides?: UpstreamOverrides): GatewayEndpoint;
export function validateEnvelopeSchema(schema: unknown): Record<string, unknown>;
export function responsesUsageFromChatUsage(usage: unknown): Record<string, unknown> | undefined;
export const UPSTREAM_STREAM_MODES: readonly UpstreamStreamMode[];
export const CLIENT_TEXT_MODES: readonly ClientTextMode[];
export function clientTextForEnvelope(
  envelope: { state_patch: Record<string, unknown>; action: Record<string, unknown> | null },
  mode?: ClientTextMode,
): string;
export const MAX_DEBUG_CAPTURE_BYTES: number;
export function createDebugCapture(directory?: string): null | {
  directory: string;
  recordInvalidOutput(requestId: string, text: string): Promise<string | undefined>;
};
export const UPSTREAM_REASONING_EFFORTS: readonly UpstreamReasoningEffort[];
export const STRUCTURED_OUTPUT_MODES: readonly StructuredOutputMode[];
export const ENVELOPE_SCHEMA_NAME: "skill_state_envelope";
/** JSON Schema of the structured envelope; shares its constraints with validateStructuredEnvelope. */
export const ENVELOPE_SCHEMA: Readonly<Record<string, unknown>>;
export function extractLatestObservation(body: Record<string, unknown>, endpoint: GatewayEndpoint): unknown;
export function extractSessionId(args: {
  body: Record<string, unknown>;
  headers?: Headers | Record<string, string | string[] | undefined>;
  endpoint: GatewayEndpoint;
  requestId: string;
  allowTestSessionFallback?: boolean;
}): string;
export const SESSION_HEADER: "x-skill-state-session";
export const MAX_SESSION_ID_LENGTH: 128;
export function pickRequestControls(body: Record<string, unknown>): Record<string, unknown>;
export const PROMPT_CONTROLS_MODES: readonly PromptControlsMode[];
export const GENERATION_PROMPT_CONTROLS: readonly string[];
export function projectPromptControls(
  controls: Record<string, unknown>,
  options?: { promptControls?: PromptControlsMode; dropTools?: boolean },
): Record<string, unknown>;
export function sanitizeBoundaryValue(value: unknown): unknown;
export function createUpstreamClient(options?: Record<string, unknown>): UpstreamClient;

export const CHAT_COMPLETIONS_PATH: "/v1/chat/completions";
export const RESPONSES_PATH: "/v1/responses";
export const SUPPORTED_PATHS: readonly GatewayEndpoint[];
export class GatewayError extends Error {
  status: number;
  code: string;
  details?: unknown;
}
export function parseStructuredOutput(text: string): { state_patch: Record<string, unknown>; action: Record<string, unknown> | null };
export function validateStructuredEnvelope(value: unknown): { state_patch: Record<string, unknown>; action: Record<string, unknown> | null };
