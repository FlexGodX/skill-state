import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import {
  loadEnvelopeSchemaFile,
  parseGatewayConfig,
  safeStartupSummary,
} from "../bin/skill-state-gateway.mjs";
import { ENVELOPE_SCHEMA } from "../src/index.mjs";

const CLI_PATH = fileURLToPath(new URL("../bin/skill-state-gateway.mjs", import.meta.url));

test("CLI defaults to loopback and the local LM Studio upstream", () => {
  const config = parseGatewayConfig({
    SKILL_STATE_ROOT: "/tmp/skill-state-test",
    SKILL_STATE_PROCEDURE_FILE: "/tmp/skill-state-procedure.json",
  });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.upstreamBaseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(config.upstreamTimeoutMs, 120_000);
  assert.equal(safeStartupSummary(config).apiKeyConfigured, false);
});

test("CLI parses upstream reasoning, structured output, and tool overrides", () => {
  const base = { SKILL_STATE_PROCEDURE_FILE: "/tmp/procedure.json" };
  const defaults = parseGatewayConfig(base);
  assert.equal(defaults.upstreamReasoningEffort, undefined);
  assert.equal(defaults.structuredOutput, "off");
  assert.equal(defaults.dropTools, false);
  assert.deepEqual(
    (({ reasoningEffort, structuredOutput, dropTools }) => ({ reasoningEffort, structuredOutput, dropTools }))(
      safeStartupSummary(defaults),
    ),
    { reasoningEffort: null, structuredOutput: "off", dropTools: false },
  );

  for (const effort of ["none", "minimal", "low", "medium", "high"]) {
    assert.equal(parseGatewayConfig({ ...base, SKILL_STATE_UPSTREAM_REASONING_EFFORT: effort }).upstreamReasoningEffort, effort);
  }
  const forced = parseGatewayConfig({
    ...base,
    SKILL_STATE_UPSTREAM_REASONING_EFFORT: "none",
    SKILL_STATE_STRUCTURED_OUTPUT: "json_schema",
  });
  assert.equal(forced.structuredOutput, "json_schema");
  assert.equal(forced.dropTools, true);
  const summary = safeStartupSummary(forced);
  assert.equal(summary.reasoningEffort, "none");
  assert.equal(summary.structuredOutput, "json_schema");
  assert.equal(summary.dropTools, true);

  assert.equal(parseGatewayConfig({ ...base, SKILL_STATE_STRUCTURED_OUTPUT: "json_schema", SKILL_STATE_DROP_TOOLS: "false" }).dropTools, false);
  assert.equal(parseGatewayConfig({ ...base, SKILL_STATE_DROP_TOOLS: "true" }).dropTools, true);

  for (const [name, value, code] of [
    ["SKILL_STATE_UPSTREAM_REASONING_EFFORT", "extreme", "invalid_reasoning_effort"],
    ["SKILL_STATE_STRUCTURED_OUTPUT", "json_object", "invalid_structured_output_mode"],
    ["SKILL_STATE_DROP_TOOLS", "yes", "invalid_drop_tools"],
  ]) {
    assert.throws(
      () => parseGatewayConfig({ ...base, [name]: value }),
      (error) => error?.code === code && error.message.includes(name),
    );
  }
});

test("CLI parses upstream stream, client text, and debug directory options", () => {
  const base = { SKILL_STATE_PROCEDURE_FILE: "/tmp/procedure.json" };
  const defaults = parseGatewayConfig(base);
  assert.equal(defaults.upstreamStream, "auto");
  assert.equal(defaults.clientText, "envelope");
  assert.equal(defaults.debugDir, undefined);
  const defaultSummary = safeStartupSummary(defaults);
  assert.equal(defaultSummary.upstreamStream, "auto");
  assert.equal(defaultSummary.upstreamStreamEffective, "client");
  assert.equal(defaultSummary.clientText, "envelope");
  assert.equal(defaultSummary.debugDir, null);

  assert.equal(
    safeStartupSummary(parseGatewayConfig({ ...base, SKILL_STATE_STRUCTURED_OUTPUT: "json_schema" })).upstreamStreamEffective,
    "off",
  );
  assert.equal(
    safeStartupSummary(parseGatewayConfig({ ...base, SKILL_STATE_STRUCTURED_OUTPUT: "json_schema", SKILL_STATE_UPSTREAM_STREAM: "true" })).upstreamStreamEffective,
    "client",
  );
  const configured = parseGatewayConfig({
    ...base,
    SKILL_STATE_UPSTREAM_STREAM: "false",
    SKILL_STATE_CLIENT_TEXT: "action",
    SKILL_STATE_DEBUG_DIR: "/tmp/skill-state-debug",
  });
  assert.equal(configured.upstreamStream, "false");
  assert.equal(configured.clientText, "action");
  assert.equal(configured.debugDir, "/tmp/skill-state-debug");
  assert.equal(safeStartupSummary(configured).upstreamStreamEffective, "off");

  for (const [name, value, code] of [
    ["SKILL_STATE_UPSTREAM_STREAM", "yes", "invalid_upstream_stream"],
    ["SKILL_STATE_CLIENT_TEXT", "plain", "invalid_client_text"],
  ]) {
    assert.throws(
      () => parseGatewayConfig({ ...base, [name]: value }),
      (error) => error?.code === code && error.message.includes(name),
    );
  }
});

