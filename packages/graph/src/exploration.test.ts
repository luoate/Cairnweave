import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointAttempt } from "@cairn/contracts";
import { experiment } from "../../contracts/src/testdata/experiment";
import { review } from "../../contracts/src/testdata/experiment-review";
import { acceptTaskCheckpoint, buildTaskContextSnapshot, configureDatabase, createIntent, exportProjectYaml,
  explorationPlanFingerprint, finishRun, finalizeCheckpointRun, recordIntentMeta, registerCheckpointRun,
  startRun, projectExploration, type CairnDatabase, type RunFailure } from "./index";
import { EXPERIMENT_SCOPE, seedExperimentScenario } from "./testdata/experiment-scenario";
let dir: string, db: CairnDatabase, scene: ReturnType<typeof seedExperimentScenario>, ordinal: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exploration-")); db = configureDatabase(join(dir, "db.sqlite"));
  scene = db.withConn(conn => seedExperimentScenario(conn)); ordinal = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const snapshot = () => db.withConn(conn => buildTaskContextSnapshot(conn, scene.projectId, {
  checkpoint: { scopeTargets: EXPERIMENT_SCOPE, evidenceStatus: () => "available" },
}));
function addRun(options: { intentId?: string; patches?: Partial<CheckpointAttempt>; failure?: RunFailure;
  outcome?: "success" | "failed"; checkpoint?: boolean; termination?: "finished" | "cancelled";
  bound?: boolean; finishMinute?: number; sequence?: number } = {}) {
  const number = ++ordinal, runId = `r-${String(number).padStart(3, "0")}`, taskId = `task-${number}`;
  const intentId = options.intentId ?? scene.intentId;
  db.withConn(conn => {
    startRun(conn, { id: runId, projectId: scene.projectId, taskId, intentId, kind: "explore", worker: "fixture",
      startedAt: `2026-11-06T00:${String(number + 1).padStart(2, "0")}:00Z` });
    registerCheckpointRun(conn, runId, EXPERIMENT_SCOPE, options.bound === false ? undefined : experiment());
    if (options.checkpoint !== false) expect(acceptTaskCheckpoint(conn, { runId, projectId: scene.projectId, taskId,
      bytes: Buffer.from(JSON.stringify({ ...scene.checkpoint, task_id: taskId, intent_id: intentId, sequence: options.sequence ?? 1,
        attempts: [{ ...scene.checkpoint.attempts[0]!, ...options.patches }] })),
    })).toBe("accepted");
    finishRun(conn, runId, { outcome: options.outcome ?? "success", durationMs: 1,
      finishedAt: `2026-11-06T01:${String(options.finishMinute ?? number).padStart(2, "0")}:00Z`,
      ...(options.failure === undefined ? {} : { failure: options.failure }) });
    finalizeCheckpointRun(conn, runId, options.termination ?? "finished");
  });
  return runId;
}
const progress = (id: string) => snapshot().attempts.find(attempt => attempt.run_id === id)!.exploration!;
const summary = () => snapshot().intents.find(intent => intent.id === scene.intentId)!.exploration!;

