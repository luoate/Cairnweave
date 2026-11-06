import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDatabase, createProject, finishRun, getInfrastructureFault, recordInfrastructureFailure, startRun,
  type CairnDatabase } from "@cairn/graph";
import { createApi, type Api } from "./api";

let directory: string, projectId: string, db: CairnDatabase, api: Api;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-infrastructure-"));
  db = configureDatabase(join(directory, "db.sqlite"));
  projectId = db.withConn(conn => createProject(conn, { title: "lab", origin: "start", goal: "goal", hints: null,
    bootstrap_enabled: false, scope: { targets: ["127.0.0.1:8080"] } }).project.id);
  api = createApi({ db });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const get = async (suffix = "") => (await api.handle(new Request(`http://cairn.test/projects/${projectId}${suffix}`))).json() as Promise<any>;
const status = (value: string) => api.handle(new Request(`http://cairn.test/projects/${projectId}/status`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: value }) }));
const fault = () => db.withConn(conn => getInfrastructureFault(conn, projectId));
function block() {
  db.withConn(conn => recordInfrastructureFailure(conn, { projectId, code: "model_auth_error", at: new Date().toISOString() }));
}

test("read APIs expose authoritative failure routing without adding null fields to unaffected projects", async () => {
  expect(await get()).not.toHaveProperty("infrastructure_fault");
  block();
  const detail = await get();
  expect(detail.infrastructure_fault).toMatchObject({ code: "model_auth_error", state: "blocked", consecutive_failures: 1, retry_after: null });
  expect(detail.project.status).toBe("active"); // Circuit is independent of user/project status.
  db.withConn(conn => {
    startRun(conn, { id: "r1", projectId, taskId: "t1", kind: "reason", worker: "fixture", startedAt: new Date().toISOString() });
    finishRun(conn, "r1", { outcome: "failed", finishedAt: new Date().toISOString(), durationMs: 1,
      failure: { domain: "infrastructure", code: "model_auth_error" } });
  });
  expect((await get("/runs"))[0].failure).toEqual({ domain: "infrastructure", code: "model_auth_error" });
});

test("only an actual stopped -> active transition clears the circuit; active PUT and hints cannot", async () => {
  block(); const original = fault()!.id;
  expect((await status("active")).status).toBe(200); expect(fault()?.id).toBe(original);
  expect((await api.handle(new Request(`http://cairn.test/projects/${projectId}/hints`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "retry now", creator: "operator" }) }))).status).toBe(201);
  expect(fault()?.id).toBe(original);
  expect((await status("stopped")).status).toBe(200); expect(fault()?.id).toBe(original);
  expect((await status("active")).status).toBe(200); expect(fault()).toBeNull();
  expect((await get()).hints[0].operator_guidance).toBe("pending");
});

test("completed projects cannot use status updates to bypass the circuit", async () => {
  block(); db.withConn(conn => conn.query("UPDATE projects SET status = 'completed' WHERE id = ?").run(projectId));
  expect((await status("active")).status).toBe(409); expect(fault()?.state).toBe("blocked");
});
