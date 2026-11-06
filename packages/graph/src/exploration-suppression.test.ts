import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experiment } from "../../contracts/src/testdata/experiment";
import { seedExperimentScenario, EXPERIMENT_SCOPE } from "./testdata/experiment-scenario";
import { acceptTaskCheckpoint, buildExplorationSuppression, buildTaskContextSnapshot, configureDatabase,
  finalizeCheckpointRun, finishRun, listProjectRuns, registerCheckpointRun, startRun, type CairnDatabase } from "./index";
let dir: string, db: CairnDatabase, scene: ReturnType<typeof seedExperimentScenario>;
const at = (minute: number) => `2026-11-06T00:${String(minute).padStart(2, "0")}:00.000Z`;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soft-exploration-")); db = configureDatabase(join(dir, "db.sqlite"));
  scene = db.withConn(conn => seedExperimentScenario(conn));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function fixture(repeats = 3) {
  return db.withConn(conn => {
    for (let n = 1; n <= repeats; n++) {
      const id = `repeat-${n}`;
      startRun(conn, { id, projectId: scene.projectId, taskId: id, intentId: scene.intentId, kind: "explore", worker: "fixture", startedAt: at(n) });
      registerCheckpointRun(conn, id, EXPERIMENT_SCOPE, experiment());
      expect(acceptTaskCheckpoint(conn, { runId: id, projectId: scene.projectId, taskId: id,
        bytes: Buffer.from(JSON.stringify({ ...scene.checkpoint, task_id: id })) })).toBe("accepted");
      finishRun(conn, id, { outcome: "success", durationMs: 1, finishedAt: at(n + 1) }); finalizeCheckpointRun(conn, id, "finished");
    }
    return { snapshot: buildTaskContextSnapshot(conn, scene.projectId, { checkpoint: {
      scopeTargets: EXPERIMENT_SCOPE, evidenceStatus: () => "available",
    } }), runs: listProjectRuns(conn, scene.projectId) };
  });
}
function decision(value: ReturnType<typeof fixture>, minute = 5, enabled = true) {
  return buildExplorationSuppression(value.snapshot, value.runs, { enabled, now: new Date(at(minute)) }).get(scene.intentId)!;
}
test("M52c is opt-in and clamps effective priority within a fixed bounded window", () => {
  const value = fixture();
  expect(decision(value, 5, false)).toMatchObject({ state: "off", penalty: 0, effective_priority: 50 });
  expect(decision(value)).toMatchObject({ state: "reduced", penalty: 20, base_priority: 50, effective_priority: 30,
    window_started_at: at(4), until: at(9), semantics: "priority_preview_not_dispatch_authorization" });
  expect(decision(value, 9)).toMatchObject({ state: "inactive", reason: "window_expired", effective_priority: 50 });
  value.snapshot.intents[0]!.priority = 5;
  expect(decision(value)).toMatchObject({ penalty: 5, effective_priority: 0 });
});
test("M52c cannot roll its window forward by repeating or renaming the same input", () => {
  const value = fixture(7);
  expect(decision(value, 8).until).toBe(at(9));
  expect(decision(value, 9).reason).toBe("window_expired");
  const duplicate = structuredClone(value.snapshot.intents[0]!);
  duplicate.id = "another-direction"; duplicate.description = "renamed"; duplicate.priority = 90;
  value.snapshot.intents.push(duplicate);
  const peer = buildExplorationSuppression(value.snapshot, value.runs, { enabled: true, now: new Date(at(9)) }).get(duplicate.id)!;
  expect(peer).toMatchObject({ reason: "window_expired", effective_priority: 90 });
});
test("M52c does not activate before the threshold", () => {
  expect(decision(fixture(2))).toMatchObject({ penalty: 0, reason: "below_threshold_or_new_input" });
});
test("M52c new facts and hints restart eligibility independently of report counters", () => {
  const value = fixture();
  value.snapshot.facts.push({ ...value.snapshot.facts[0]!, id: "new-fact", created_at: at(3) });
  expect(value.snapshot.intents[0]!.exploration!.consecutive_without_new_observation).toBe(3);
  expect(decision(value).penalty).toBe(0);
  value.snapshot.facts.pop();
  value.snapshot.hints.push({ id: "h1", content: "new input", creator: "operator", created_at: at(3), operator_guidance: "pending" });
  expect(decision(value)).toMatchObject({ reason: "project_or_operator_gate", penalty: 0 });
  value.snapshot.hints[0]!.operator_guidance = "planned";
  expect(decision(value).penalty).toBe(0);
  value.snapshot.hints[0]!.created_at = "unknown";
  expect(decision(value).reason).toBe("progress_time_unknown");
});
test("M52c new input can establish a fresh window only after three later comparable completions", () => {
  const value = fixture(7);
  value.snapshot.facts.push({ ...value.snapshot.facts[0]!, id: "new-fact", created_at: at(3) });
  // repeat-3 starts at the input boundary and cannot establish post-input eligibility.
  value.runs = value.runs.filter(run => run.id !== "repeat-7");
  value.snapshot.attempts = value.snapshot.attempts.filter(attempt => attempt.run_id !== "repeat-7");
  expect(decision(value, 7)).toMatchObject({ penalty: 20, window_started_at: at(7), until: at(12) });
  value.runs = value.runs.filter(run => run.id !== "repeat-6");
  value.snapshot.attempts = value.snapshot.attempts.filter(attempt => attempt.run_id !== "repeat-6");
  expect(decision(value, 6).penalty).toBe(0);
});
test("M52c faults never advance the threshold and latest faults or unknowns are exempt", () => {
  const value = fixture();
  const third = value.snapshot.attempts.find(attempt => attempt.run_id === "repeat-3")!;
  third.exploration!.status = "operationally_incomplete";
  expect(decision(value)).toMatchObject({ penalty: 0, reason: "latest_not_comparable" });
  third.exploration!.status = "unknown";
  expect(decision(value).penalty).toBe(0);
  third.exploration!.status = "repeated_observation";
  value.snapshot.attempts.find(attempt => attempt.run_id === "repeat-2")!.exploration!.status = "operationally_incomplete";
  expect(decision(value).penalty).toBe(0);
});
test("M52c new observations and unknown gaps reset eligibility, but explanations cannot masquerade as progress", () => {
  const value = fixture();
  const second = value.snapshot.attempts.find(attempt => attempt.run_id === "repeat-2")!;
  for (const status of ["new_observation", "unknown"] as const) {
    second.exploration!.status = status; expect(decision(value).penalty).toBe(0);
  }
  for (const status of ["interpretation_only", "no_observation"] as const) {
    second.exploration!.status = status; expect(decision(value).penalty).toBe(20);
  }
});
test("M52c invalid time, missing inputs, claimed and inactive directions cannot be downgraded", () => {
  const value = fixture();
  const original = structuredClone(value);
  value.runs[0]!.finished_at = null;
  expect(decision(value).penalty).toBe(0);
  value.runs = original.runs; value.runs[0]!.finished_at = at(30);
  expect(decision(value).penalty).toBe(0);
  value.runs = original.runs;
  value.snapshot.intents[0]!.worker = "another-worker";
  expect(decision(value).reason).toBe("not_unclaimed_open");
  value.snapshot.intents[0]!.worker = null;
  value.snapshot.project.status = "stopped";
  expect(decision(value).penalty).toBe(0);
  value.snapshot.project.status = "active";
  value.snapshot.intents[0]!.exploration!.plan_fingerprint = null;
  expect(decision(value).reason).toBe("plan_unknown");
});
test("M52c evaluates deterministically without mutating history, metadata, or report counters", () => {
  const value = fixture(), before = structuredClone(value);
  const first = decision(value); expect(decision(value)).toEqual(first);
  expect(value).toEqual(before);
  db = configureDatabase(db.path);
  const again = db.withConn(conn => ({ snapshot: buildTaskContextSnapshot(conn, scene.projectId, { checkpoint: {
    scopeTargets: EXPERIMENT_SCOPE, evidenceStatus: () => "available",
  } }), runs: listProjectRuns(conn, scene.projectId) }));
  expect(decision(again)).toEqual(first);
});