test("M52a canonical fingerprints ignore only cosmetic boundaries and set ordering", () => {
  const fingerprint = (p = experiment(), projectId = "p", scope = ["b", "a"], from = ["f2", "f1"]) =>
    explorationPlanFingerprint(projectId, scope, from, p);
  const original = fingerprint(); expect(original).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(experiment(), "p", ["a", "b", "a"], ["f1", "f2"])).toBe(original);
  expect(fingerprint(experiment({ action: ` \r\n${experiment().action}\r\n ` }))).toBe(original);
  for (const field of ["hypothesis", "action", "expected_signal", "evidence_required", "stop_condition"] as const) {
    expect(fingerprint(experiment({ [field]: experiment()[field] + " different" }))).not.toBe(original);
  }
  expect(fingerprint(experiment(), "other")).not.toBe(original);
  expect(fingerprint(experiment(), "p", ["other"])).not.toBe(original);
  expect(fingerprint(experiment(), "p", ["a", "b"], ["other"])).not.toBe(original);
  expect(fingerprint(experiment({ action: "GET /A" }))).not.toBe(fingerprint(experiment({ action: "get /A" })));
  expect(fingerprint(experiment({ action: "x  y" }))).not.toBe(fingerprint(experiment({ action: "x y" })));
  expect(explorationPlanFingerprint("p", undefined, [], experiment())).toBeNull();
  expect(explorationPlanFingerprint("p", [], [], experiment())).toBeNull();
});
test("M52a renamed directions are recognized without overwriting or deduplicating them", () => {
  const ids = db.withConn(conn => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const intent = createIntent(conn, scene.projectId, { from: ["origin"], description: `renamed ${i}`, creator: "fixture", worker: null });
      recordIntentMeta(conn, { projectId: scene.projectId, intentId: intent.id, dedupeKey: `different-${i}`,
        priority: i, experiment: experiment(), ...(i === 10 ? { experimentReview: review() } : {}) });
      ids.push(intent.id);
    }
    return ids;
  });
  const full = snapshot(), source = full.intents.find(intent => intent.id === scene.intentId)!.exploration!;
  expect(source.same_plan).toMatchObject({ count: 11, omitted: 3 }); expect(source.same_plan.intent_ids).toHaveLength(8);
  expect(source.same_proposal.count).toBe(10);
  expect(full.intents.find(intent => intent.id === ids[10])!.exploration!.plan_fingerprint).toBe(source.plan_fingerprint);
  expect(full.intents.find(intent => intent.id === ids[10])!.exploration!.proposal_fingerprint).not.toBe(source.proposal_fingerprint);
  expect(full.intents).toHaveLength(12); // Observe, never dedupe or retire.
  expect(full.intents.every(intent => intent.status === "open")).toBe(true);
});
test("M52a proposal identity includes source and exact reference versions, not choice or rationale", () => {
  const ref = { run_id: scene.runId, checkpoint_sequence: 1, attempt_id: "a1" };
  const ids = db.withConn(conn => [
    review({ source_intent_id: scene.intentId, observations: [ref] }),
    review({ source_intent_id: scene.intentId, observations: [ref], choice: "continue", rationale: "different words" }),
    review({ source_intent_id: "other", observations: [ref] }),
    review({ source_intent_id: scene.intentId, observations: [{ ...ref, checkpoint_sequence: 2 }] }),
  ].map(experimentReview => {
    const intent = createIntent(conn, scene.projectId, { from: ["origin"], description: "linked", creator: "fixture", worker: null });
    recordIntentMeta(conn, { projectId: scene.projectId, intentId: intent.id, experiment: experiment(), experimentReview });
    return intent.id;
  }));
  const full = snapshot(), keys = ids.map(id => full.intents.find(intent => intent.id === id)!.exploration!.proposal_fingerprint);
  expect(keys[0]).toBe(keys[1]); expect(keys[0]).not.toBe(keys[2]); expect(keys[0]).not.toBe(keys[3]);
});
test("M52b separates new observations, repeated reports, explanations and empty reports", () => {
  expect(progress(scene.runId)).toMatchObject({ status: "new_observation", observations: { new: 1, repeated: 0 }, consecutive_without_new_observation: 0 });
  const repeated = addRun({ patches: { id: "renamed-attempt", interpretation: "new explanation", evidence_refs: ["evidence/new-name.txt"] }, sequence: 7 });
  expect(progress(repeated)).toMatchObject({ status: "repeated_observation", observations: { new: 0, repeated: 1 }, consecutive_without_new_observation: 1 });
  const interpreted = addRun({ patches: { observation: " ", interpretation: "only inference" } });
  expect(progress(interpreted)).toMatchObject({ status: "interpretation_only", consecutive_without_new_observation: 2 });
  const empty = addRun({ patches: { observation: "", interpretation: "", result: "inconclusive" } });
  expect(progress(empty)).toMatchObject({ status: "no_observation", consecutive_without_new_observation: 3 });
  const novel = addRun({ patches: { observation: "a genuinely different report" } });
  expect(progress(novel)).toMatchObject({ status: "new_observation", consecutive_without_new_observation: 0 });
  expect(summary().counts).toEqual({ new_observation: 2, repeated_observation: 1, interpretation_only: 1,
    no_observation: 1, operationally_incomplete: 0, unknown: 0 });
  expect(summary().hypothesis_verdict).toBe("unknown");
});
test("M52b authoritative and worker-reported operational failures never increment the streak", () => {
  addRun();
  for (const failure of [{ domain: "infrastructure", code: "model_timeout" },
    { domain: "execution", code: "hard_deadline" }] as const) {
    const id = addRun({ failure, outcome: "failed" });
    expect(progress(id)).toMatchObject({ status: "operationally_incomplete", consecutive_without_new_observation: 1 });
    expect(summary().advisory).toBe("need_observation");
  }
  for (const result of ["tool_failure", "environment_failure", "timeout", "cancelled", "scope_denied", "not_executed"] as const) {
    expect(progress(addRun({ patches: { result } }))).toMatchObject({ status: "operationally_incomplete", consecutive_without_new_observation: 1 });
  }
  expect(progress(addRun({ termination: "cancelled" })).status).toBe("operationally_incomplete");
  expect(summary().counts.operationally_incomplete).toBe(9);
});
test("M52b unknown gaps break continuity and never seed the observation comparison set", () => {
  addRun(); expect(summary().consecutive_without_new_observation).toBe(1);
  const gap = addRun({ checkpoint: false });
  expect(progress(gap)).toMatchObject({ status: "unknown", reason: "checkpoint_missing", consecutive_without_new_observation: null });
  expect(progress(addRun())).toMatchObject({ status: "repeated_observation", consecutive_without_new_observation: 1 });
  const unbound = addRun({ bound: false, patches: { observation: "new but unbound" } });
  expect(progress(unbound)).toMatchObject({ status: "unknown", reason: "dispatch_plan_missing" });
  expect(progress(addRun({ patches: { observation: "new but unbound" } })).status).toBe("new_observation");
});
test("M52b Scope, facts, evidence, plan and checkpoint identity are re-evaluated, never guessed", () => {
  const id = addRun();
  const mutations = [
    ["scope_targets", '["different"]', "scope_changed_or_unknown"],
    ["experiment_plan", JSON.stringify(experiment({ action: "new plan" })), "dispatch_plan_changed"],
    ["termination_reason", null, "termination_unknown"],
    ["sequence", 9, "checkpoint_identity_mismatch"],
  ] as const;
  for (const [column, value, reason] of mutations) {
    const old = db.withConn(conn => {
      const row = conn.query(`SELECT ${column} AS value FROM task_checkpoints WHERE run_id = ?`).get(id) as { value: string | number | null };
      conn.query(`UPDATE task_checkpoints SET ${column} = ? WHERE run_id = ?`).run(value, id);
      return row.value;
    });
    expect(progress(id)).toMatchObject({ status: "unknown", reason });
    db.withConn(conn => conn.query(`UPDATE task_checkpoints SET ${column} = ? WHERE run_id = ?`).run(old, id));
  }
  const missing = db.withConn(conn => buildTaskContextSnapshot(conn, scene.projectId, { checkpoint: {
    scopeTargets: EXPERIMENT_SCOPE, evidenceStatus: () => "missing",
  } }));
  expect(missing.attempts.find(attempt => attempt.run_id === id)!.exploration).toMatchObject({ status: "unknown", reason: "observation_evidence_unavailable" });
  expect(progress(addRun({ patches: { result: "inconclusive" } })).status).toBe("unknown");
  expect(progress(addRun({ patches: { evidence_refs: [] } })).status).toBe("unknown");
});
test("M52b uses completion ordering and shares observation comparison across same-plan directions", () => {
  const other = db.withConn(conn => {
    const intent = createIntent(conn, scene.projectId, { from: ["origin"], description: "another label", creator: "fixture", worker: null });
    recordIntentMeta(conn, { projectId: scene.projectId, intentId: intent.id, experiment: experiment() }); return intent.id;
  });
  const later = addRun({ intentId: other, finishMinute: 20, patches: { observation: "same new report" } });
  const earlier = addRun({ finishMinute: 10, patches: { observation: "same new report" } });
  expect(progress(earlier).status).toBe("new_observation"); expect(progress(later).status).toBe("repeated_observation");
  expect(summary().latest?.run_id).toBe(later);
});
test("M52b completion ties are stable and unorderable history conservatively breaks continuity", () => {
  const first = addRun({ finishMinute: 10 }), second = addRun({ finishMinute: 10 });
  expect(progress(first).consecutive_without_new_observation).toBe(1);
  expect(progress(second).consecutive_without_new_observation).toBe(2);
  const base = snapshot();
  const times = new Map([[first, "2026-11-06T01:10:00Z"], [second, "2026-11-06T01:10:00Z"]]);
  const a = projectExploration(base, EXPERIMENT_SCOPE, times);
  const b = projectExploration({ ...base, attempts: [...base.attempts].reverse() }, EXPERIMENT_SCOPE, times);
  expect(a.intents).toEqual(b.intents);
  expect(a.intents[0]!.exploration).toMatchObject({ consecutive_without_new_observation: null,
    latest: { run_id: scene.runId, status: "unknown" }, advisory: "need_observation" });
});

