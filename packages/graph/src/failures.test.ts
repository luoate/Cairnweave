import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskContextSnapshot } from "./context-snapshot";
import { buildAgentContext, clearInfrastructureFaultAfterSuccess, configureDatabase, createIntent, createProject,
  finishRun, getInfrastructureFault, infrastructureDispatchBlocked, listProjectRuns, listRecentStrategistRuns,
  recordInfrastructureFailure, recordStrategistSuccess, renderAgentContextYaml, resetInfrastructureFault, startRun,
  type CairnDatabase } from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;
const at = "2026-11-05T07:00:00.000Z";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-failure-state-"));
  db = configureDatabase(join(directory, "db.sqlite"));
  projectId = db.withConn(conn => createProject(conn, { title: "lab", origin: "start", goal: "goal", hints: null,
    bootstrap_enabled: false, scope: { targets: ["127.0.0.1:8080"] } }).project.id);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const fault = () => db.withConn(conn => getInfrastructureFault(conn, projectId));
function fail(code: "model_connection_error" | "model_auth_error" | "model_rate_limit" = "model_connection_error", time = at) {
  return db.withConn(conn => recordInfrastructureFailure(conn, { projectId, code, at: time }));
}

test("backoff persists across reopen, allows one probe after deadline, and opens after three failures", () => {
  const first = fail();
  expect(first).toMatchObject({ state: "backoff", consecutive_failures: 1, retry_after: "2026-11-05T07:00:30.000Z" });
  db = configureDatabase(join(directory, "db.sqlite"));
  expect(fault()).toEqual(first);
  expect(infrastructureDispatchBlocked(fault(), new Date("2026-11-05T07:00:29Z"))).toBe(true);
  expect(infrastructureDispatchBlocked(fault(), new Date("2026-11-05T07:00:30Z"))).toBe(false);
  expect(fail("model_connection_error", "2026-11-05T07:00:31Z")).toMatchObject({ state: "backoff", consecutive_failures: 2,
    retry_after: "2026-11-05T07:01:31.000Z" });
  expect(fail("model_rate_limit", "2026-11-05T07:02:00Z")).toMatchObject({ state: "blocked", consecutive_failures: 3, retry_after: null });
  expect(infrastructureDispatchBlocked(fault(), new Date("2027-01-01"))).toBe(true);
});

test("authentication blocks immediately; rate limiting starts at sixty seconds", () => {
  expect(fail("model_rate_limit").retry_after).toBe("2026-11-05T07:01:00.000Z");
  db.withConn(conn => resetInfrastructureFault(conn, projectId));
  expect(fail("model_auth_error")).toMatchObject({ state: "blocked", consecutive_failures: 1, retry_after: null });
  const id = fault()!.id;
  db.withConn(conn => clearInfrastructureFaultAfterSuccess(conn, projectId, id));
  expect(fault()?.state).toBe("blocked");
});

test("only success observing the exact backoff clears it; an older parallel success cannot", () => {
  const first = fail(); const second = fail();
  db.withConn(conn => clearInfrastructureFaultAfterSuccess(conn, projectId, first.id));
  expect(fault()?.id).toBe(second.id);
  db.withConn(conn => clearInfrastructureFaultAfterSuccess(conn, projectId, null));
  expect(fault()).not.toBeNull();
  db.withConn(conn => clearInfrastructureFaultAfterSuccess(conn, projectId, second.id));
  expect(fault()).toBeNull();
  const next = fail();
  expect(next.consecutive_failures).toBe(1);
  expect(next.id).not.toBe(first.id);
});

test("faults are project scoped and roll back with the surrounding transaction", () => {
  const another = db.withConn(conn => createProject(conn, { title: "other", origin: "start", goal: "goal", hints: null,
    bootstrap_enabled: false, scope: { targets: ["127.0.0.1:8080"] } }).project.id);
  fail();
  db.withConn(conn => resetInfrastructureFault(conn, another));
  expect(fault()).not.toBeNull();
  expect(db.withConn(conn => getInfrastructureFault(conn, another))).toBeNull();
  expect(() => db.withConn(conn => {
    resetInfrastructureFault(conn, projectId); throw new Error("rollback");
  })).toThrow("rollback");
  expect(fault()).not.toBeNull();
});

test("operational failures remain auditable but do not count as route attempts or zero-output", () => {
  db.withConn(conn => {
    const intent = createIntent(conn, projectId, { from: ["origin"], description: "check login", creator: "fixture", worker: null });
    recordStrategistSuccess(conn, { projectId, runId: "seed", trigger: "initial", factCount: 2, hintCount: 0,
      openIntentCount: 1, at: "2026-11-05T06:00:00Z" });
    for (const [id, failure] of [["infra", { domain: "infrastructure", code: "model_connection_error" }],
      ["execution", { domain: "execution", code: "hard_deadline" }], ["legacy", undefined]] as const) {
      startRun(conn, { id, projectId, taskId: id, kind: "explore", intentId: intent.id, worker: "fixture", startedAt: at });
      finishRun(conn, id, { outcome: "failed", finishedAt: at, durationMs: 1, ...(failure === undefined ? {} : { failure }) });
    }
    expect(listProjectRuns(conn, projectId).find(run => run.id === "infra")?.failure)
      .toEqual({ domain: "infrastructure", code: "model_connection_error" });
    expect(listProjectRuns(conn, projectId).find(run => run.id === "legacy")).not.toHaveProperty("failure");
    expect(listRecentStrategistRuns(conn, projectId, 10).map(run => run.id)).toEqual(["legacy"]);
    const context = buildAgentContext(conn, projectId, { kind: "reason", verificationFallback: "off" });
    expect(context.intents.find(item => item.id === intent.id)?.attempts).toBe(1);
    expect(context.delta?.failed_attempts).toBe(1);
    expect(context.recent_attempts.find(item => item.run_id === "infra")?.failure?.domain).toBe("infrastructure");
    expect(renderAgentContextYaml(context)).toContain("operational_failure_not_hypothesis_refutation");
    const snapshot = buildTaskContextSnapshot(conn, projectId, { verificationFallback: "off" });
    expect(snapshot.attempts.find(item => item.run_id === "infra")?.failure)
      .toEqual({ domain: "infrastructure", code: "model_connection_error" });
    expect(snapshot.intents.find(item => item.id === intent.id)?.attempts).toBe(1);
    expect(snapshot.delta?.failed_attempts).toBe(1);
    expect(context.facts).toHaveLength(2); // No error -> fact conversion.
  });
});
