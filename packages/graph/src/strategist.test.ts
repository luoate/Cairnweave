import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimReason,
  concludeIntent,
  configureDatabase,
  countReasonRunsSince,
  createIntent,
  createProject,
  finishRun,
  getStrategistState,
  listRecentStrategistRuns,
  recordStrategistFailure,
  recordStrategistSuccess,
  requestStrategistReplan,
  startRun,
  type CairnDatabase,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-strategist-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "strategist",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function success(at = "2026-01-01T00:00:10Z") {
  db.withConn((conn) =>
    recordStrategistSuccess(conn, {
      projectId,
      runId: "run-reason-1",
      trigger: "initial",
      factCount: 2,
      hintCount: 1,
      openIntentCount: 3,
      at,
    }),
  );
}

function addRun(
  id: string,
  kind: string,
  outcome: "success" | "failed",
  finishedAt: string,
  startsAt = finishedAt,
): void {
  db.withConn((conn) => {
    startRun(conn, {
      id,
      projectId,
      taskId: `task-${id}`,
      kind,
      worker: "tester",
      startedAt: startsAt,
    });
    finishRun(conn, id, {
      outcome,
      finishedAt,
      durationMs: 1000,
    });
  });
}

function addFactFromRun(runId: string): string {
  return db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description: `explore ${runId}`,
      creator: "tester",
      worker: "tester",
    });
    return concludeIntent(conn, projectId, intent.id, "tester", `fact ${runId}`, {
      runId,
      evidenceRefs: [],
      evidenceStatus: "missing",
    }).fact.id;
  });
}

describe("Strategist state", () => {
  test("is absent until the first attempt and records success watermarks", () => {
    expect(db.withConn((conn) => getStrategistState(conn, projectId))).toBeNull();

    success();
    expect(db.withConn((conn) => getStrategistState(conn, projectId))).toMatchObject({
      project_id: projectId,
      last_success_at: "2026-01-01T00:00:10Z",
      last_attempt_at: "2026-01-01T00:00:10Z",
      last_failure_at: null,
      last_trigger: "initial",
      last_run_id: "run-reason-1",
      last_fact_count: 2,
      last_hint_count: 1,
      last_open_intent_count: 3,
      replan_requested_at: null,
      replan_requested_by: null,
      replan_reason: null,
    });
  });

  test("failure keeps success watermarks and sets a backoff marker", () => {
    success();
    db.withConn((conn) =>
      recordStrategistFailure(conn, {
        projectId,
        runId: "run-reason-2",
        trigger: "facts:2->3",
        at: "2026-01-01T00:01:00Z",
      }),
    );

    const state = db.withConn((conn) => getStrategistState(conn, projectId))!;
    expect(state).toMatchObject({
      last_success_at: "2026-01-01T00:00:10Z",
      last_attempt_at: "2026-01-01T00:01:00Z",
      last_failure_at: "2026-01-01T00:01:00Z",
      last_trigger: "facts:2->3",
      last_run_id: "run-reason-2",
      last_fact_count: 2,
      last_hint_count: 1,
      last_open_intent_count: 3,
    });

    // A later success clears the failure marker.
    success("2026-01-01T00:02:00Z");
    expect(
      db.withConn((conn) => getStrategistState(conn, projectId))!.last_failure_at,
    ).toBeNull();
  });

  test("failure on a fresh project creates a row without fake watermarks", () => {
    db.withConn((conn) =>
      recordStrategistFailure(conn, {
        projectId,
        runId: "run-reason-1",
        trigger: "initial",
        at: "2026-01-01T00:00:10Z",
      }),
    );
    expect(db.withConn((conn) => getStrategistState(conn, projectId))).toMatchObject({
      last_success_at: null,
      last_failure_at: "2026-01-01T00:00:10Z",
      last_fact_count: 0,
      last_hint_count: 0,
      last_open_intent_count: 0,
    });
  });

  test("cascades with the project", () => {
    success();
    db.withConn((conn) =>
      conn.query("DELETE FROM projects WHERE id = ?").run(projectId),
    );
    expect(db.withConn((conn) => getStrategistState(conn, projectId))).toBeNull();
  });
});

