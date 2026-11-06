import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDatabase, createProject, finishRun, startRun, type CairnDatabase } from "@cairn/graph";
import { createApi, type Api } from "./api";
import { attachRunDiagnostics } from "./run-diagnostics";

let root: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;
let log: string;
const taskId = "bootstrap-test";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cairn-api-diagnostic-"));
  db = configureDatabase(join(root, "cairn.db"));
  projectId = db.withConn(conn => createProject(conn, { title: "diagnostic", origin: "origin", goal: "goal",
    bootstrap_enabled: false, hints: null, scope: { targets: ["127.0.0.1:8080"] } }).project.id);
  const directory = join(root, projectId, ".cairn", "sessions", taskId, "solver-session");
  mkdirSync(directory, { recursive: true });
  log = join(directory, "session.jsonl");
  db.withConn(conn => startRun(conn, { id: "run-test", projectId, taskId, kind: "bootstrap", worker: "fixture", startedAt: "2026-11-05T07:00:00Z" }));
  api = createApi({ db, workspaceRoot: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function get(path: string) { return (await api.handle(new Request("http://cairn.test" + path))).json() as Promise<any>; }
function errorEvent() {
  writeFileSync(log, JSON.stringify({ type: "message", timestamp: "2026-11-05T07:01:00Z",
    message: { role: "assistant", stopReason: "error", errorMessage: "Connection error. Authorization: Bearer fixture-secret" } }) + "\n");
}

test("ongoing model errors are visible without waiting for worker exit or opening the runs tab", async () => {
  errorEvent();
  const detail = await get(`/projects/${projectId}`);
  expect(detail.task_diagnostic.code).toBe("model_connection_error");
  expect(detail.task_diagnostic.outcome).toBeNull();
  const runs = await get(`/projects/${projectId}/runs`);
  expect(runs[0].diagnostic.code).toBe("model_connection_error");
  expect(runs[0].outcome).toBeNull();
  expect(JSON.stringify([detail, runs])).not.toContain("fixture-secret");
  appendFileSync(log, JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop" } }) + "\n");
  expect((await get(`/projects/${projectId}`)).task_diagnostic).toBeUndefined();
});

test("historical generic failures are diagnosed read-only, without rewriting runs", async () => {
  errorEvent();
  db.withConn(conn => finishRun(conn, "run-test", { outcome: "failed", detail: "worker exited with code 3", finishedAt: "2026-11-05T07:02:00Z", durationMs: 120000 }));
  expect((await get(`/projects/${projectId}`)).task_diagnostic.code).toBe("model_connection_error");
  const stored = db.withConn(conn => conn.query("select detail from runs where id = ?").get("run-test")) as { detail: string };
  expect(stored.detail).toBe("worker exited with code 3");
  db.withConn(conn => {
    startRun(conn, { id: "run-recovered", projectId, taskId: "bootstrap-recovered", kind: "bootstrap", worker: "fixture", startedAt: "2026-11-05T07:03:00Z" });
    finishRun(conn, "run-recovered", { outcome: "success", finishedAt: "2026-11-05T07:04:00Z", durationMs: 60000 });
  });
  expect((await get(`/projects/${projectId}`)).task_diagnostic).toBeUndefined();
});

test("no workspace or cross-project directory means no file-based diagnostic", async () => {
  errorEvent();
  const noWorkspace = createApi({ db });
  const response = await noWorkspace.handle(new Request(`http://cairn.test/projects/${projectId}`));
  expect((await response.json() as any).task_diagnostic).toBeUndefined();
  const records = [{ task_id: "../bootstrap-test", detail: null, finished_at: null, outcome: null }];
  expect(attachRunDiagnostics(records, root, projectId)[0]!.diagnostic).toBeUndefined();
  expect(attachRunDiagnostics([{ ...records[0]!, task_id: taskId }], root, "proj_other")[0]!.diagnostic).toBeUndefined();
});
