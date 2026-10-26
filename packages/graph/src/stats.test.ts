import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HttpError,
  buildProfileRunStats,
  buildProjectRunStats,
  configureDatabase,
  createProject,
  finishRun,
  startRun,
  type CairnDatabase,
  type RunOutcome,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-stats-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "stats",
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

interface RunInput {
  id: string;
  worker: string;
  workerProfile?: string | null;
  model: string | null;
  startedAt: string;
  outcome: RunOutcome | null;
  durationMs?: number;
  tokens?: number;
  costUsd?: number;
  evidenceCount?: number;
}

function record(input: RunInput, project = projectId): void {
  db.withConn((conn) => {
    startRun(conn, {
      id: input.id,
      projectId: project,
      taskId: `task-${input.id}`,
      kind: "explore",
      worker: input.worker,
      workerProfile: input.workerProfile ?? null,
      startedAt: input.startedAt,
    });
    if (input.outcome === null) return;
    finishRun(conn, input.id, {
      outcome: input.outcome,
      finishedAt: input.startedAt,
      durationMs: input.durationMs ?? 0,
      evidenceCount: input.evidenceCount ?? 0,
      model: input.model,
      usage: { totalTokens: input.tokens ?? 0, costUsd: input.costUsd ?? 0 },
    });
  });
}

describe("project run statistics", () => {
  test("returns zeroed totals and empty groups before any run", () => {
    const report = db.withConn((conn) => buildProjectRunStats(conn, projectId));
    expect(report).toEqual({
      project_id: projectId,
      totals: {
        runs: 0,
        running: 0,
        finished: 0,
        succeeded: 0,
        failed: 0,
        rejected: 0,
        cancelled: 0,
        unhealthy: 0,
        inactive: 0,
        success_rate: null,
        tokens: 0,
        cost_usd: 0,
        avg_duration_ms: null,
        evidence_count: 0,
        last_started_at: null,
      },
      by_worker: [],
      by_model: [],
      by_profile: [],
    });
  });

  test("groups outcomes, usage and duration by worker and by model", () => {
    record({
      id: "run_001",
      worker: "cairn-worker",
      workerProfile: "alpha",
      model: "gateway/deepseek-flash",
      startedAt: "2026-01-02T03:00:00Z",
      outcome: "success",
      durationMs: 7000,
      tokens: 127,
      costUsd: 0.25,
      evidenceCount: 1,
    });
    record({
      id: "run_002",
      worker: "cairn-worker",
      workerProfile: "alpha",
      model: "gateway/deepseek-flash",
      startedAt: "2026-01-02T03:01:00Z",
      outcome: "failed",
      durationMs: 2000,
      tokens: 13,
      costUsd: 0.125,
    });
    record({
      id: "run_003",
      worker: "other-worker",
      model: null,
      startedAt: "2026-01-02T03:02:00Z",
      outcome: null,
    });
    record({
      id: "run_004",
      worker: "other-worker",
      workerProfile: "beta",
      model: "gateway/other",
      startedAt: "2026-01-02T03:03:00Z",
      outcome: "rejected",
      durationMs: 1000,
      tokens: 5,
    });

    const report = db.withConn((conn) => buildProjectRunStats(conn, projectId));

    expect(report.totals).toEqual({
      runs: 4,
      running: 1,
      finished: 3,
      succeeded: 1,
      failed: 1,
      rejected: 1,
      cancelled: 0,
      unhealthy: 0,
      inactive: 0,
      success_rate: 1 / 3,
      tokens: 145,
      cost_usd: 0.375,
      avg_duration_ms: 3333,
      evidence_count: 1,
      last_started_at: "2026-01-02T03:03:00Z",
    });

    expect(report.by_worker.map((row) => row.worker)).toEqual([
      "cairn-worker",
      "other-worker",
    ]);
    expect(report.by_worker[0]).toMatchObject({
      runs: 2,
      finished: 2,
      succeeded: 1,
      failed: 1,
      success_rate: 0.5,
      tokens: 140,
      cost_usd: 0.375,
      avg_duration_ms: 4500,
      evidence_count: 1,
      last_started_at: "2026-01-02T03:01:00Z",
    });
    expect(report.by_worker[1]).toMatchObject({
      runs: 2,
      running: 1,
      finished: 1,
      rejected: 1,
      success_rate: 0,
      tokens: 5,
      avg_duration_ms: 1000,
      last_started_at: "2026-01-02T03:03:00Z",
    });

    // Models sort before the null bucket; a bucket with no finished run keeps a null rate.
    expect(report.by_model.map((row) => row.model)).toEqual([
      "gateway/deepseek-flash",
      "gateway/other",
      null,
    ]);
    expect(report.by_model[2]).toMatchObject({
      runs: 1,
      running: 1,
      finished: 0,
      success_rate: null,
      avg_duration_ms: null,
    });

    // Untagged runs are excluded; profiles are sorted by id.
    expect(report.by_profile.map((row) => row.worker_profile)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(report.by_profile[0]).toMatchObject({
      runs: 2,
      finished: 2,
      succeeded: 1,
      failed: 1,
      success_rate: 0.5,
      tokens: 140,
      avg_duration_ms: 4500,
    });
    expect(report.by_profile[1]).toMatchObject({
      runs: 1,
      finished: 1,
      rejected: 1,
      success_rate: 0,
      tokens: 5,
    });
  });

  test("aggregates profile history across projects for selection", () => {
    const otherProject = db.withConn(
      (conn) =>
        createProject(conn, {
          title: "other",
          origin: "origin",
          goal: "goal",
          hints: null,
          bootstrap_enabled: false,
          scope: { targets: ["127.0.0.1:8080"] },
        }).project.id,
    );
    record({
      id: "run_001",
      worker: "cairn-worker",
      workerProfile: "alpha",
      model: null,
      startedAt: "2026-01-02T03:00:00Z",
      outcome: "failed",
      tokens: 10,
    });
    record(
      {
        id: "run_002",
        worker: "cairn-worker",
        workerProfile: "beta",
        model: null,
        startedAt: "2026-01-02T03:01:00Z",
        outcome: "success",
        tokens: 20,
      },
      otherProject,
    );

    const rows = db.withConn((conn) => buildProfileRunStats(conn));
    expect(rows.map((row) => row.worker_profile)).toEqual(["alpha", "beta"]);
    expect(rows[0]).toMatchObject({ finished: 1, failed: 1, success_rate: 0 });
    expect(rows[1]).toMatchObject({ finished: 1, succeeded: 1, success_rate: 1 });
  });

  test("404s for an unknown project", () => {
    expect(() =>
      db.withConn((conn) => buildProjectRunStats(conn, "proj_999")),
    ).toThrow(HttpError);
  });
});
