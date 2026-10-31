import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProjectReport,
  concludeIntent,
  configureDatabase,
  createIntent,
  createProject,
  createHint,
  finishRun,
  heartbeatIntent,
  recordProjectArtifacts,
  recordTaskAudit,
  recordVerificationCheck,
  renderProjectReportMarkdown,
  run,
  setIntentStatus,
  setProjectVerification,
  startRun,
  type CairnDatabase,
} from "./index";

let directory: string;
let workspace: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-report-"));
  workspace = join(directory, "workspace");
  mkdirSync(join(workspace, "artifacts"), { recursive: true });
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "report",
        origin: "origin fact",
        goal: "goal fact",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Concludes a fresh intent and returns the new fact id. */
function addFact(description: string, supersedes: readonly string[] = []): string {
  return db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description,
      creator: "tester",
      worker: null,
    });
    heartbeatIntent(conn, projectId, intent.id, "cairn-worker");
    return concludeIntent(conn, projectId, intent.id, "cairn-worker", description, {
      supersedes,
    }).fact.id;
  });
}

function report(options: { verificationFallback?: "evidence" | "off" } = {}) {
  return db.withConn((conn) =>
    buildProjectReport(conn, projectId, {
      generatedAt: "2026-10-27T12:00:00Z",
      ...options,
    }),
  );
}

