import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDatabase, concludeIntent, createIntent, getProjectDetail, listProjectIntentMeta, listProjectRuns,
  requestStrategistReplan, setProjectScope, type CairnDatabase } from "@cairn/graph";
import { EXPERIMENT_EVIDENCE, seedExperimentScenario } from "../../../../packages/graph/src/testdata/experiment-scenario";
import { parseDispatchConfig } from "../config";
import { Scheduler } from "./loop";
let dir: string, db: CairnDatabase, scene: ReturnType<typeof seedExperimentScenario>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "experiment-scheduler-")); db = configureDatabase(join(dir, "db.sqlite"));
  scene = db.withConn(conn => {
    const seeded = seedExperimentScenario(conn);
    for (let i = 0; i < 40; i++) {
      const intent = createIntent(conn, seeded.projectId, { from: ["origin"], description: `history ${i}`, creator: "fixture", worker: null });
      concludeIntent(conn, seeded.projectId, intent.id, "fixture", `客观历史 ${i} ${"重复可恢复文本 ".repeat(60)}`);
    }
    requestStrategistReplan(conn, seeded.projectId, { reason: "review observation", requestedBy: "test" });
    return seeded;
  });
  mkdirSync(join(dir, scene.projectId, "evidence"), { recursive: true });
  writeFileSync(join(dir, scene.projectId, EXPERIMENT_EVIDENCE), "local fixture response");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const metadata = () => db.withConn(conn => listProjectIntentMeta(conn, scene.projectId));