test("M52b counts finished runs, not checkpoint saves or duplicate report IDs within one run", () => {
  const runId = "versions", taskId = "versions-task";
  db.withConn(conn => {
    startRun(conn, { id: runId, projectId: scene.projectId, intentId: scene.intentId, taskId, kind: "explore", worker: "fixture", startedAt: "2026-11-06T00:02:00Z" });
    registerCheckpointRun(conn, runId, EXPERIMENT_SCOPE, experiment());
    const value = { ...scene.checkpoint, task_id: taskId };
    expect(acceptTaskCheckpoint(conn, { runId, projectId: scene.projectId, taskId, bytes: Buffer.from(JSON.stringify(value)) })).toBe("accepted");
    expect(buildTaskContextSnapshot(conn, scene.projectId, { checkpoint: {} }).attempts.some(item => item.run_id === runId)).toBe(false);
    const last = { ...value, sequence: 2, attempts: [value.attempts[0]!, { ...value.attempts[0]!, id: "different-id" }] };
    expect(acceptTaskCheckpoint(conn, { runId, projectId: scene.projectId, taskId, bytes: Buffer.from(JSON.stringify(last)) })).toBe("accepted");
    expect(acceptTaskCheckpoint(conn, { runId, projectId: scene.projectId, taskId, bytes: Buffer.from(JSON.stringify(last)) })).toBe("duplicate");
    expect(acceptTaskCheckpoint(conn, { runId, projectId: scene.projectId, taskId, bytes: Buffer.from(JSON.stringify({ ...last, sequence: 3, version: 999 })) })).toBe("invalid");
    finishRun(conn, runId, { outcome: "success", durationMs: 1, finishedAt: "2026-11-06T01:01:00Z" });
    finalizeCheckpointRun(conn, runId, "finished");
  });
  expect(progress(runId)).toMatchObject({ checkpoint_sequence: 2, status: "repeated_observation", observations: { new: 0, repeated: 1 }, consecutive_without_new_observation: 1 });
  expect(summary().counts.repeated_observation).toBe(1);
});
test("M52b new action or negative result is a new report, never a hypothesis verdict", () => {
  expect(progress(addRun({ patches: { action: "different action" } })).status).toBe("new_observation");
  const negative = addRun({ patches: { result: "negative_observation" } });
  expect(progress(negative)).toMatchObject({ status: "new_observation", hypothesis_verdict: "unknown" });
  expect(progress(addRun({ patches: { observation: ` \r\n${scene.checkpoint.attempts[0]!.observation}\r\n` } })).status).toBe("repeated_observation");
});
test("M52b refuses missing or superseded input facts even if no checkpoint attempt cites them", () => {
  const base = snapshot();
  for (const status of ["missing", "superseded"] as const) {
    const changed = structuredClone(base);
    changed.intents[0]!.from = ["unreported-input"];
    if (status === "superseded") changed.facts.push({ ...changed.facts[0]!, id: "unreported-input", status: "superseded" });
    const view = projectExploration(changed, EXPERIMENT_SCOPE, new Map([[scene.runId, "2026-11-06T00:01:00Z"]]));
    expect(view.attempts[0]!.exploration).toMatchObject({ status: "unknown", reason: "fact_changed_or_missing" });
  }
  for (const field of ["project_id", "intent_id"] as const) {
    const changed = structuredClone(base);
    changed.attempts[0]!.memory!.checkpoint[field] = "wrong-owner";
    expect(projectExploration(changed, EXPERIMENT_SCOPE, new Map([[scene.runId, "2026-11-06T00:01:00Z"]])).attempts[0]!.exploration?.status).toBe("unknown");
  }
});

