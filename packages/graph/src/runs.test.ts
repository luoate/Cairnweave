import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HttpError,
  concludeIntent,
  configureDatabase,
  createIntent,
  createProject,
  finishRun,
  getFactMeta,
  getProjectUsage,
  heartbeatIntent,
  listFactEvidence,
  listProjectRuns,
  recordFactMeta,
  startRun,
  type CairnDatabase,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-runs-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "runs",
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

function start(overrides: Partial<Parameters<typeof startRun>[1]> = {}): string {
  const id = overrides.id ?? "run_001";
  db.withConn((conn) =>
    startRun(conn, {
      id,
      projectId,
      taskId: "task-1",
      kind: "explore",
      worker: "cairn-worker",
      intentId: null,
      trigger: null,
      startedAt: "2026-01-02T03:00:00Z",
      session: ".cairn/sessions/task-1",
      ...overrides,
    }),
  );
  return id;
}

function concludeWithEvidence(runId: string | null): string {
  return db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description: "probe",
      creator: "tester",
      worker: null,
    });
    heartbeatIntent(conn, projectId, intent.id, "cairn-worker");
    const evidence =
      runId === null
        ? undefined
        : {
            runId,
            evidenceRefs: ["artifacts/probe.txt"],
            evidenceStatus: "provided" as const,
            evidenceFiles: [
              { path: "artifacts/probe.txt", size: 5, sha256: "a".repeat(64) },
            ],
          };
    return concludeIntent(
      conn,
      projectId,
      intent.id,
      "cairn-worker",
      "found a thing",
      evidence,
    ).fact.id;
  });
}

describe("runs", () => {
  test("records a running task and finishes it in place", () => {
    start();
    expect(db.withConn((conn) => listProjectRuns(conn, projectId))).toMatchObject([
      {
        id: "run_001",
        project_id: projectId,
        task_id: "task-1",
        kind: "explore",
        outcome: null,
        session: ".cairn/sessions/task-1",
      },
    ]);

    db.withConn((conn) =>
      finishRun(conn, "run_001", {
        outcome: "success",
        finishedAt: "2026-01-02T03:00:07Z",
        durationMs: 7000,
        exitCode: 0,
        evidenceCount: 1,
        detail: null,
      }),
    );
    const [run] = db.withConn((conn) => listProjectRuns(conn, projectId));
    expect(run).toMatchObject({
      outcome: "success",
      exit_code: 0,
      duration_ms: 7000,
      evidence_count: 1,
    });
  });

  test("orders runs by start time", () => {
    start({ id: "run_001", taskId: "task-b", startedAt: "2026-01-02T03:00:02Z" });
    start({ id: "run_002", taskId: "task-a", startedAt: "2026-01-02T03:00:01Z" });
    const runs = db.withConn((conn) => listProjectRuns(conn, projectId));
    expect(runs.map((run) => run.id)).toEqual(["run_002", "run_001"]);
  });

  test("persists solver usage and aggregates it per project", () => {
    start();
    db.withConn((conn) =>
      finishRun(conn, "run_001", {
        outcome: "success",
        finishedAt: "2026-01-02T03:00:07Z",
        durationMs: 7000,
        exitCode: 0,
        evidenceCount: 0,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
          totalTokens: 127,
          costUsd: 0.25,
        },
      }),
    );
    start({ id: "run_002", taskId: "task-2" });
    db.withConn((conn) =>
      finishRun(conn, "run_002", {
        outcome: "failed",
        finishedAt: "2026-01-02T03:00:09Z",
        durationMs: 2000,
        exitCode: 1,
        evidenceCount: 0,
        usage: {
          inputTokens: 10,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 13,
          costUsd: 0.125,
        },
      }),
    );

    const runs = db.withConn((conn) => listProjectRuns(conn, projectId));
    expect(runs[0]).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 5,
      cache_write_tokens: 2,
      total_tokens: 127,
      cost_usd: 0.25,
    });
    // A failed solve still burned tokens, so it stays in the project total.
    expect(db.withConn((conn) => getProjectUsage(conn, projectId))).toEqual({
      tokens: 140,
      cost_usd: 0.375,
    });
  });

  test("reports zero usage before any run finishes", () => {
    start();
    expect(db.withConn((conn) => getProjectUsage(conn, projectId))).toEqual({
      tokens: 0,
      cost_usd: 0,
    });
  });

  test("404s usage for an unknown project", () => {
    expect(() => db.withConn((conn) => getProjectUsage(conn, "proj_999"))).toThrow(
      HttpError,
    );
  });

  test("404s runs for an unknown project", () => {
    expect(() => db.withConn((conn) => listProjectRuns(conn, "proj_999"))).toThrow(
      HttpError,
    );
  });
});

