import { checkpoint } from "../../../../packages/contracts/src/testdata/checkpoint";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDatabase, createProject, listProjectRuns, getProjectDetail, buildTaskContextSnapshot, startRun, registerCheckpointRun, acceptTaskCheckpoint, type CairnDatabase } from "@cairn/graph";
import { parseDispatchConfig } from "../config";
import { LocalRuntime } from "../runtime/local";
import { Scheduler } from "./loop";
let dir: string; let db: CairnDatabase; let projectId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "checkpoint-scheduler-")); db = configureDatabase(join(dir, "db.sqlite"));
  projectId = db.withConn((conn) => createProject(conn, { title: "checkpoint", origin: "loopback lab", goal: "objective", hints: null,
    bootstrap_enabled: false, scope: { targets: ["127.0.0.1:8080"] } }).project.id);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function setup(mode: string, enabled = true) {
  const config = parseDispatchConfig({ server: "http://127.0.0.1:8000", runtime: { execution: "local", interval: 1,
    max_workers: 1, max_running_projects: 1, healthcheck_timeout: 5, max_project_workers: 1, worker_healthcheck: "disabled", prompt_group: "default" },
    tasks: { bootstrap: { timeout: 10, conclude_timeout: 5 }, reason: { timeout: mode === "timeout" ? 1 : 15 },
      explore: { timeout: 10, conclude_timeout: 5 }, checkpoint: { enabled, interval_seconds: 1 } },
    worker: { retain_task_files: false }, observer: { enabled: false } });
  const logs: string[] = [];
  const runtime = new LocalRuntime({ local: config.local, log: () => {}, workerArgv: (path) =>
    [process.execPath, join(import.meta.dir, "testdata", "checkpoint-worker.ts"), path, mode] });
  const scheduler = new Scheduler({ db, config, runtime, workspaceRoot: join(dir, "workspace"), log: (line) => logs.push(line) });
  return { scheduler, config, logs };
}
const row = () => db.withConn((conn) => conn.query("SELECT sequence, payload, termination_reason FROM task_checkpoints").get()) as { sequence: number; payload: string | null; termination_reason: string | null } | null;
async function waitForAccepted(): Promise<void> {
  for (let n = 0; n < 100; n++) { if ((row()?.sequence ?? 0) > 0) return; await Bun.sleep(25); }
  throw new Error("periodic checkpoint not ingested while worker alive");
}
describe("M49 actual child-process acceptance", () => {
  test("periodically ingests while running, cancellation retains progress and survives session deletion", async () => {
    const { scheduler } = setup("cancel");
    try {
      expect(scheduler.tick()).toBe(true); await waitForAccepted();
      expect(db.withConn((conn) => listProjectRuns(conn, projectId))[0]?.outcome).toBeNull();
      expect(row()?.termination_reason).toBeNull();
    } finally { await scheduler.stop(); }
    expect(row()?.termination_reason).toBe("cancelled");
    const run = db.withConn((conn) => listProjectRuns(conn, projectId))[0]!;
    expect(run.outcome).toBe("cancelled"); expect(existsSync(join(dir, "workspace", projectId, run.session!))).toBe(false);
    const snapshot = db.withConn((conn) => buildTaskContextSnapshot(conn, projectId, { checkpoint: {} }));
    expect(snapshot.attempts[0]?.memory?.checkpoint.attempts[0]?.result).toBe("environment_failure");
  });
  for (const mode of ["success", "crash", "timeout", "partial"]) {
    test(`${mode} keeps the last valid progress without closing the project`, async () => {
      const { scheduler } = setup(mode);
      try { expect(scheduler.tick()).toBe(true); await scheduler.waitForIdle(); }
      finally { await scheduler.stop(); }
      expect(row()?.sequence).toBeGreaterThan(0);
      expect(db.withConn((conn) => listProjectRuns(conn, projectId))[0]?.outcome).toBe(mode === "success" ? "success" : "failed");
      expect(row()?.termination_reason).toBe(mode === "success" ? "finished" : mode === "timeout" ? "hard_deadline" : "worker_exit");
      expect(JSON.parse(row()!.payload!).attempts[0].result).toBe("environment_failure");
      expect(db.withConn((conn) => getProjectDetail(conn, projectId)).project.status).toBe("active");
      expect(existsSync(join(dir, "workspace", projectId, "DO_NOT_EXECUTE_SUGGESTION"))).toBe(false);
    }, 20000);
  }
  test("startup recovers a newer complete orphan file and freezes the control-plane restart reason", async () => {
    const taskId = "reason-0123456789ab";
    const session = join(dir, "workspace", projectId, ".cairn", "sessions", taskId);
    mkdirSync(session, { recursive: true });
    const value = checkpoint({ project_id: projectId, task_id: taskId, intent_id: null });
    db.withConn((conn) => {
      startRun(conn, { id: "orphan", projectId, taskId, kind: "reason", worker: "old", startedAt: "2026-11-05T00:00:00Z" });
      registerCheckpointRun(conn, "orphan", ["127.0.0.1:8080"]);
      acceptTaskCheckpoint(conn, { runId: "orphan", projectId, taskId, bytes: Buffer.from(JSON.stringify(value)) });
    });
    writeFileSync(join(session, "checkpoint.json"), JSON.stringify({ ...value, sequence: 3 }));
    const { scheduler } = setup("success");
    try { scheduler.start(); }
    finally { await scheduler.stop(); }
    const saved = db.withConn((conn) => conn.query("SELECT sequence, termination_reason FROM task_checkpoints WHERE run_id='orphan'").get());
    expect(saved).toEqual({ sequence: 3, termination_reason: "control_plane_restart" });
    expect(db.withConn((conn) => listProjectRuns(conn, projectId)).find((r) => r.id === "orphan")?.outcome).toBe("inactive");
  });
  test("checkpoint sidecar unavailability cannot turn a valid task into a dispatch failure", async () => {
    db.withConn((conn) => conn.exec("DROP TABLE task_checkpoints"));
    const { scheduler, logs } = setup("success");
    try { expect(scheduler.tick()).toBe(true); await scheduler.waitForIdle(); }
    finally { await scheduler.stop(); }
    expect(db.withConn((conn) => listProjectRuns(conn, projectId))[0]?.outcome).toBe("success");
    expect(logs).toContain("checkpoint registration unavailable; dispatch continues");
    expect(logs.some((line) => line.includes("no such table"))).toBe(false);
  });
  test("off leaves no checkpoint sidecar rows and unchanged successful worker behavior", async () => {
    const { scheduler, logs } = setup("success", false);
    try { expect(scheduler.tick()).toBe(true); await scheduler.waitForIdle(); }
    finally { await scheduler.stop(); }
    expect(row()).toBeNull(); expect({ logs, outcome: db.withConn((conn) => listProjectRuns(conn, projectId))[0]?.outcome }).toMatchObject({ outcome: "success" });
  });
});
