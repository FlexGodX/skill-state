#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  CLIENT_TEXT_MODES,
  createGateway,
  createHttpServer,
  PROMPT_CONTROLS_MODES,
  STRUCTURED_OUTPUT_MODES,
  UPSTREAM_REASONING_EFFORTS,
  UPSTREAM_API_MODES,
  UPSTREAM_STREAM_MODES,
  validateEnvelopeSchema,
} from "../src/index.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_UPSTREAM = "http://127.0.0.1:1234/v1";
const DEFAULT_STATE_DIR = join(homedir(), ".local", "share", "skill-state");
const DEFAULT_PROCEDURE_DIR = join(homedir(), ".config", "skill-state");
const MAX_ENVELOPE_SCHEMA_BYTES = 64 * 1024;

export class GatewayCliError extends Error {
  constructor(message, code = "gateway_cli_error") {
    super(message);
    this.name = "GatewayCliError";
    this.code = code;
  }
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1";
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new GatewayCliError("SKILL_STATE_PORT must be an integer between 1 and 65535", "invalid_port");
  }
  return port;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new GatewayCliError(`${name} must be a positive integer`, "invalid_integer");
  }
  return parsed;
}

function parseEnumOption(value, name, allowed, code) {
  const normalized = value.trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new GatewayCliError(`${name} must be one of: ${allowed.join(", ")}`, code);
  }
  return normalized;
}

function parseReasoningEffort(value) {
  if (value === undefined || value.trim() === "") return undefined;
  return parseEnumOption(
    value,
    "SKILL_STATE_UPSTREAM_REASONING_EFFORT",
    UPSTREAM_REASONING_EFFORTS,
    "invalid_reasoning_effort",
  );
}

function parseStructuredOutputMode(value) {
  if (value === undefined || value.trim() === "") return "off";
  return parseEnumOption(value, "SKILL_STATE_STRUCTURED_OUTPUT", STRUCTURED_OUTPUT_MODES, "invalid_structured_output_mode");
}

function parseDropTools(value, structuredOutput) {
  if (value === undefined || value.trim() === "") return structuredOutput === "json_schema";
  return parseEnumOption(value, "SKILL_STATE_DROP_TOOLS", ["true", "false"], "invalid_drop_tools") === "true";
}

function parseUpstreamStream(value) {
  if (value === undefined || value.trim() === "") return "auto";
  return parseEnumOption(value, "SKILL_STATE_UPSTREAM_STREAM", UPSTREAM_STREAM_MODES, "invalid_upstream_stream");
}

function parseClientText(value) {
  if (value === undefined || value.trim() === "") return "envelope";
  return parseEnumOption(value, "SKILL_STATE_CLIENT_TEXT", CLIENT_TEXT_MODES, "invalid_client_text");
}

function parseUpstreamApi(value) {
  if (value === undefined || value.trim() === "") return "same";
  return parseEnumOption(value, "SKILL_STATE_UPSTREAM_API", UPSTREAM_API_MODES, "invalid_upstream_api");
}

function parsePromptControls(value) {
  if (value === undefined || value.trim() === "") return "all";
  return parseEnumOption(value, "SKILL_STATE_PROMPT_CONTROLS", PROMPT_CONTROLS_MODES, "invalid_prompt_controls");
}

function optionalPath(value) {
  return value === undefined || value.trim() === "" ? undefined : resolve(value);
}

/**
 * Read the operator's upstream structured-output schema. It replaces only the
 * schema sent upstream; the gateway's envelope validation is unchanged.
 */
