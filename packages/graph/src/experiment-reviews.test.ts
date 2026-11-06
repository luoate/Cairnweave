import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experiment } from "../../contracts/src/testdata/experiment";
import { review } from "../../contracts/src/testdata/experiment-review";
import { buildAgentContext, buildExperimentReviewBasis, buildTaskContextSnapshot, configureDatabase, createIntent,
  experimentReviewError, exportProjectYaml, getIntentMeta, recordIntentMeta, renderAgentContextYaml, type CairnDatabase,
  type TaskContextSnapshot } from "./index";
import { EXPERIMENT_SCOPE, seedExperimentScenario } from "./testdata/experiment-scenario";
let dir: string, db: CairnDatabase, scene: ReturnType<typeof seedExperimentScenario>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "experiment-review-")); db = configureDatabase(join(dir, "db.sqlite"));
  scene = db.withConn(conn => seedExperimentScenario(conn));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const snapshot = () => db.withConn(conn => buildTaskContextSnapshot(conn, scene.projectId, {
  checkpoint: { scopeTargets: EXPERIMENT_SCOPE, evidenceStatus: () => "available" },
}));
const decision = () => review({ source_intent_id: scene.intentId,
  observations: [{ run_id: scene.runId, checkpoint_sequence: 1, attempt_id: "a1" }] });
const check = (current: TaskContextSnapshot, before = snapshot()) =>
  experimentReviewError(decision(), buildExperimentReviewBasis(before), buildExperimentReviewBasis(current));
test("links available observations from the same plan in both snapshots, never a hypothesis verdict", () => {
  const full = snapshot(); expect(check(full)).toBeNull();
  expect(full.attempts[0]?.memory?.experiment_plan).toEqual(experiment());
  expect(full.attempts[0]?.memory?.experiment_result?.hypothesis_verdict).toBe("unknown");
  const basis = buildExperimentReviewBasis(full);
  expect(experimentReviewError({ ...decision(), choice: "continue" }, basis, basis)).toBeNull();
  expect(experimentReviewError(review({ source_intent_id: scene.intentId, choice: "need_observation", observations: [] }), basis, basis)).toBeNull();
});
test("requires actual pack authorization and rejects invented, cross-project and stale references", () => {
  const basis = buildExperimentReviewBasis(snapshot());
  expect(experimentReviewError(decision(), undefined, basis)).toContain("not authorized");
  for (const invalid of [review(), { ...decision(), source_intent_id: "other" },
    { ...decision(), observations: [{ ...decision().observations[0]!, run_id: "other-project-run" }] },
    { ...decision(), observations: [{ ...decision().observations[0]!, checkpoint_sequence: 2 }] },
    { ...decision(), observations: [{ ...decision().observations[0]!, attempt_id: "interpretation-only" }] },
  ]) expect(experimentReviewError(invalid, basis, basis)).not.toBeNull();
  const changed = snapshot(); changed.intents[0]!.experiment = experiment({ hypothesis: "changed" });
  expect(check(changed)).toContain("stale");
});
test("incomplete runs, missing evidence, changed Scope, old plans and non-current facts cannot steer a decision", () => {
  const mutations: Array<(full: TaskContextSnapshot) => void> = [
    full => { full.attempts[0]!.memory!.control.outcome = "failed"; },
    full => { full.attempts[0]!.memory!.control.failure = { domain: "infrastructure", code: "model_timeout" }; },
    full => { full.attempts[0]!.failure = { domain: "execution", code: "hard_deadline" }; },
    full => { full.attempts[0]!.memory!.control.termination_reason = "cancelled"; },
    full => { full.attempts[0]!.memory!.reuse.scope_status = "changed_requires_authorization"; },
    full => { full.attempts[0]!.memory!.reuse.facts[0]!.status = "superseded"; },
    full => { full.attempts[0]!.memory!.experiment_result!.observations[0]!.evidence = "missing"; },
    full => { delete full.attempts[0]!.memory!.experiment_plan; },
    full => { full.attempts[0]!.memory!.experiment_plan = experiment({ action: "different" }); },
    full => { full.attempts[0]!.memory!.sequence = 2; },
  ];
  for (const mutate of mutations) { const current = snapshot(); mutate(current); expect(check(current)).not.toBeNull(); }
});
test("actual projections reject empty observations and tool errors despite nonempty interpretations", () => {
  for (const options of [{ observation: " " }, { result: "tool_failure" as const },
    { outcome: "failed" as const, failure: { domain: "infrastructure" as const, code: "model_connection_error" as const } }]) {
    const other = db.withConn(conn => seedExperimentScenario(conn, options));
    const full = db.withConn(conn => buildTaskContextSnapshot(conn, other.projectId, { checkpoint: {
      scopeTargets: EXPERIMENT_SCOPE, evidenceStatus: () => "available",
    } }));
    expect(buildExperimentReviewBasis(full).sources[0]!.observations).toEqual([]);
  }
});
test("persists review provenance, survives upserts/reopen, and keeps graph YAML unchanged", () => {
  db.withConn(conn => {
    const before = exportProjectYaml(conn, scene.projectId);
    recordIntentMeta(conn, { projectId: scene.projectId, intentId: scene.intentId, experimentReview: decision() });
    recordIntentMeta(conn, { projectId: scene.projectId, intentId: scene.intentId, priority: 70 });
    expect(getIntentMeta(conn, scene.projectId, scene.intentId)?.experiment_review).toEqual(decision());
    const context = buildAgentContext(conn, scene.projectId, { kind: "reason" });
    expect(renderAgentContextYaml(context)).toContain("experiment_review_not_evidence");
    expect(buildTaskContextSnapshot(conn, scene.projectId).intents[0]?.experiment_review).toEqual(decision());
    expect(exportProjectYaml(conn, scene.projectId)).toBe(before);
  });
  db = configureDatabase(db.path);
  db.withConn(conn => {
    expect(getIntentMeta(conn, scene.projectId, scene.intentId)?.experiment_review).toEqual(decision());
    conn.query("UPDATE intent_meta SET experiment_review = ? WHERE project_id = ?").run("{", scene.projectId);
    expect(getIntentMeta(conn, scene.projectId, scene.intentId)).not.toHaveProperty("experiment_review");
    const legacy = createIntent(conn, scene.projectId, { from: ["origin"], description: "legacy", creator: "test", worker: null });
    recordIntentMeta(conn, { projectId: scene.projectId, intentId: legacy.id });
    expect(getIntentMeta(conn, scene.projectId, legacy.id)).not.toHaveProperty("experiment_review");
  });
});
