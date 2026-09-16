import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import {
  parseGatewayConfig,
  safeStartupSummary,
} from "../bin/skill-state-gateway.mjs";

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
    assert.equal(stdout.includes(secret), false);
    assert.equal(stdout.includes("state_patch"), false);
    assert.equal(stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