export function loadEnvelopeSchemaFile(path) {
  const invalid = (reason) => new GatewayCliError(
    `SKILL_STATE_ENVELOPE_SCHEMA_FILE ${reason}`,
    "invalid_envelope_schema",
  );
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw invalid("does not exist");
  }
  if (info.isSymbolicLink() || !info.isFile()) throw invalid("must be a regular file (symlinks are refused)");
  if (info.size > MAX_ENVELOPE_SCHEMA_BYTES) throw invalid("exceeds 64 KB");
  const raw = readFileSync(path);
  if (raw.length > MAX_ENVELOPE_SCHEMA_BYTES) throw invalid("exceeds 64 KB");
  let schema;
  try {
    schema = JSON.parse(raw.toString("utf8"));
    validateEnvelopeSchema(schema);
  } catch (error) {
    throw invalid(error instanceof TypeError ? `is invalid: ${error.message}` : "is not valid JSON");
  }
  return Object.freeze({
    schema,
    sha256: createHash("sha256").update(raw).digest("hex").slice(0, 12),
  });
}

function withEnvelopeSchema(config) {
  if (!config.envelopeSchemaFile) return config;
  const loaded = loadEnvelopeSchemaFile(config.envelopeSchemaFile);
  return Object.freeze({ ...config, envelopeSchema: loaded.schema, envelopeSchemaSha256: loaded.sha256 });
}

function effectiveUpstreamStream(config) {
  const mode = config.upstreamStream ?? "auto";
  if (mode === "true") return "client";
  if (mode === "false") return "off";
  return config.structuredOutput === "json_schema" ? "off" : "client";
}

function firstExistingProcedureFile(directory) {
  const candidates = [join(directory, "procedure.json"), join(directory, "procedure.md")];
  for (const candidate of candidates) {
    try {
      const info = lstatSync(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return candidate;
    } catch {
      // The startup error below names the required configuration, not secrets.
    }
  }
  return candidates[0];
}

export function parseGatewayConfig(env = process.env) {
  const host = env.SKILL_STATE_BIND_HOST ?? DEFAULT_HOST;
  if (!isLoopbackHost(host)) {
    throw new GatewayCliError(
      "SKILL_STATE_BIND_HOST must be 127.0.0.1 or ::1; refusing a non-loopback bind",
      "non_loopback_bind",
    );
  }

  const stateDir = resolve(env.SKILL_STATE_ROOT ?? DEFAULT_STATE_DIR);
  const procedureFile = resolve(
    env.SKILL_STATE_PROCEDURE_FILE ?? firstExistingProcedureFile(DEFAULT_PROCEDURE_DIR),
  );
  const upstreamBaseUrl = env.PROVIDER_UPSTREAM_URL ?? DEFAULT_UPSTREAM;
  let parsedUpstream;
  try {
    parsedUpstream = new URL(upstreamBaseUrl);
  } catch {
    throw new GatewayCliError("PROVIDER_UPSTREAM_URL must be an absolute URL", "invalid_upstream_url");
  }
  if (parsedUpstream.username || parsedUpstream.password) {
    throw new GatewayCliError("PROVIDER_UPSTREAM_URL must not contain credentials", "upstream_credentials");
  }

  const structuredOutput = parseStructuredOutputMode(env.SKILL_STATE_STRUCTURED_OUTPUT);

  return Object.freeze({
    host,
    port: parsePort(env.SKILL_STATE_PORT ?? String(DEFAULT_PORT)),
    stateDir,
    procedureFile,
    upstreamBaseUrl,
    upstreamApiKey: env.PROVIDER_UPSTREAM_API_KEY,
    upstreamTimeoutMs: parsePositiveInteger(
      env.PROVIDER_UPSTREAM_TIMEOUT_MS ?? "120000",
      "PROVIDER_UPSTREAM_TIMEOUT_MS",
    ),
    defaultModel: env.SKILL_STATE_MODEL,
    upstreamReasoningEffort: parseReasoningEffort(env.SKILL_STATE_UPSTREAM_REASONING_EFFORT),
    structuredOutput,
    dropTools: parseDropTools(env.SKILL_STATE_DROP_TOOLS, structuredOutput),
    upstreamStream: parseUpstreamStream(env.SKILL_STATE_UPSTREAM_STREAM),
    clientText: parseClientText(env.SKILL_STATE_CLIENT_TEXT),
    debugDir: optionalPath(env.SKILL_STATE_DEBUG_DIR),
    upstreamApi: parseUpstreamApi(env.SKILL_STATE_UPSTREAM_API),
    envelopeSchemaFile: optionalPath(env.SKILL_STATE_ENVELOPE_SCHEMA_FILE),
    promptControls: parsePromptControls(env.SKILL_STATE_PROMPT_CONTROLS),
  });
}

export function ensurePrivateDirectory(directory, label = "state directory", code = "invalid_state_dir") {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new GatewayCliError(`${label} is not a private directory: ${directory}`, code);
  }
  chmodSync(directory, 0o700);
}