async function runCli(args, env) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stdout, stderr };
}

test("CLI parses SKILL_STATE_UPSTREAM_API and the envelope schema file path", () => {
  const base = { SKILL_STATE_PROCEDURE_FILE: "/tmp/procedure.json" };
  const defaults = parseGatewayConfig(base);
  assert.equal(defaults.upstreamApi, "same");
  assert.equal(defaults.envelopeSchemaFile, undefined);
  const summary = safeStartupSummary(defaults);
  assert.equal(summary.upstreamApi, "same");
  assert.equal(summary.envelopeSchemaFile, null);
  assert.equal(summary.envelopeSchemaSha256, null);

  const chat = parseGatewayConfig({ ...base, SKILL_STATE_UPSTREAM_API: "CHAT", SKILL_STATE_ENVELOPE_SCHEMA_FILE: "/tmp/schema.json" });
  assert.equal(chat.upstreamApi, "chat");
  assert.equal(chat.envelopeSchemaFile, "/tmp/schema.json");
  assert.throws(
    () => parseGatewayConfig({ ...base, SKILL_STATE_UPSTREAM_API: "responses" }),
    (error) => error?.code === "invalid_upstream_api" && error.message.includes("SKILL_STATE_UPSTREAM_API"),
  );
});

test("envelope schema file must be a small regular JSON object describing the envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-state-schema-"));
  try {
    const valid = join(root, "schema.json");
    const text = JSON.stringify(ENVELOPE_SCHEMA);
    await writeFile(valid, text);
    const loaded = loadEnvelopeSchemaFile(valid);
    assert.deepEqual(loaded.schema, ENVELOPE_SCHEMA);
    assert.equal(loaded.sha256, createHash("sha256").update(text).digest("hex").slice(0, 12));

    const cases = {
      "invalid-json.json": "{not json",
      "array.json": "[]",
      "wrong-type.json": JSON.stringify({ type: "array", required: ["state_patch", "action"] }),
      "missing-action.json": JSON.stringify({ type: "object", required: ["state_patch"] }),
      "too-big.json": JSON.stringify({ ...ENVELOPE_SCHEMA, description: "x".repeat(64 * 1024) }),
    };
    for (const [name, content] of Object.entries(cases)) {
      await writeFile(join(root, name), content);
      assert.throws(() => loadEnvelopeSchemaFile(join(root, name)), (error) => error?.code === "invalid_envelope_schema", name);
    }
    const linked = join(root, "linked.json");
    await symlink(valid, linked);
    assert.throws(() => loadEnvelopeSchemaFile(linked), (error) => error?.code === "invalid_envelope_schema");
    assert.throws(() => loadEnvelopeSchemaFile(join(root, "missing.json")), (error) => error?.code === "invalid_envelope_schema");
    assert.throws(() => loadEnvelopeSchemaFile(root), (error) => error?.code === "invalid_envelope_schema");

    const procedureFile = join(root, "procedure.json");
    await writeFile(procedureFile, JSON.stringify({ id: "local", version: 1 }), { mode: 0o600 });
    const env = {
      SKILL_STATE_ROOT: join(root, "state"),
      SKILL_STATE_PROCEDURE_FILE: procedureFile,
      SKILL_STATE_UPSTREAM_API: "chat",
      SKILL_STATE_PROMPT_CONTROLS: "generation",
    };
    const ok = await runCli(["--check"], { ...env, SKILL_STATE_ENVELOPE_SCHEMA_FILE: valid });
    assert.equal(ok.exitCode, 0, ok.stderr);
    const summary = JSON.parse(ok.stdout);
    assert.equal(summary.upstreamApi, "chat");
    assert.equal(summary.envelopeSchemaFile, valid);
    assert.equal(summary.envelopeSchemaSha256, loaded.sha256);
    assert.equal(summary.promptControls, "generation");

    const bad = await runCli(["--check"], { ...env, SKILL_STATE_ENVELOPE_SCHEMA_FILE: linked });
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /SKILL_STATE_ENVELOPE_SCHEMA_FILE/);
    assert.equal(bad.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI parses SKILL_STATE_PROMPT_CONTROLS", () => {
  const base = { SKILL_STATE_PROCEDURE_FILE: "/tmp/procedure.json" };
  assert.equal(parseGatewayConfig(base).promptControls, "all");
  assert.equal(safeStartupSummary(parseGatewayConfig(base)).promptControls, "all");
  for (const mode of ["all", "generation", "none"]) {
    const config = parseGatewayConfig({ ...base, SKILL_STATE_PROMPT_CONTROLS: mode });
    assert.equal(config.promptControls, mode);
    assert.equal(safeStartupSummary(config).promptControls, mode);
  }
  assert.throws(
    () => parseGatewayConfig({ ...base, SKILL_STATE_PROMPT_CONTROLS: "tools" }),
    (error) => error?.code === "invalid_prompt_controls" && error.message.includes("SKILL_STATE_PROMPT_CONTROLS"),
  );
});

