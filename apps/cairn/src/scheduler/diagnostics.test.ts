import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDatabase, createIntent, createProject, getInfrastructureFault, getPendingConclude, listProjectRuns } from "@cairn/graph";
import { parseDispatchConfig } from "../config";
import { LocalRuntime } from "../runtime/local";
import { persistedModelDiagnostic } from "../solver/diagnostics";
import { Scheduler } from "./loop";

for (const mode of ["failure", "timeout"]) {
  test(`scheduler persists safe ${mode} diagnostics before retention cleanup`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-scheduler-diagnostic-"));
    const db = configureDatabase(join(root, "cairn.db"));
    const projectId = db.withConn(conn => createProject(conn, { title: "diagnostic", origin: "lab", goal: "goal",
      bootstrap_enabled: false, hints: null, scope: { targets: ["127.0.0.1:8080"] } }).project.id);
    const config = parseDispatchConfig({ server: "http://127.0.0.1:8000",
      runtime: { execution: "local", interval: 1, max_workers: 1, max_running_projects: 1,
        max_project_workers: 1, healthcheck_timeout: 5, worker_healthcheck: "disabled", prompt_group: "default" },
      tasks: { bootstrap: { timeout: 10, conclude_timeout: 5 }, reason: { timeout: mode === "timeout" ? 1 : 10 },
        explore: { timeout: 10, conclude_timeout: 5 } }, worker: { retain_task_files: false }, observer: { enabled: false } });
    const runtime = new LocalRuntime({ local: config.local, log: () => {}, workerArgv: path =>
      [process.execPath, join(import.meta.dir, "testdata", "diagnostic-worker.ts"), path, mode] });
    const scheduler = new Scheduler({ db, config, runtime, workspaceRoot: join(root, "workspace"), log: () => {} });
    try {
      expect(scheduler.tick()).toBe(true);
      await scheduler.waitForIdle();
      const run = db.withConn(conn => listProjectRuns(conn, projectId))[0]!;
      expect(run.outcome).toBe("failed");
      expect(run.detail).not.toContain("fixture-secret");
      if (mode === "failure") expect(persistedModelDiagnostic(run.detail, run.finished_at)?.code).toBe("model_connection_error");
      else {
        expect(run.detail).toBe("任务达到硬截止时间，worker 已被终止");
        expect(run.failure).toEqual({ domain: "execution", code: "hard_deadline" });
        expect(db.withConn(conn => getInfrastructureFault(conn, projectId))).toBeNull();
      }
      expect(existsSync(join(root, "workspace", projectId, run.session!))).toBe(false);
    } finally {
      await scheduler.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
}

for (const kind of ["bootstrap", "explore"] as const) test(`local ${kind} pure model failure does not spawn conclude`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cairn-local-infrastructure-"));
  const db = configureDatabase(join(root, "cairn.db"));
  const projectId = db.withConn(conn => {
    const id = createProject(conn, { title: "offline lab", origin: "lab", goal: "goal", bootstrap_enabled: kind === "bootstrap",
      hints: null, scope: { targets: ["127.0.0.1:8080"] } }).project.id;
    if (kind === "explore") createIntent(conn, id, { from: ["origin"], description: "check lab", creator: "fixture", worker: null });
    return id;
  });
  const config = parseDispatchConfig({ server: "http://127.0.0.1:8000",
    runtime: { execution: "local", interval: 1, max_workers: 1, max_running_projects: 1,
      max_project_workers: 1, healthcheck_timeout: 5, worker_healthcheck: "disabled", prompt_group: "default" },
    tasks: { bootstrap: { timeout: 10, conclude_timeout: 5 }, reason: { timeout: 10 }, explore: { timeout: 10, conclude_timeout: 5 } },
    worker: { retain_task_files: false }, observer: { enabled: false } });
  const runtime = new LocalRuntime({ local: config.local, log: () => {}, workerArgv: path =>
    [process.execPath, join(import.meta.dir, "testdata", "diagnostic-worker.ts"), path, "failure"] });
  const scheduler = new Scheduler({ db, config, runtime, workspaceRoot: join(root, "workspace"), log: () => {} });
  try {
    expect(scheduler.tick()).toBe(true);
    await scheduler.waitForIdle();
    const runs = db.withConn(conn => listProjectRuns(conn, projectId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind, outcome: "failed", failure: { domain: "infrastructure", code: "model_connection_error" } });
    expect(db.withConn(conn => getPendingConclude(conn, projectId))).toBeNull();
    expect(scheduler.tick()).toBe(false);
  } finally {
    await scheduler.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
