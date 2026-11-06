import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDatabase, createProject, createIntent, startRun, finishRun, buildTaskContextSnapshot, getProjectDetail, type CairnDatabase } from "./index";
import { acceptTaskCheckpoint, attachAttemptMemories, finalizeCheckpointRun, registerCheckpointRun } from "./checkpoints";
import { checkpoint } from "../../contracts/src/testdata/checkpoint";
let db: CairnDatabase; let dir: string; let projectId: string; let intentId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-graph-")); db = configureDatabase(join(dir, "db.sqlite"));
  db.withConn((conn) => {
    projectId = createProject(conn, { title: "memory", origin: "origin", goal: "goal", hints: null, bootstrap_enabled: false, scope: { targets: ["127.0.0.1:8080"] } }).project.id;
    intentId = createIntent(conn, projectId, { from: ["origin"], description: "explore", creator: "test", worker: null }).id;
    startRun(conn, { id: "r1", projectId, taskId: "explore-test", intentId, kind: "explore", worker: "test", startedAt: "2026-11-05T00:00:00Z" });
    registerCheckpointRun(conn, "r1", ["127.0.0.1:8080"]);
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function payload(sequence = 1) { return checkpoint({ project_id: projectId, task_id: "explore-test", intent_id: intentId, sequence }); }
function accept(value = payload()) { return db.withConn((conn) => acceptTaskCheckpoint(conn, {
  runId: "r1", projectId, taskId: "explore-test", bytes: Buffer.from(JSON.stringify(value)),
})); }
function finish() { db.withConn((conn) => finishRun(conn, "r1", { outcome: "failed", finishedAt: "2026-11-05T00:01:00Z", durationMs: 60000, detail: "deadline, not hypothesis refutation" })); }
describe("M49 durable checkpoint sidecar", () => {
  test("monotonic replacements, same-version replay and conflict detection", () => {
    expect(accept()).toBe("accepted"); expect(accept()).toBe("duplicate");
    const reordered = Object.fromEntries(Object.entries(payload()).reverse());
    expect(accept(reordered as ReturnType<typeof payload>)).toBe("duplicate");
    expect(accept({ ...payload(), progress: "conflicting version" })).toBe("conflict");
    expect(accept(payload(3))).toBe("accepted"); expect(accept(payload(2))).toBe("stale");
    expect(db.withConn((conn) => conn.query("SELECT sequence FROM task_checkpoints WHERE run_id='r1'").get())).toEqual({ sequence: 3 });
  });
  test("run, project, task and focus identities come from control-plane dispatch", () => {
    for (const patch of [{ project_id: "other" }, { task_id: "other" }, { intent_id: "other" }, { intent_id: null }]) expect(accept({ ...payload(), ...patch })).toBe("identity_mismatch");
    expect(db.withConn((conn) => acceptTaskCheckpoint(conn, { runId: "missing", projectId, taskId: "explore-test", bytes: Buffer.from(JSON.stringify(payload())) }))).toBe("identity_mismatch");
    expect(accept()).toBe("accepted");
  });
  test("finalization is idempotent and never accepts a newer post-finish checkpoint", () => {
    accept(); db.withConn((conn) => { finalizeCheckpointRun(conn, "r1", "hard_deadline"); finalizeCheckpointRun(conn, "r1", "finished"); });
    expect(accept(payload(2))).toBe("closed"); expect(accept()).toBe("duplicate");
    expect(db.withConn((conn) => conn.query("SELECT termination_reason FROM task_checkpoints WHERE run_id='r1'").get())).toEqual({ termination_reason: "hard_deadline" });
  });
  test("survives reopening and invalid updates; no graph or completion writes", () => {
    const before = db.withConn((conn) => getProjectDetail(conn, projectId)); accept();
    db = configureDatabase(db.path);
    expect(db.withConn((conn) => acceptTaskCheckpoint(conn, { runId: "r1", projectId, taskId: "explore-test", bytes: Buffer.from("{") }))).toBe("invalid");
    expect(accept()).toBe("duplicate"); expect(db.withConn((conn) => getProjectDetail(conn, projectId))).toEqual(before);
  });
  test("M48 enrichment is opt-in and finished-only, preserving the default projection", () => {
    accept();
    expect(db.withConn((conn) => buildTaskContextSnapshot(conn, projectId, { checkpoint: {} })).attempts).toEqual([]);
    finish();
    const plain = db.withConn((conn) => buildTaskContextSnapshot(conn, projectId));
    expect(plain.attempts[0]).not.toHaveProperty("memory");
    const enriched = db.withConn((conn) => buildTaskContextSnapshot(conn, projectId, { checkpoint: {} }));
    expect(enriched.attempts[0]?.memory).toMatchObject({ trust: "worker_claim_not_verified", control: { outcome: "failed" }, checkpoint: { attempts: [{ result: "tool_failure" }] } });
    expect(enriched.facts).toEqual(plain.facts);
  });
  test("reconciles lifecycle, superseded/missing facts, current scope and missing evidence on every reuse", () => {
    accept(); finish();
    const attempts = db.withConn((conn) => buildTaskContextSnapshot(conn, projectId)).attempts;
    const project = db.withConn((conn) => attachAttemptMemories(conn, projectId, attempts,
      [{ id: "f1", status: "superseded", superseded_by: "f2" }], [{ id: intentId, status: "abandoned" }], "paused",
      { scopeTargets: ["127.0.0.1:9090"], evidenceStatus: () => "missing" }));
    expect(project[0]?.memory?.reuse).toEqual({ intent_status: "abandoned", scope_status: "changed_requires_authorization",
      project_status: "paused", budget: "recheck_current_pack_core", automatic_execution: false,
      facts: [{ id: "f1", status: "superseded", superseded_by: "f2" }], evidence: [{ ref: "artifacts/test.log", status: "missing" }] });
    const current = db.withConn((conn) => attachAttemptMemories(conn, projectId, attempts, [], [], "active",
      { scopeTargets: ["127.0.0.1:8080"], evidenceStatus: () => "available" }));
    expect(current[0]?.memory?.reuse.facts[0]?.status).toBe("missing");
    expect(current[0]?.memory?.reuse.intent_status).toBe("missing");
    expect(current[0]?.memory?.reuse.scope_status).toBe("unchanged_requires_authorization");
    expect(current[0]?.memory?.checkpoint.attempts[0]?.result).toBe("tool_failure");
  });
  test("M51b result projection keeps authoritative failure and survives reopening without session files", () => {
    const value = payload(); value.attempts[0]!.result = "observed";
    expect(accept(value)).toBe("accepted");
    const failure = { domain: "infrastructure", code: "model_connection_error" } as const;
    db.withConn(conn => {
      finishRun(conn, "r1", { outcome: "failed", finishedAt: "2026-11-05T00:01:00Z", durationMs: 60000, failure });
      finalizeCheckpointRun(conn, "r1", "worker_exit");
    });
    db = configureDatabase(db.path);
    const snapshot = db.withConn(conn => buildTaskContextSnapshot(conn, projectId, { checkpoint: {} }));
    const memory = snapshot.attempts[0]?.memory;
    expect(memory?.control.failure).toEqual(failure);
    expect(memory?.experiment_result).toMatchObject({ status: "operationally_incomplete", hypothesis_verdict: "unknown",
      observations: [{ attempt_id: "a1", reported_result: "observed", evidence: "unavailable" }] });
    expect(memory?.checkpoint).toEqual(value);
    expect(db.withConn(conn => conn.query("SELECT COUNT(*) AS n FROM task_checkpoints").get())).toEqual({ n: 1 });
    expect(db.withConn(conn => buildTaskContextSnapshot(conn, projectId)).attempts[0]).not.toHaveProperty("memory");
  });
  test("M51b no checkpoint payload means no invented memory or result", () => {
    finish();
    expect(db.withConn(conn => buildTaskContextSnapshot(conn, projectId, { checkpoint: {} })).attempts[0]).not.toHaveProperty("memory");
  });
  test("project query cannot mix another project's memories even with same local fact ids", () => {
    accept(); finish();
    const other = db.withConn((conn) => createProject(conn, { title: "other", origin: "other", goal: "other", hints: null, bootstrap_enabled: false, scope: { targets: ["127.0.0.1"] } }).project.id);
    const attempt = db.withConn((conn) => buildTaskContextSnapshot(conn, projectId)).attempts;
    expect(db.withConn((conn) => attachAttemptMemories(conn, other, attempt, [], [], "active", {}))[0]).not.toHaveProperty("memory");
  });
  test("run deletion cascades sidecar and schema reopening does not destroy accepted versions", () => {
    accept(); configureDatabase(db.path);
    expect(accept()).toBe("duplicate");
    db.withConn((conn) => conn.query("DELETE FROM runs WHERE id='r1'").run());
    expect(db.withConn((conn) => conn.query("SELECT * FROM task_checkpoints").all())).toEqual([]);
  });
});
