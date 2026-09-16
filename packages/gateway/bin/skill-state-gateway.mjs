#!/usr/bin/env node

import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { createGateway, createHttpServer } from "../src/index.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_UPSTREAM = "http://127.0.0.1:1234/v1";
const DEFAULT_STATE_DIR = join(homedir(), ".local", "share", "skill-state");
const DEFAULT_PROCEDURE_DIR = join(homedir(), ".config", "skill-state");

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
  });
}

export function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new GatewayCliError(`state directory is not a private directory: ${directory}`, "invalid_state_dir");
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
  };
}

export async function startGateway(config = parseGatewayConfig()) {
  ensurePrivateDirectory(config.stateDir);
  assertProcedureFile(config.procedureFile);

  const gateway = createGateway({
    stateRootDir: config.stateDir,
    procedureFile: config.procedureFile,
    upstreamBaseUrl: config.upstreamBaseUrl,
    upstreamApiKey: config.upstreamApiKey,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    defaultModel: config.defaultModel,
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
  const config = parseGatewayConfig(env);
  if (argv.includes("--check")) {
    ensurePrivateDirectory(config.stateDir);
    assertProcedureFile(config.procedureFile);
    process.stdout.write(`${JSON.stringify(safeStartupSummary(config))}\n`);
    return 0;
  }

  const started = await startGateway(config);
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
