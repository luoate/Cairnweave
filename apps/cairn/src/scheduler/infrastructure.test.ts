import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerTask } from "@cairn/contracts";
import { configureDatabase, createHint, createIntent, createProject, getInfrastructureFault, getPendingConclude,
  getProjectDetail, getStrategistState, listProjectRuns, listRecentStrategistRuns, markOperatorHint,
  recordStrategistSuccess, type CairnDatabase } from "@cairn/graph";
import { parseDispatchConfig } from "../config";
import type { RuntimeBackend, WorkerProcess } from "../runtime/types";
import { Scheduler } from "./loop";

let directory: string, projectId: string, db: CairnDatabase, loop: Scheduler, runtime: RuntimeBackend;
let workers: Array<{ task: WorkerTask; finish: (options?: { error?: string; work?: boolean; unknown?: boolean; code?: number; invalid?: boolean }) => void }>;
let now: number;
let spawnFails: boolean, ready: boolean;
const config = () => parseDispatchConfig({ server: "http://127.0.0.1:8000",
  runtime: { execution: "local", max_workers: 3, max_running_projects: 2, max_project_workers: 3,
    interval: 1, healthcheck_timeout: 5, worker_healthcheck: "disabled", prompt_group: "default" },
  tasks: { bootstrap: { timeout: 300, conclude_timeout: 60 }, reason: { timeout: 300 }, explore: { timeout: 300, conclude_timeout: 60 } },
  worker: { retain_task_files: false }, observer: { enabled: false } });
const makeLoop = () => new Scheduler({ db, config: config(), runtime, workspaceRoot: join(directory, "workspace"),
  now: () => new Date(now), log: () => {} });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-infrastructure-"));
  db = configureDatabase(join(directory, "db.sqlite")); now = Date.now(); workers = []; spawnFails = false; ready = true;
  projectId = db.withConn(conn => createProject(conn, { title: "lab", origin: "start", goal: "goal", hints: null,
    bootstrap_enabled: false, scope: { targets: ["127.0.0.1:8080"] } }).project.id);
  runtime = { execution: "local", ensureProject: () => ready, mapPath: path => path, mapPathIfUnderWorkspace: path => path,
    cleanupInactive() {}, close() {}, spawnWorker(options): WorkerProcess {
      if (spawnFails) throw new Error("fixture-secret spawn failed");
      const task = JSON.parse(readFileSync(options.workerTaskPath, "utf8")) as WorkerTask;
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>(resolve => { resolveExit = resolve; });
      const finish = (input: { error?: string; work?: boolean; unknown?: boolean; code?: number; invalid?: boolean } = {}) => {
        if (input.error !== undefined || input.work) {
          const root = join(task.sessionDir, "solver-session"); mkdirSync(root, { recursive: true });
          const events = [];
          if (input.work) events.push({ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "observation" }] } });
          if (input.error !== undefined) events.push({ type: "message", timestamp: new Date(now).toISOString(),
            message: { role: "assistant", stopReason: "error", errorMessage: input.error + " fixture-secret" } });
          writeFileSync(join(root, "session.jsonl"), (input.unknown ? "x".repeat(150000) + "\n" : "") + events.map(event => JSON.stringify(event)).join("\n") + "\n");
        }
        const code = input.code ?? (input.error === undefined ? 0 : 3);
        if (code === 0) writeFileSync(task.resultPath, input.invalid ? "{broken" : JSON.stringify({ accepted: true,
          data: task.kind === "reason" ? {} : { description: "fixture observed result" } }));
        resolveExit(code);
      };
      workers.push({ task, finish });
      return { exited, stdout: new ReadableStream({ start(c) { c.close(); } }), stderr: new ReadableStream({ start(c) { c.close(); } }),
        terminate: () => finish({ code: 143 }), kill: () => finish({ code: 137 }) };
    } };
  loop = makeLoop();
});
afterEach(async () => { await loop.stop(); rmSync(directory, { recursive: true, force: true }); });
const fault = () => db.withConn(conn => getInfrastructureFault(conn, projectId));
const pending = () => db.withConn(conn => getPendingConclude(conn, projectId));
const runs = () => db.withConn(conn => listProjectRuns(conn, projectId));
function direction(description = "check login") {
  return db.withConn(conn => {
    const intent = createIntent(conn, projectId, { from: ["origin"], description, creator: "fixture", worker: null });
    recordStrategistSuccess(conn, { projectId, runId: "seed", trigger: "initial", factCount: 2, hintCount: 0,
      openIntentCount: 1, at: new Date(now).toISOString() }); return intent;
  });
}

for (const kind of ["bootstrap", "explore"] as const) test(`pure ${kind} model failures neither conclude nor refute the intent`, async () => {
  if (kind === "bootstrap") db.withConn(conn => conn.query("UPDATE projects SET bootstrap_enabled = 1 WHERE id = ?").run(projectId));
  else direction();
  expect(loop.tick()).toBe(true); expect(workers[0]!.task.kind).toBe(kind);
  workers[0]!.finish({ error: "Connection error" }); await loop.waitForIdle();
  expect(pending()).toBeNull();
  expect(runs()[0]?.failure).toEqual({ domain: "infrastructure", code: "model_connection_error" });
  expect(JSON.stringify(runs())).not.toContain("fixture-secret");
  expect(db.withConn(conn => getProjectDetail(conn, projectId).facts)).toHaveLength(2);
  expect(db.withConn(conn => getProjectDetail(conn, projectId).intents[0])).toMatchObject({ to: null, worker: null });
  expect(db.withConn(conn => listRecentStrategistRuns(conn, projectId, 10))).toHaveLength(0);
  expect(existsSync(workers[0]!.task.sessionDir)).toBe(false);
  expect(loop.tick()).toBe(false); now += 31000;
  expect(loop.tick()).toBe(true); expect(workers[1]!.task.kind).toBe(kind);
});