describe("fact metadata", () => {
  test("links a fact to its run and evidence", () => {
    start();
    const factId = concludeWithEvidence("run_001");
    const meta = db.withConn((conn) => getFactMeta(conn, projectId, factId));
    expect(meta).toEqual({
      fact_id: factId,
      run_id: "run_001",
      evidence_refs: ["artifacts/probe.txt"],
      evidence_status: "provided",
      created_at: expect.any(String),
    });
  });

  test("marks manually concluded facts as missing evidence", () => {
    const factId = concludeWithEvidence(null);
    const meta = db.withConn((conn) => getFactMeta(conn, projectId, factId));
    expect(meta).toMatchObject({
      run_id: null,
      evidence_refs: [],
      evidence_status: "missing",
    });
  });

  test("synthesizes legacy metadata for origin and goal", () => {
    const meta = db.withConn((conn) => getFactMeta(conn, projectId, "origin"));
    expect(meta).toEqual({
      fact_id: "origin",
      run_id: null,
      evidence_refs: [],
      evidence_status: "legacy",
      created_at: null,
    });
  });

  test("returns null for an unknown fact", () => {
    expect(db.withConn((conn) => getFactMeta(conn, projectId, "f999"))).toBeNull();
  });

  test("recordFactMeta is idempotent", () => {
    db.withConn((conn) =>
      recordFactMeta(conn, {
        projectId,
        factId: "origin",
        evidenceStatus: "missing",
        createdAt: "2026-01-02T03:00:00Z",
      }),
    );
    db.withConn((conn) =>
      recordFactMeta(conn, {
        projectId,
        factId: "origin",
        evidenceStatus: "missing",
        createdAt: "2026-01-02T03:00:00Z",
      }),
    );
    const meta = db.withConn((conn) => getFactMeta(conn, projectId, "origin"));
    expect(meta?.evidence_status).toBe("missing");
  });
});

test("deleting a project cascades runs and fact metadata", () => {
  start();
  const factId = concludeWithEvidence("run_001");
  db.withConn((conn) => {
    conn.query("DELETE FROM projects WHERE id = ?").run(projectId);
    expect(conn.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    expect(
      conn.query("SELECT COUNT(*) AS n FROM fact_meta WHERE fact_id = ?").get(factId),
    ).toEqual({ n: 0 });
    expect(
      conn
        .query("SELECT COUNT(*) AS n FROM fact_evidence WHERE fact_id = ?")
        .get(factId),
    ).toEqual({ n: 0 });
  });
});

describe("fact evidence", () => {
  test("stores and orders content digests for a concluded fact", () => {
    const factId = db.withConn((conn) => {
      const intent = createIntent(conn, projectId, {
        from: ["origin"],
        description: "probe",
        creator: "tester",
        worker: null,
      });
      heartbeatIntent(conn, projectId, intent.id, "cairn-worker");
      return concludeIntent(conn, projectId, intent.id, "cairn-worker", "found", {
        runId: "run_001",
        evidenceRefs: ["artifacts/b.txt", "artifacts/a.txt"],
        evidenceStatus: "provided",
        evidenceFiles: [
          { path: "artifacts/b.txt", size: 2, sha256: "b".repeat(64) },
          { path: "artifacts/a.txt", size: 1, sha256: "a".repeat(64) },
        ],
      }).fact.id;
    });

    const files = db.withConn((conn) => listFactEvidence(conn, projectId, factId));
    expect(files).toEqual([
      {
        path: "artifacts/a.txt",
        size: 1,
        sha256: "a".repeat(64),
        created_at: expect.any(String),
      },
      {
        path: "artifacts/b.txt",
        size: 2,
        sha256: "b".repeat(64),
        created_at: expect.any(String),
      },
    ]);
  });

  test("returns [] without evidence and null for an unknown fact", () => {
    const factId = concludeWithEvidence("run_001");
    expect(db.withConn((conn) => listFactEvidence(conn, projectId, factId))).toHaveLength(1);
    expect(
      db.withConn((conn) => listFactEvidence(conn, projectId, "origin")),
    ).toEqual([]);
    expect(
      db.withConn((conn) => listFactEvidence(conn, projectId, "f999")),
    ).toBeNull();
  });

  test("404s evidence for an unknown project", () => {
    expect(() =>
      db.withConn((conn) => listFactEvidence(conn, "proj_999", "origin")),
    ).toThrow(HttpError);
  });
});