describe("buildProjectReport", () => {
  test("returns a zeroed snapshot for a fresh project", () => {
    const result = report();

    expect(result.generated_at).toBe("2026-10-27T12:00:00Z");
    expect(result.project).toMatchObject({
      id: projectId,
      title: "report",
      status: "active",
      bootstrap_enabled: false,
    });
    expect(result.verification).toEqual({
      kind: "evidence",
      challenge_code: null,
      checks: { total: 0, passed: 0, failed: 0, last_checked_at: null },
      latest: null,
    });
    expect(result.graph).toEqual({
      facts: 2,
      current_facts: 2,
      superseded_facts: 0,
      intents: 0,
      open_intents: 0,
      abandoned_intents: 0,
      hints: 0,
    });
    expect(result.current_facts.map((fact) => fact.id)).toEqual(["goal", "origin"]);
    expect(result.hints).toEqual([]);
    expect(result.supersessions).toEqual([]);
    expect(result.runs).toEqual({
      totals: {
        runs: 0,
        finished: 0,
        succeeded: 0,
        failed: 0,
        tokens: 0,
        cost_usd: 0,
        avg_duration_ms: null,
      },
      by_worker: [],
      by_model: [],
      by_profile: [],
    });
    expect(result.cost).toEqual({
      tokens: 0,
      cost_usd: 0,
      unattributed_tokens: 0,
      unattributed_cost_usd: 0,
      by_kind: [],
    });
    expect(result.audit).toEqual({
      tasks: 0,
      events: 0,
      first_at: null,
      last_at: null,
    });
    expect(result.artifacts).toEqual({ count: 0, bytes: 0 });
  });

  test("excludes superseded facts and keeps the edge list", () => {
    const older = addFact("service listens on port 80");
    const newer = addFact("service listens on port 8080", [older]);
    db.withConn((conn) =>
      createHint(conn, projectId, { content: "try the admin path", creator: "operator" }),
    );

    const result = report();

    expect(result.graph).toEqual({
      facts: 4,
      current_facts: 3,
      superseded_facts: 1,
      intents: 2,
      open_intents: 0,
      abandoned_intents: 0,
      hints: 1,
    });
    expect(result.current_facts.map((fact) => fact.id)).not.toContain(older);
    expect(result.current_facts.map((fact) => fact.id)).toContain(newer);
    expect(result.supersessions).toEqual([
      expect.objectContaining({ fact_id: older, superseded_by: newer }),
    ]);
    expect(result.hints).toEqual([
      expect.objectContaining({ content: "try the admin path", creator: "operator" }),
    ]);
  });

  test("counts abandoned intents separately from open work", () => {
    const intentId = db.withConn(
      (conn) =>
        createIntent(conn, projectId, {
          from: ["origin"],
          description: "dead end",
          creator: "tester",
          worker: null,
        }).id,
    );
    db.withConn((conn) =>
      setIntentStatus(conn, {
        projectId,
        intentId,
        status: "abandoned",
        reason: "no login form",
        by: "operator",
      }),
    );

    const result = report();

    expect(result.graph).toEqual({
      facts: 2,
      current_facts: 2,
      superseded_facts: 0,
      intents: 1,
      open_intents: 0,
      abandoned_intents: 1,
      hints: 0,
    });
  });

  test("reports run totals, per-worker/model/profile buckets and cost shares", () => {
    db.withConn((conn) => {
      startRun(conn, {
        id: "run_001",
        projectId,
        taskId: "task_a",
        kind: "explore",
        worker: "cairn-worker",
        workerProfile: "fast",
        startedAt: "2026-10-27T10:00:00Z",
      });
      finishRun(conn, "run_001", {
        outcome: "success",
        finishedAt: "2026-10-27T10:00:01Z",
        durationMs: 1_000,
        usage: { totalTokens: 100, costUsd: 0.5 },
        model: "deepseek-flash",
      });
      startRun(conn, {
        id: "run_002",
        projectId,
        taskId: "task_b",
        kind: "reason",
        worker: "cairn-worker",
        workerProfile: null,
        startedAt: "2026-10-27T11:00:00Z",
      });
      finishRun(conn, "run_002", {
        outcome: "failed",
        finishedAt: "2026-10-27T11:00:03Z",
        durationMs: 3_000,
        usage: { totalTokens: 50, costUsd: 0.25 },
        model: null,
      });
    });

    const result = report();

    expect(result.runs.totals).toEqual({
      runs: 2,
      finished: 2,
      succeeded: 1,
      failed: 1,
      tokens: 150,
      cost_usd: 0.75,
      avg_duration_ms: 2_000,
    });
    expect(result.runs.by_worker).toEqual([
      expect.objectContaining({ worker: "cairn-worker", runs: 2, succeeded: 1 }),
    ]);
    expect(result.runs.by_model.map((group) => group.model)).toEqual([
      "deepseek-flash",
      null,
    ]);
    expect(result.runs.by_profile).toEqual([
      expect.objectContaining({ worker_profile: "fast", runs: 1 }),
    ]);
    expect(result.cost).toMatchObject({
      tokens: 150,
      cost_usd: 0.75,
      unattributed_tokens: 150,
      unattributed_cost_usd: 0.75,
    });
    expect(result.cost.by_kind.map((entry) => entry.kind)).toEqual(["explore", "reason"]);
  });

  test("summarizes verification checks and artifact bytes", () => {
    writeFileSync(join(workspace, "artifacts", "a.txt"), "hello");
    writeFileSync(join(workspace, "artifacts", "b.bin"), "abc");
    db.withConn((conn) => {
      setProjectVerification(conn, projectId, {
        kind: "challenge",
        challenge_code: "web-01",
      });
      recordVerificationCheck(conn, {
        projectId,
        kind: "challenge",
        ok: true,
        detail: "challenge counts 2/2",
        challengeCode: "web-01",
        flagCount: 2,
        flagGotCount: 2,
        checkedAt: "2026-10-27T09:00:00Z",
      });
      recordVerificationCheck(conn, {
        projectId,
        kind: "challenge",
        ok: false,
        detail: "challenge counts 1/2",
        challengeCode: "web-01",
        flagCount: 2,
        flagGotCount: 1,
        checkedAt: "2026-10-27T09:05:00Z",
      });
      recordProjectArtifacts(conn, { projectId, taskId: "task_a", workspace });
    });

    const result = report();

    expect(result.verification).toMatchObject({
      kind: "challenge",
      challenge_code: "web-01",
      checks: {
        total: 2,
        passed: 1,
        failed: 1,
        last_checked_at: "2026-10-27T09:05:00Z",
      },
    });
    expect(result.verification.latest).toMatchObject({ ok: false, flag_got_count: 1 });
    expect(result.artifacts).toEqual({ count: 2, bytes: 8 });
  });

  test("falls back to the supplied policy for legacy projects", () => {
    db.withConn((conn) =>
      run(conn, "DELETE FROM project_verification WHERE project_id = ?", projectId),
    );

    expect(report().verification.kind).toBe("evidence");
    expect(report({ verificationFallback: "off" }).verification.kind).toBe("off");
  });

  test("aggregates audit counts without exposing event payloads", () => {
    db.withConn((conn) => {
      recordTaskAudit(conn, {
        projectId,
        taskId: "task_a",
        events: [
          { tool: "exec", output: "SECRET-TOKEN-XYZ" },
          { tool: "exec", output: "second event" },
        ],
        createdAt: "2026-10-27T08:00:00Z",
      });
      recordTaskAudit(conn, {
        projectId,
        taskId: "task_b",
        events: [{ tool: "read_file", output: "third event" }],
        createdAt: "2026-10-27T08:10:00Z",
      });
    });
    writeFileSync(join(workspace, "artifacts", "secret-path.txt"), "payload");

    const result = report();

    expect(result.audit).toEqual({
      tasks: 2,
      events: 3,
      first_at: "2026-10-27T08:00:00Z",
      last_at: "2026-10-27T08:10:00Z",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET-TOKEN-XYZ");
    expect(JSON.stringify(result)).not.toContain("secret-path.txt");
  });
});

describe("renderProjectReportMarkdown", () => {
  test("renders the same snapshot deterministically", () => {
    addFact("service listens on port 80");
    db.withConn((conn) => {
      createHint(conn, projectId, { content: "line one\nline two", creator: "operator" });
      startRun(conn, {
        id: "run_001",
        projectId,
        taskId: "task_a",
        kind: "explore",
        worker: "cairn-worker",
        startedAt: "2026-10-27T10:00:00Z",
      });
      finishRun(conn, "run_001", {
        outcome: "success",
        finishedAt: "2026-10-27T10:00:01Z",
        durationMs: 1_000,
        usage: { totalTokens: 100, costUsd: 0.5 },
        model: "deepseek-flash",
      });
    });

    const snapshot = report();
    const first = renderProjectReportMarkdown(snapshot);
    const second = renderProjectReportMarkdown(snapshot);

    expect(first).toBe(second);
    expect(first).toContain("# report");
    expect(first).toContain("- project: `" + projectId + "`");
    expect(first).toContain("## Graph");
    expect(first).toContain("## Runs");
    expect(first).toContain("## Cost");
    expect(first).toContain("## Audit and artifacts");
    expect(first).toContain("- (operator) line one line two");
    expect(first).toContain("| kind | runs | tokens | cost USD |");
    expect(first).toContain("| explore | 1 | 100 | 0.500000 |");
  });

  test("marks empty collections instead of emitting bare headers", () => {
    const markdown = renderProjectReportMarkdown(report());

    expect(markdown).toContain("### Current facts\n- `goal`: goal fact\n- `origin`: origin fact");
    expect(markdown).toContain("### Supersessions\n- (none)");
    expect(markdown).toContain("### By worker\n(none)");
  });
});
