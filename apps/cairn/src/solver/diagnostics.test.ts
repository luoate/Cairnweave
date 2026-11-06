import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyModelError, modelFailureDetail, persistedModelDiagnostic, persistModelDiagnostic, readModelDiagnostic, readModelSessionState } from "./diagnostics";

let root: string;
let session: string;
let log: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cairn-diagnostic-"));
  session = join(root, "task");
  mkdirSync(join(session, "solver-session"), { recursive: true });
  log = join(session, "solver-session", "2026-11-05T07-00-00-000Z_session.jsonl");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const event = (message: string) => `${JSON.stringify({ type: "message", timestamp: "2026-11-05T07:00:00Z",
  message: { role: "assistant", stopReason: "error", errorMessage: message } })}\n`;

describe("safe model diagnostics", () => {
  test("classifies known failures without returning arbitrary provider text", () => {
    for (const [message, code] of [
      ["Connection error. Authorization: Bearer secret-credential", "model_connection_error"],
      ["ECONNRESET", "model_connection_error"], ["401 invalid api key", "model_auth_error"],
      ["429 rate limit", "model_rate_limit"], ["request timed out", "model_timeout"],
      ["unknown private response", "model_error"],
    ] as const) expect(classifyModelError(message)).toBe(code);
  });

  test("shows complete live retry events, ignoring user content and partial writes", () => {
    writeFileSync(log, JSON.stringify({ type: "message", message: { role: "user", errorMessage: "401" } }) + "\n" + event("Connection error. secret-credential") + event("Connection error."));
    appendFileSync(log, '{"type":"message","message":');
    const diagnostic = readModelDiagnostic(session)!;
    expect(diagnostic.code).toBe("model_connection_error");
    expect(diagnostic.recent_error_count).toBe(2);
    expect(diagnostic.observed_at).toBe("2026-11-05T07:00:00Z");
    expect(JSON.stringify(diagnostic)).not.toContain("secret-credential");
  });

  test("a recovered assistant response clears transient errors", () => {
    writeFileSync(log, event("Connection error.") + JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } }) + "\n");
    expect(readModelDiagnostic(session)).toBeNull();
  });

  test("large histories use a bounded tail, not full transcripts", () => {
    writeFileSync(log, "x".repeat(300000) + "\n" + event("Connection error."));
    expect(readModelDiagnostic(session)?.code).toBe("model_connection_error");
    writeFileSync(log, event("Connection error.") + "x".repeat(300000));
    expect(readModelDiagnostic(session)).toBeNull();
  });

  test("missing, malformed, and redirected session directories fail closed", () => {
    expect(readModelDiagnostic(join(root, "missing"))).toBeNull();
    writeFileSync(log, "not-json\nnull\n{\n");
    expect(readModelDiagnostic(session)).toBeNull();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "session.jsonl"), event("Connection error."));
    rmSync(join(session, "solver-session"), { recursive: true });
    symlinkSync(outside, join(session, "solver-session"), process.platform === "win32" ? "junction" : "dir");
    expect(readModelDiagnostic(session)).toBeNull();
  });

  test("salvage detection distinguishes pure errors from observations and incomplete history", () => {
    writeFileSync(log, event("Connection error"));
    expect(readModelSessionState(session).hasUsefulWork).toBe(false);
    writeFileSync(log, JSON.stringify({ type: "message", message: { role: "toolResult", content: [] } }) + "\n" + event("Connection error"));
    expect(readModelSessionState(session).hasUsefulWork).toBe(true);
    writeFileSync(log, "x".repeat(300000) + "\n" + event("Connection error"));
    expect(readModelSessionState(session).hasUsefulWork).toBeNull();
    writeFileSync(log, event("Connection error") + "{unfinished");
    expect(readModelSessionState(session).hasUsefulWork).toBeNull();
    writeFileSync(log, JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "partial analysis worth preserving" }] } }) + "\n" + event("Connection error"));
    expect(readModelSessionState(session).hasUsefulWork).toBe(true);
  });

  test("resumed errors can be mirrored safely into the current task without losing their classification", () => {
    for (const message of ["401 invalid api key secret-credential", "429 rate limit", "Connection error", "timed out", "private body"]) {
      writeFileSync(log, event(message));
      const diagnostic = readModelDiagnostic(session)!;
      const current = join(root, "current");
      persistModelDiagnostic(current, diagnostic);
      expect(readModelDiagnostic(current)?.code).toBe(diagnostic.code);
      expect(JSON.stringify(readModelDiagnostic(current))).not.toContain("secret-credential");
    }
  });

  test("durable detail round trips only fixed messages, never raw provider content", () => {
    writeFileSync(log, event("403 Authorization: Bearer secret-credential"));
    const diagnostic = readModelDiagnostic(session)!;
    const detail = modelFailureDetail(diagnostic);
    expect(detail).not.toContain("secret-credential");
    rmSync(session, { recursive: true });
    expect(persistedModelDiagnostic(detail + " (exit 3)", "2026-11-05T07:00:00Z")?.code).toBe("model_auth_error");
    expect(persistedModelDiagnostic("raw secret response", null)).toBeNull();
  });
});