export function assertProcedureFile(procedureFile) {
  let info;
  try {
    info = lstatSync(procedureFile);
  } catch {
    throw new GatewayCliError(
      "trusted procedure file is missing; set SKILL_STATE_PROCEDURE_FILE or create ~/.config/skill-state/procedure.json",
      "procedure_missing",
    );
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new GatewayCliError("trusted procedure file must be a regular file", "invalid_procedure_file");
  }
  chmodSync(procedureFile, 0o600);
}

export function safeStartupSummary(config) {
  return {
    bind: `http://${config.host}:${config.port}`,
    upstream: config.upstreamBaseUrl,
    stateDir: config.stateDir,
    procedureFile: config.procedureFile,
    model: config.defaultModel ?? "request model required",
    apiKeyConfigured: Boolean(config.upstreamApiKey),
    reasoningEffort: config.upstreamReasoningEffort ?? null,
    structuredOutput: config.structuredOutput ?? "off",
    dropTools: config.dropTools ?? config.structuredOutput === "json_schema",
    upstreamStream: config.upstreamStream ?? "auto",
    upstreamStreamEffective: effectiveUpstreamStream(config),
    clientText: config.clientText ?? "envelope",
    debugDir: config.debugDir ?? null,
    upstreamApi: config.upstreamApi ?? "same",
    envelopeSchemaFile: config.envelopeSchemaFile ?? null,
    envelopeSchemaSha256: config.envelopeSchemaSha256 ?? null,
    promptControls: config.promptControls ?? "all",
  };
}

export async function startGateway(parsedConfig = parseGatewayConfig()) {
  const config = withEnvelopeSchema(parsedConfig);
  ensurePrivateDirectory(config.stateDir);
  if (config.debugDir) ensurePrivateDirectory(config.debugDir, "SKILL_STATE_DEBUG_DIR", "invalid_debug_dir");
  assertProcedureFile(config.procedureFile);

  const gateway = createGateway({
    stateRootDir: config.stateDir,
    procedureFile: config.procedureFile,
    upstreamBaseUrl: config.upstreamBaseUrl,
    upstreamApiKey: config.upstreamApiKey,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    defaultModel: config.defaultModel,
    upstreamReasoningEffort: config.upstreamReasoningEffort,
    structuredOutput: config.structuredOutput,
    dropTools: config.dropTools,
    upstreamStream: config.upstreamStream,
    clientText: config.clientText,
    debugDir: config.debugDir,
    upstreamApi: config.upstreamApi,
    envelopeSchema: config.envelopeSchema,
    promptControls: config.promptControls,
  });
  const server = createHttpServer(gateway);
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, config.host, resolveListen);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { server, gateway, config };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsedConfig = parseGatewayConfig(env);
  if (argv.includes("--check")) {
    const config = withEnvelopeSchema(parsedConfig);
    ensurePrivateDirectory(config.stateDir);
    if (config.debugDir) ensurePrivateDirectory(config.debugDir, "SKILL_STATE_DEBUG_DIR", "invalid_debug_dir");
    assertProcedureFile(config.procedureFile);
    process.stdout.write(`${JSON.stringify(safeStartupSummary(config))}\n`);
    return 0;
  }

  const started = await startGateway(parsedConfig);
  process.stdout.write(`${JSON.stringify({ status: "listening", ...safeStartupSummary(started.config) })}\n`);
  return started;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const message = error instanceof GatewayCliError
      ? error.message
      : "gateway failed to start; inspect service status without enabling payload logging";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
