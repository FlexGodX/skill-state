import { chmodSync, constants as fsConstants, lstatSync, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";

export const MAX_DEBUG_CAPTURE_BYTES = 256 * 1024;
const TRUNCATION_MARKER = "\n[truncated]\n";

function preparePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError(`debug directory is not a private directory: ${directory}`);
  }
  chmodSync(directory, 0o700);
}

function safeFileId(requestId) {
  // Request ids may come from the client's x-request-id header; never let them
  // shape a path. Only [A-Za-z0-9_-] survive, so "." and "/" cannot traverse.
  const id = String(requestId ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return id === "" ? "unknown" : id;
}

function captureContent(requestId, text) {
  const header = Buffer.from(`request_id: ${String(requestId ?? "")}\n\n`, "utf8");
  const body = Buffer.from(typeof text === "string" ? text : "", "utf8");
  if (header.length + body.length <= MAX_DEBUG_CAPTURE_BYTES) return Buffer.concat([header, body]);
  const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
  const room = Math.max(0, MAX_DEBUG_CAPTURE_BYTES - header.length - marker.length);
  return Buffer.concat([header, body.subarray(0, room), marker]).subarray(0, MAX_DEBUG_CAPTURE_BYTES);
}

/**
 * Opt-in local payload logging for invalid model output. Only the text the
 * gateway extracted from the provider response is written, never the client
 * request. Returns null when no directory is configured.
 */
export function createDebugCapture(directory) {
  if (directory === undefined || directory === null || directory === "") return null;
  if (typeof directory !== "string") throw new TypeError("debugDir must be a string path");
  const root = resolve(directory);
  preparePrivateDirectory(root);

  return {
    directory: root,
    async recordInvalidOutput(requestId, text) {
      const path = join(root, `invalid-${safeFileId(requestId)}.txt`);
      let handle;
      try {
        const info = lstatSync(root);
        if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
        handle = await open(
          path,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
          0o600,
        );
        await handle.chmod(0o600);
        await handle.writeFile(captureContent(requestId, text));
        return path;
      } catch {
        // Debug capture must never change the client-visible error.
        return undefined;
      } finally {
        await handle?.close().catch(() => {});
      }
    },
  };
}
