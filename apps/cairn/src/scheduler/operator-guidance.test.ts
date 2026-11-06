import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerTask } from "@cairn/contracts";
import { configureDatabase, createHint, createIntent, createProject, getProjectDetail, listProjectRuns,
  markOperatorHint, recordStrategistSuccess, type CairnDatabase } from "@cairn/graph";
import { parseDispatchConfig } from "../config";
import type { RuntimeBackend, WorkerProcess } from "../runtime/types";
import { Scheduler } from "./loop";

let directory: string;
let db: CairnDatabase;
let projectId: string;
let loop: Scheduler;
let workers: Array<{ task: WorkerTask; finish: (code?: number) => void }>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-guidance-scheduler-"));
  db = configureDatabase(join(directory, "db.sqlite")); workers = [];
  projectId = db.withConn(conn => {
    const id = createProject(conn, { title: "guidance", origin: "start", goal: "goal", hints: null,
      bootstrap_enabled: false, scope: { targets: ["127.0.0.1:8080"] } }).project.id;
    recordStrategistSuccess(conn, { projectId: id, runId: "seed", trigger: "initial", factCount: 2, hintCount: 0,
      openIntentCount: 0, at: new Date(Date.now() - 60000).toISOString() });
    return id;
  });
  const runtime: RuntimeBackend = {
    execution: "local", ensureProject: () => true, mapPath: path => path, mapPathIfUnderWorkspace: path => path,
    cleanupInactive() {}, close() {},
    spawnWorker(options): WorkerProcess {
      const task = JSON.parse(readFileSync(options.workerTaskPath, "utf8")) as WorkerTask;
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>(resolve => { resolveExit = resolve; });
      const finish = (code = 0) => {
        if (code === 0) writeFileSync(task.resultPath, JSON.stringify({ accepted: true,
          data: task.kind === "explore" ? { description: "fixture observed result" } : {} }));
        resolveExit(code);
      };
      workers.push({ task, finish });
      return { exited, stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }), terminate: () => finish(143), kill: () => finish(137) };
    },
  };
  const config = parseDispatchConfig({ server: "http://127.0.0.1:8000",
    runtime: { execution: "local", max_workers: 2, max_running_projects: 1, max_project_workers: 2,
      interval: 1, healthcheck_timeout: 5, worker_healthcheck: "disabled", prompt_group: "default" },
    tasks: { bootstrap: { timeout: 30, conclude_timeout: 10 }, reason: { timeout: 30 }, explore: { timeout: 30, conclude_timeout: 10 } },
    observer: { enabled: false }, strategist: { cooldown_seconds: 30, max_runs_per_hour: 1 } });
  loop = new Scheduler({ db, config, runtime, workspaceRoot: join(directory, "workspace"), log: () => {} });
});
afterEach(async () => { await loop.stop(); rmSync(directory, { recursive: true, force: true }); });
function hint(content: string) {
  return db.withConn(conn => {
    const item = createHint(conn, projectId, { content, creator: "operator" });
    markOperatorHint(conn, projectId, item.id); return item.id;
  });
}
function intent(description: string) {
  db.withConn(conn => createIntent(conn, projectId, { from: ["origin"], description, creator: "fixture", worker: null }));
}
const hints = () => db.withConn(conn => getProjectDetail(conn, projectId).hints);

test("guidance arriving during reason survives acknowledgement and immediately triggers the next reason", async () => {
  db.withConn(conn => createIntent(conn, projectId, { from: ["origin"], description: "held direction", creator: "peer", worker: "peer" }));
  const first = hint("first direction");
  expect(loop.tick()).toBe(true);
  expect(workers[0]!.task.kind).toBe("reason");
  expect(workers[0]!.task.prompt).toContain("first direction");
  const second = hint("new direction while planning");
  expect(workers[0]!.task.prompt).not.toContain("new direction while planning");
  workers[0]!.finish(); await loop.waitForIdle();
  expect(hints().find(item => item.id === first)?.operator_guidance).toBe("planned");
  expect(hints().find(item => item.id === second)?.operator_guidance).toBe("pending");
  expect(loop.tick()).toBe(true); // Bypasses both the 30s cooldown and the hourly cap.
  expect(workers[1]!.task.prompt).toContain("new direction while planning");
  workers[1]!.finish(); await loop.waitForIdle();
  expect(hints().every(item => item.operator_guidance === "planned")).toBe(true);
  expect(loop.tick()).toBe(false);
  expect(db.withConn(conn => listProjectRuns(conn, projectId)).map(run => run.trigger))
    .toEqual(["operator_guidance", "operator_guidance"]);
});

test("does not refill explore slots while waiting for current work to finish", async () => {
  intent("current direction");
  expect(loop.tick()).toBe(true);
  expect(workers[0]!.task.kind).toBe("explore");
  intent("old queued direction"); hint("pivot to user direction");
  expect(loop.tick()).toBe(false);
  expect(workers).toHaveLength(1);
  workers[0]!.finish(); await loop.waitForIdle();
  expect(loop.tick()).toBe(true);
  expect(workers[1]!.task.kind).toBe("reason");
  workers[1]!.finish(); await loop.waitForIdle();
});

test("failed reason leaves guidance pending and respects failure backoff", async () => {
  hint("must survive failure");
  expect(loop.tick()).toBe(true);
  workers[0]!.finish(3); await loop.waitForIdle();
  expect(hints()[0]?.operator_guidance).toBe("pending");
  expect(loop.tick()).toBe(false);
  expect(workers).toHaveLength(1);
});

test("stopped projects never dispatch and cancellation never acknowledges guidance", async () => {
  hint("pending at cancellation"); expect(loop.tick()).toBe(true);
  db.withConn(conn => conn.query("UPDATE projects SET status = 'stopped' WHERE id = ?").run(projectId));
  expect(loop.tick()).toBe(false); await loop.waitForIdle();
  expect(hints()[0]?.operator_guidance).toBe("pending");
  expect(workers).toHaveLength(1);
});