test("backoff survives scheduler restart; retries are single-flight and third failure blocks", async () => {
  direction();
  expect(loop.tick()).toBe(true);
  workers[0]!.finish({ error: "Connection error" }); await loop.waitForIdle();
  direction("second direction");
  await loop.stop(); db = configureDatabase(join(directory, "db.sqlite")); loop = makeLoop();
  expect(loop.tick()).toBe(false); now += 31000;
  expect(loop.tick()).toBe(true); expect(loop.tick()).toBe(false); expect(workers).toHaveLength(2);
  workers[1]!.finish({ error: "request timed out" }); await loop.waitForIdle();
  expect(fault()?.consecutive_failures).toBe(2); now += 61000;
  expect(loop.tick()).toBe(true); workers[2]!.finish({ error: "429 rate limit" }); await loop.waitForIdle();
  expect(fault()).toMatchObject({ state: "blocked", consecutive_failures: 3 });
  now += 3600000; expect(loop.tick()).toBe(false); expect(workers).toHaveLength(3);
});

test("a successful recovery clears the circuit, while failed operator reason stays pending", async () => {
  direction();
  db.withConn(conn => { const hint = createHint(conn, projectId, { content: "switch direction", creator: "operator" }); markOperatorHint(conn, projectId, hint.id); });
  expect(loop.tick()).toBe(true); expect(workers[0]!.task.kind).toBe("reason");
  workers[0]!.finish({ error: "Connection error" }); await loop.waitForIdle();
  expect(db.withConn(conn => getStrategistState(conn, projectId)?.last_failure_at)).toBeNull();
  expect(db.withConn(conn => getProjectDetail(conn, projectId).hints[0]?.operator_guidance)).toBe("pending");
  expect(loop.tick()).toBe(false); now += 31000;
  expect(loop.tick()).toBe(true); expect(workers[1]!.task.kind).toBe("reason");
  workers[1]!.finish(); await loop.waitForIdle(); expect(fault()).toBeNull();
  expect(db.withConn(conn => getProjectDetail(conn, projectId).hints[0]?.operator_guidance)).toBe("planned");
});

test("authentication blocks immediately without confirming guidance", async () => {
  expect(loop.tick()).toBe(true);
  workers[0]!.finish({ error: "401 invalid api key" }); await loop.waitForIdle();
  expect(fault()).toMatchObject({ state: "blocked", code: "model_auth_error", consecutive_failures: 1 });
  now += 3600000; expect(loop.tick()).toBe(false);
});

test("partial work survives infrastructure failures, including a failing conclude, then salvages", async () => {
  direction(); expect(loop.tick()).toBe(true);
  workers[0]!.finish({ error: "Connection error", work: true }); await loop.waitForIdle();
  expect(pending()).not.toBeNull(); expect(existsSync(workers[0]!.task.sessionDir)).toBe(true);
  expect(loop.tick()).toBe(false); now += 31000;
  expect(loop.tick()).toBe(true); expect(workers[1]!.task.kind).toBe("conclude");
  workers[1]!.finish({ error: "Connection error" }); await loop.waitForIdle();
  expect(pending()).not.toBeNull(); expect(existsSync(workers[0]!.task.sessionDir)).toBe(true);
  now += 61000; expect(loop.tick()).toBe(true); expect(workers[2]!.task.kind).toBe("conclude");
  workers[2]!.finish(); await loop.waitForIdle();
  expect(pending()).toBeNull(); expect(fault()).toBeNull();
  expect(db.withConn(conn => getProjectDetail(conn, projectId).facts)).toHaveLength(3);
  expect(existsSync(workers[0]!.task.sessionDir)).toBe(false);
});

test("bounded/incomplete histories are never treated as proof that no work happened", async () => {
  direction(); expect(loop.tick()).toBe(true);
  workers[0]!.finish({ error: "Connection error", unknown: true }); await loop.waitForIdle();
  expect(pending()).not.toBeNull(); expect(fault()?.state).toBe("backoff");
});

test("protocol errors stay execution errors, without creating a model circuit", async () => {
  direction(); expect(loop.tick()).toBe(true); workers[0]!.finish({ invalid: true }); await loop.waitForIdle();
  expect(runs()[0]?.failure).toEqual({ domain: "execution", code: "result_invalid" });
  expect(fault()).toBeNull(); expect(pending()).toBeNull();
});

test("cancellation wins over a worker-reported authentication error", async () => {
  direction(); expect(loop.tick()).toBe(true);
  db.withConn(conn => conn.query("UPDATE projects SET status = 'stopped' WHERE id = ?").run(projectId));
  loop.tick(); workers[0]!.finish({ error: "401 invalid api key" }); await loop.waitForIdle();
  expect(runs()[0]?.outcome).toBe("cancelled"); expect(runs()[0]).not.toHaveProperty("failure");
  expect(fault()).toBeNull(); expect(pending()).toBeNull();
});

test("runtime readiness and spawn failures back off durably without leaking raw errors", async () => {
  ready = false; expect(loop.tick()).toBe(false);
  expect(fault()).toMatchObject({ code: "runtime_unavailable", state: "backoff" });
  expect(runs()).toHaveLength(0); expect(loop.tick()).toBe(false);
  now += 31000; ready = true; spawnFails = true;
  expect(loop.tick()).toBe(false);
  expect(runs()[0]?.failure).toEqual({ domain: "infrastructure", code: "worker_spawn_failed" });
  expect(runs()[0]?.detail).not.toContain("fixture-secret");
  expect(fault()?.consecutive_failures).toBe(2); expect(loop.tick()).toBe(false);
});
