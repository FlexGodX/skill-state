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
    body: Record<string, unknown>,
    options: { requestId: string; signal?: AbortSignal },
  ): Promise<UpstreamResponse>;
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
    body: Record<string, unknown>;
    requestId: string;
    signal?: AbortSignal;
  }) => Promise<UpstreamResponse>);
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  upstreamTimeoutMs?: number;
  upstreamFetch?: typeof fetch;
  upstreamHeaders?: Record<string, string>;
  defaultModel?: string;
  stateRootDir?: string;
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
): Record<string, unknown>;
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
