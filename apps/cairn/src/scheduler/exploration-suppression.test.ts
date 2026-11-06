import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptTaskCheckpoint, configureDatabase, createHint, createIntent, finishRun, finalizeCheckpointRun,
  getIntentMeta, listProjectRuns, markOperatorHint, recordInfrastructureFailure, recordIntentMeta, registerCheckpointRun,
  startRun, type CairnDatabase } from "@cairn/graph";
import { seedExperimentScenario, EXPERIMENT_SCOPE, EXPERIMENT_EVIDENCE } from "../../../../packages/graph/src/testdata/experiment-scenario";
import { experiment } from "../../../../packages/contracts/src/testdata/experiment";
import { parseDispatchConfig } from "../config";
import { Scheduler } from "./loop";
let dir: string, db: CairnDatabase, scene: ReturnType<typeof seedExperimentScenario>;
const at = (minute: number) => `2026-11-06T00:${String(minute).padStart(2, "0")}:00Z`;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exploration-scheduler-")); db = configureDatabase(join(dir, "db.sqlite"));
  scene = db.withConn(conn => {
    const seeded = seedExperimentScenario(conn);
    recordIntentMeta(conn, { projectId: seeded.projectId, intentId: seeded.intentId, priority: 60 });
    for (let n = 1; n <= 3; n++) {
      const id = `repeat-${n}`;
      startRun(conn, { id, projectId: seeded.projectId, intentId: seeded.intentId, taskId: id, kind: "explore", worker: "fixture", startedAt: at(n) });
      registerCheckpointRun(conn, id, EXPERIMENT_SCOPE, experiment());
      acceptTaskCheckpoint(conn, { runId: id, projectId: seeded.projectId, taskId: id, bytes: Buffer.from(JSON.stringify({ ...seeded.checkpoint, task_id: id })) });
      finishRun(conn, id, { outcome: "success", durationMs: 1, finishedAt: at(n + 1) }); finalizeCheckpointRun(conn, id, "finished");
    }
    return seeded;
  });
  mkdirSync(join(dir, scene.projectId, "evidence"), { recursive: true });
  writeFileSync(join(dir, scene.projectId, EXPERIMENT_EVIDENCE), "offline fixture");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const alternative = () => db.withConn(conn => {
  const intent = createIntent(conn, scene.projectId, { from: ["origin"], description: "different input, no repetition history", creator: "fixture", worker: null });
  recordIntentMeta(conn, { projectId: scene.projectId, intentId: intent.id, priority: 50 }); return intent.id;
});
async function dispatch(enabled?: boolean, minute = 5) {
  const loop = new Scheduler({ db, workspaceRoot: dir, log: () => {}, now: () => new Date(at(minute)), leaseIntervalMs: 500,
    config: parseDispatchConfig({ server: "http://127.0.0.1:8000", runtime: { execution: "local", max_workers: 1, max_running_projects: 1,
      max_project_workers: 1, interval: 1, healthcheck_timeout: 5, worker_healthcheck: "disabled", prompt_group: "default" },
      tasks: { bootstrap: { timeout: 30, conclude_timeout: 5 }, reason: { timeout: 30 }, explore: { timeout: 30, conclude_timeout: 5 },
        ...(enabled === undefined ? {} : { exploration_suppression: { enabled } }) }, observer: { enabled: false },
      strategist: { cooldown_seconds: 0, max_runs_per_hour: 0, zero_output_threshold: 0 }, local: { completed_action: "keep" } }),
    workerArgv: taskPath => [process.execPath, join(import.meta.dir, "testdata", "experiment-review-worker.ts"), taskPath, scene.runId],
  });
  loop.tick(); await loop.waitForIdle();
  return db.withConn(conn => listProjectRuns(conn, scene.projectId).filter(run => run.worker !== "fixture"));
}
test("M52c default-off retains base priority", async () => {
  alternative(); expect((await dispatch())[0]?.intent_id).toBe(scene.intentId);
}, 30000);
test("M52c explicit soft preference lets a genuinely different input run first without rewriting metadata", async () => {
  const other = alternative(); expect((await dispatch(true))[0]?.intent_id).toBe(other);
  expect(db.withConn(conn => getIntentMeta(conn, scene.projectId, scene.intentId))).toMatchObject({ priority: 60, status: "open" });
}, 30000);
test("M52c never idles when the repeated direction is the only authorized candidate", async () => {
  expect((await dispatch(true))[0]?.intent_id).toBe(scene.intentId);
}, 30000);
test("M52c bounded expiry restores original selection without a timer or rolling extension", async () => {
  alternative(); expect((await dispatch(true, 9))[0]?.intent_id).toBe(scene.intentId);
}, 30000);
test("M52c missing evidence conservatively restores base priority", async () => {
  alternative(); rmSync(join(dir, scene.projectId, EXPERIMENT_EVIDENCE));
  expect((await dispatch(true))[0]?.intent_id).toBe(scene.intentId);
}, 30000);
test("M52c cannot bypass the infrastructure circuit or operator guidance priority", async () => {
  alternative();
  db.withConn(conn => recordInfrastructureFailure(conn, { projectId: scene.projectId, code: "model_auth_error", at: at(5) }));
  expect(await dispatch(true)).toHaveLength(0);
}, 30000);
test("M52c operator guidance still gets reason before autonomous explores", async () => {
  alternative();
  db.withConn(conn => { const hint = createHint(conn, scene.projectId, { content: "先看用户指定条件", creator: "operator" }); markOperatorHint(conn, scene.projectId, hint.id); });
  expect((await dispatch(true))[0]?.kind).toBe("reason");
}, 30000);