const runs = () => db.withConn(conn => listProjectRuns(conn, scene.projectId));
function scheduler(mode = "continue", packMode = "apply", beforeSpawn?: () => void, maxBytes = 131072) {
  return new Scheduler({ db, workspaceRoot: dir, log: () => {}, leaseIntervalMs: 500,
    config: parseDispatchConfig({ server: "http://127.0.0.1:8000", runtime: { execution: "local", max_workers: 1,
      max_running_projects: 1, max_project_workers: 1, interval: 1, healthcheck_timeout: 5,
      worker_healthcheck: "disabled", prompt_group: "default" },
      tasks: { bootstrap: { timeout: 30, conclude_timeout: 5 }, reason: { timeout: 30, max_intents: 3 },
        explore: { timeout: 30, conclude_timeout: 5 }, checkpoint: { enabled: true },
        context_pack: { mode: packMode }, context_plan: { max_initial_bytes: maxBytes } },
      observer: { enabled: false }, local: { completed_action: "keep" },
      strategist: { cooldown_seconds: 0, max_runs_per_hour: 0, zero_output_threshold: 0 } }),
    workerArgv: taskPath => {
      beforeSpawn?.();
      return [process.execPath, join(import.meta.dir, "testdata", "experiment-review-worker.ts"), taskPath, scene.runId, mode];
    },
  });
}
test("reason recovery -> linked follow-up -> next explore carries the plan and decision, preserving authority", async () => {
  const loop = scheduler("change_direction"); loop.tick(); await loop.waitForIdle();
  const followup = metadata().find(meta => meta.experiment_review !== undefined)!;
  expect(followup).toBeDefined();
  expect(followup.experiment_review).toMatchObject({ source_intent_id: scene.intentId, choice: "change_direction",
    observations: [{ run_id: scene.runId, checkpoint_sequence: 1, attempt_id: "a1" }] });
  expect(followup.origin_run_id).toBe(runs().find(run => run.kind === "reason")!.id);
  expect(metadata().find(meta => meta.intent_id === scene.intentId)?.status).toBe("open");
  loop.tick(); await loop.waitForIdle();
  const dispatched = runs().find(run => run.kind === "explore" && run.intent_id === followup.intent_id)!;
  const task = JSON.parse(readFileSync(join(dir, scene.projectId, dispatched.session!, "task.json"), "utf8"));
  expect(task.prompt).toContain(JSON.stringify(followup.experiment_review));
  expect(task.prompt).toContain("下一次对照 {max_intents} 是否可复现");
  expect(task.scope.targets).toEqual(["127.0.0.1:8080"]); expect(task.hardDeadlineSeconds).toBe(30);
  expect(task).not.toHaveProperty("experiment_review");
  expect(db.withConn(conn => conn.query("SELECT experiment_plan FROM task_checkpoints WHERE run_id = ?").get(dispatched.id) as any).experiment_plan)
    .toBe(JSON.stringify(followup.experiment));
}, 30000);
test("invalid observation references roll back the whole reason batch without a partial intent", async () => {
  const count = db.withConn(conn => getProjectDetail(conn, scene.projectId).intents.length);
  const loop = scheduler("invalid-ref"); loop.tick(); await loop.waitForIdle();
  expect(db.withConn(conn => getProjectDetail(conn, scene.projectId).intents.length)).toBe(count);
  expect(metadata()).toHaveLength(1);
  expect(runs().find(run => run.kind === "reason")?.outcome).toBe("failed");
}, 30000);
test("current Scope and evidence are rechecked after the authorized dispatch snapshot", async () => {
  for (const mutate of [() => rmSync(join(dir, scene.projectId, EXPERIMENT_EVIDENCE)),
    () => db.withConn(conn => setProjectScope(conn, scene.projectId, { targets: ["127.0.0.1:9090"] }))]) {
    const loop = scheduler("continue", "apply", mutate); loop.tick(); await loop.waitForIdle();
    expect(metadata().some(meta => meta.experiment_review !== undefined)).toBe(false);
    expect(runs().filter(run => run.kind === "reason").every(run => run.outcome === "failed")).toBe(true);
    writeFileSync(join(dir, scene.projectId, EXPERIMENT_EVIDENCE), "fixture");
    db.withConn(conn => requestStrategistReplan(conn, scene.projectId, { reason: "another case", requestedBy: "test" }));
  }
}, 30000);
test("pack off, shadow and budget fallback cannot authorize checkpoint-based decisions", async () => {
  for (const [mode, bytes] of [["off", 131072], ["shadow", 131072], ["apply", 1]] as const) {
    const loop = scheduler("continue", mode, undefined, bytes); loop.tick(); await loop.waitForIdle();
    expect(metadata()).toHaveLength(1);
    expect(runs().filter(run => run.kind === "reason").every(run => run.outcome === "failed")).toBe(true);
    db.withConn(conn => requestStrategistReplan(conn, scene.projectId, { reason: "another mode", requestedBy: "test" }));
  }
}, 30000);
test("deduplicated follow-ups keep their original plan and review provenance", async () => {
  const first = scheduler("change_direction"); first.tick(); await first.waitForIdle();
  const original = metadata().find(meta => meta.experiment_review !== undefined)!;
  expect(original).toBeDefined();
  db.withConn(conn => requestStrategistReplan(conn, scene.projectId, { reason: "repeat proposal", requestedBy: "test" }));
  const second = scheduler("need_observation"); second.tick(); await second.waitForIdle();
  expect(runs().filter(run => run.kind === "reason")).toHaveLength(2);
  expect(runs().filter(run => run.kind === "reason").every(run => run.outcome === "success")).toBe(true);
  expect(metadata()).toHaveLength(2);
  expect(metadata().find(meta => meta.intent_id === original.intent_id)).toEqual(original);
}, 30000);
test("missing observations may produce an explicitly unknown follow-up, never retire the source", async () => {
  db.withConn(conn => conn.query("UPDATE task_checkpoints SET experiment_plan = NULL WHERE run_id = ?").run(scene.runId));
  const loop = scheduler("need_observation"); loop.tick(); await loop.waitForIdle();
  expect(metadata().find(meta => meta.experiment_review)?.experiment_review).toMatchObject({ choice: "need_observation", observations: [] });
  expect(metadata().find(meta => meta.intent_id === scene.intentId)?.status).toBe("open");
}, 30000);