describe("Strategist replan requests", () => {
  function request(
    overrides: Partial<{
      reason: string | null;
      requestedBy: string;
      at: string;
    }> = {},
  ) {
    return db.withConn((conn) =>
      requestStrategistReplan(conn, projectId, {
        reason: "new direction",
        requestedBy: "operator",
        at: "2026-01-01T00:05:00Z",
        ...overrides,
      }),
    );
  }

  test("stores a request without moving the success watermarks", () => {
    success();
    expect(request()).toMatchObject({
      project_id: projectId,
      last_success_at: "2026-01-01T00:00:10Z",
      last_attempt_at: "2026-01-01T00:00:10Z",
      replan_requested_at: "2026-01-01T00:05:00Z",
      replan_requested_by: "operator",
      replan_reason: "new direction",
    });
  });

  test("creates a row for a project that has never reasoned", () => {
    expect(request({ reason: null })).toMatchObject({
      last_success_at: null,
      last_fact_count: 0,
      last_hint_count: 0,
      last_open_intent_count: 0,
      replan_requested_at: "2026-01-01T00:05:00Z",
      replan_requested_by: "operator",
      replan_reason: null,
    });
  });

  test("clears the request after either a success or a failure", () => {
    request();
    success("2026-01-01T00:06:00Z");
    expect(
      db.withConn((conn) => getStrategistState(conn, projectId)),
    ).toMatchObject({
      replan_requested_at: null,
      replan_requested_by: null,
      replan_reason: null,
    });

    request({ at: "2026-01-01T00:07:00Z" });
    db.withConn((conn) =>
      recordStrategistFailure(conn, {
        projectId,
        runId: "run-reason-2",
        trigger: "manual_replan",
        at: "2026-01-01T00:08:00Z",
      }),
    );
    expect(
      db.withConn((conn) => getStrategistState(conn, projectId)),
    ).toMatchObject({
      last_failure_at: "2026-01-01T00:08:00Z",
      replan_requested_at: null,
      replan_requested_by: null,
      replan_reason: null,
    });
  });

  test("rejects a request while a reason task holds the lease", () => {
    db.withConn((conn) => claimReason(conn, projectId, "observer", "manual"));
    expect(() => request()).toThrow("A reason task is already running");
    expect(db.withConn((conn) => getStrategistState(conn, projectId))).toBeNull();
  });

  test("rejects a request for a non-active project", () => {
    db.withConn((conn) =>
      conn.query("UPDATE projects SET status = 'completed' WHERE id = ?").run(projectId),
    );
    expect(() => request()).toThrow("Project is completed");
  });
});

describe("Strategist run summaries", () => {
  test("marks fact-producing runs and ignores reason runs", () => {
    addRun("run-1", "explore", "success", "2026-01-01T00:00:01Z");
    addRun("run-2", "explore", "failed", "2026-01-01T00:00:02Z");
    addRun("run-3", "reason", "success", "2026-01-01T00:00:03Z");
    addRun("run-4", "conclude", "success", "2026-01-01T00:00:04Z");

    // Attach a fact only to run-1.
    addFactFromRun("run-1");

    const runs = db.withConn((conn) =>
      listRecentStrategistRuns(conn, projectId, 10),
    );
    expect(runs.map((run) => run.id)).toEqual(["run-4", "run-2", "run-1"]);
    expect(runs.map((run) => run.produced_fact)).toEqual([false, false, true]);
  });

  test("counts reason runs in the rolling window", () => {
    addRun("r1", "reason", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:09:00Z");
    addRun("r2", "reason", "failed", "2026-01-01T00:20:00Z", "2026-01-01T00:19:00Z");
    addRun("e1", "explore", "success", "2026-01-01T00:30:00Z");

    expect(
      db.withConn((conn) =>
        countReasonRunsSince(conn, projectId, "2026-01-01T00:15:00Z"),
      ),
    ).toBe(1);
    expect(
      db.withConn((conn) =>
        countReasonRunsSince(conn, projectId, "2026-01-01T00:00:00Z"),
      ),
    ).toBe(2);
  });
});