test("M52 read model is durable, read-only, project-isolated and absent from legacy/default projections", () => {
  addRun();
  const full = snapshot();
  db = configureDatabase(db.path); expect(snapshot()).toEqual(full);
  db.withConn(conn => {
    const before = exportProjectYaml(conn, scene.projectId);
    const changes = conn.query("SELECT total_changes() AS n").get();
    buildTaskContextSnapshot(conn, scene.projectId, { checkpoint: { scopeTargets: EXPERIMENT_SCOPE, evidenceStatus: () => "available" } });
    expect(conn.query("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(exportProjectYaml(conn, scene.projectId)).toBe(before);
    const plain = buildTaskContextSnapshot(conn, scene.projectId);
    expect(plain.intents.every(intent => intent.exploration === undefined)).toBe(true);
    expect(plain.attempts.every(attempt => attempt.exploration === undefined)).toBe(true);
    const other = seedExperimentScenario(conn);
    const isolated = buildTaskContextSnapshot(conn, other.projectId, { checkpoint: { scopeTargets: EXPERIMENT_SCOPE, evidenceStatus: () => "available" } });
    expect(isolated.intents[0]!.exploration!.same_plan.count).toBe(0);
    expect(isolated.intents[0]!.exploration!.counts.new_observation).toBe(1);
    const legacy = createIntent(conn, scene.projectId, { from: ["origin"], description: "legacy", creator: "fixture", worker: null });
    expect(buildTaskContextSnapshot(conn, scene.projectId, { checkpoint: {} }).intents.find(intent => intent.id === legacy.id)).not.toHaveProperty("exploration");
  });
});