test("CLI rejects public binds and upstream URLs containing credentials", () => {
  assert.throws(
    () => parseGatewayConfig({
      SKILL_STATE_BIND_HOST: "0.0.0.0",
      SKILL_STATE_PROCEDURE_FILE: "/tmp/procedure.json",
    }),
    (error) => error?.code === "non_loopback_bind",
  );
  assert.throws(
    () => parseGatewayConfig({
      PROVIDER_UPSTREAM_URL: "http://user:password@127.0.0.1:1234/v1",
      SKILL_STATE_PROCEDURE_FILE: "/tmp/procedure.json",
    }),
    (error) => error?.code === "upstream_credentials",
  );
});

test("--check validates local startup files without printing secrets or payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-state-cli-"));
  const stateDir = join(root, "state");
  const debugDir = join(root, "debug");
  const procedureFile = join(root, "procedure.json");
  const secret = "cli-test-secret-must-not-be-printed";
  await writeFile(procedureFile, JSON.stringify({ id: "local", version: 1 }), { mode: 0o600 });

  try {
    const child = spawn(process.execPath, [CLI_PATH, "--check"], {
      env: {
        ...process.env,
        SKILL_STATE_BIND_HOST: "127.0.0.1",
        SKILL_STATE_PORT: "8788",
        SKILL_STATE_ROOT: stateDir,
        SKILL_STATE_PROCEDURE_FILE: procedureFile,
        PROVIDER_UPSTREAM_URL: "http://127.0.0.1:1234/v1",
        PROVIDER_UPSTREAM_API_KEY: secret,
        SKILL_STATE_UPSTREAM_REASONING_EFFORT: "none",
        SKILL_STATE_STRUCTURED_OUTPUT: "json_schema",
        SKILL_STATE_CLIENT_TEXT: "action",
        SKILL_STATE_DEBUG_DIR: debugDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    assert.equal(exitCode, 0, stderr);
    const summary = JSON.parse(stdout);
    assert.equal(summary.bind, "http://127.0.0.1:8788");
    assert.equal(summary.upstream, "http://127.0.0.1:1234/v1");
    assert.equal(summary.apiKeyConfigured, true);
    assert.equal(summary.reasoningEffort, "none");
    assert.equal(summary.structuredOutput, "json_schema");
    assert.equal(summary.dropTools, true);
    assert.equal(summary.upstreamStream, "auto");
    assert.equal(summary.upstreamStreamEffective, "off");
    assert.equal(summary.clientText, "action");
    assert.equal(summary.debugDir, debugDir);
    assert.equal((await lstat(debugDir)).mode & 0o777, 0o700);
    assert.equal(stdout.includes(secret), false);
    assert.equal(stdout.includes("state_patch"), false);
    assert.equal(stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
