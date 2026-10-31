import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAgentContext,
  concludeIntent,
  configureDatabase,
  createHint,
  createIntent,
  createProject,
  finishRun,
  heartbeatIntent,
  recordFactMeta,
  recordStrategistSuccess,
  recordVerificationCheck,
  renderAgentContextYaml,
  run,
  setProjectVerification,
  startRun,
  type CairnDatabase,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-agent-context-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "context",
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

function addFact(
  description: string,
  options: { supersedes?: readonly string[]; evidenceRefs?: readonly string[]; runId?: string } = {},
): { factId: string; intentId: string } {
  return db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description,
      creator: "tester",
      worker: null,
    });
    heartbeatIntent(conn, projectId, intent.id, "cairn-worker");
    const result = concludeIntent(conn, projectId, intent.id, "cairn-worker", description, {
      supersedes: options.supersedes ?? [],
      evidenceRefs: options.evidenceRefs ?? [],
      evidenceStatus:
        options.evidenceRefs === undefined || options.evidenceRefs.length === 0
          ? "missing"
          : "provided",
      ...(options.runId === undefined ? {} : { runId: options.runId }),
    });
    return { factId: result.fact.id, intentId: intent.id };
  });
}

function openIntent(description: string): string {
  return db.withConn(
    (conn) =>
      createIntent(conn, projectId, {
        from: ["origin"],
        description,
        creator: "tester",
        worker: null,
      }).id,
  );
}

function addRun(input: {
  id: string;
  intentId?: string;
  kind?: string;
  outcome?: "success" | "failed";
  startedAt?: string;
  finishedAt?: string;
  detail?: string | null;
}): void {
  db.withConn((conn) => {
    startRun(conn, {
      id: input.id,
      projectId,
      taskId: `task_${input.id}`,
      kind: input.kind ?? "explore",
      ...(input.intentId === undefined ? {} : { intentId: input.intentId }),
      worker: "cairn-worker",
      startedAt: input.startedAt ?? "2026-10-31T09:00:00Z",
    });
    if (input.outcome !== undefined) {
      finishRun(conn, input.id, {
        outcome: input.outcome,
        finishedAt: input.finishedAt ?? "2026-10-31T09:01:00Z",
        durationMs: 60_000,
        usage: { totalTokens: 1234, costUsd: 0.01 },
        detail: input.detail ?? null,
      });
    }
  });
}

function build(kind: "reason" | "explore" | "conclude", extra: Record<string, unknown> = {}) {
  return db.withConn((conn) =>
    buildAgentContext(conn, projectId, {
      kind,
      generatedAt: "2026-10-31T12:00:00Z",
      ...extra,
    }),
  );
}

describe("buildAgentContext", () => {
  test("projects the thin graph and an empty history for a fresh project", () => {
    const context = build("reason");

    expect(context).toMatchObject({
      version: 1,
      kind: "reason",
      generated_at: "2026-10-31T12:00:00Z",
      project: { id: projectId, title: "context", status: "active" },
      goal: { description: "goal fact" },
    });
    expect(context.facts.map((fact) => fact.id)).toEqual(["goal", "origin"]);
    expect(context.facts[0]).toEqual({
      id: "goal",
      description: "goal fact",
      status: "current",
      superseded_by: null,
      evidence: { status: "legacy", run_id: null, refs: 0 },
    });
    expect(context.intents).toEqual([]);
    expect(context.recent_attempts).toEqual([]);
    expect(context.delta).toBeNull();
    expect(context.budget).toBeNull();
    expect(context.truncated).toBe(false);
    expect(context.goal.verification).toEqual({
      kind: "evidence",
      challenge_code: null,
      progress: { found: null, total: null, last_checked_at: null },
      checks: { total: 0, passed: 0, failed: 0 },
      latest: null,
    });
  });

  test("marks superseded facts and carries evidence availability", () => {
    const older = addFact("service listens on port 80", {
      evidenceRefs: ["artifacts/port80.txt"],
      runId: "run_001",
    });
    const newer = addFact("service listens on port 8080", {
      supersedes: [older.factId],
      evidenceRefs: ["artifacts/port8080.txt", "artifacts/scan.txt"],
      runId: "run_002",
    });

    const context = build("reason");

    const superseded = context.facts.find((fact) => fact.id === older.factId);
    expect(superseded).toMatchObject({
      status: "superseded",
      superseded_by: newer.factId,
      evidence: { status: "provided", run_id: "run_001", refs: 1 },
    });
    expect(context.facts.find((fact) => fact.id === newer.factId)).toMatchObject({
      status: "current",
      superseded_by: null,
      evidence: { status: "provided", run_id: "run_002", refs: 2 },
    });
    // Current facts come first, then the replaced ones.
    expect(context.facts.at(-1)?.id).toBe(older.factId);
  });

  test("aggregates attempt history per intent and project-wide for reason", () => {
    const intentId = openIntent("check the admin panel");
    addRun({ id: "run_001", intentId, outcome: "failed", detail: "timed out\nwhile scanning" });
    addRun({
      id: "run_002",
      intentId,
      startedAt: "2026-10-31T09:10:00Z",
      outcome: "success",
      detail: "found login form",
    });
    addRun({ id: "run_003", kind: "reason", startedAt: "2026-10-31T09:20:00Z" });

    const reason = build("reason", {
      budget: { usedTokens: 5000, usedCostUsd: 0.25, maxTokens: 20000, maxCostUsd: 5 },
    });
    expect(reason.intents).toEqual([
      {
        id: intentId,
        description: "check the admin panel",
        from: ["origin"],
        status: "open",
        attempts: 2,
        last_outcome: "success",
        last_error: null,
        priority: null,
      },
    ]);
    expect(reason.recent_attempts.map((attempt) => attempt.run_id)).toEqual([
      "run_002",
      "run_001",
    ]);
    expect(reason.recent_attempts[1]?.detail).toBe("timed out while scanning");
    expect(reason.budget).toEqual({
      used_tokens: 5000,
      limit_tokens: 20000,
      used_cost_usd: 0.25,
      limit_cost_usd: 5,
      running_tasks: 1,
    });

    const explore = build("explore", { focusIntentId: intentId });
    expect(explore.intents.map((intent) => intent.id)).toEqual([intentId]);
    expect(explore.recent_attempts.map((attempt) => attempt.run_id)).toEqual([
      "run_002",
      "run_001",
    ]);
    expect(explore.facts.map((fact) => fact.id)).toEqual(["origin"]);
    expect(explore.budget).toBeNull();
  });

  test("reports challenge progress and the latest verification check", () => {
    db.withConn((conn) => {
      setProjectVerification(conn, projectId, {
        kind: "challenge",
        challenge_code: "web-01",
      });
      recordVerificationCheck(conn, {
        projectId,
        kind: "challenge",
        ok: false,
        detail: "challenge counts 2/5",
        challengeCode: "web-01",
        flagCount: 5,
        flagGotCount: 2,
        checkedAt: "2026-10-31T09:00:00Z",
      });
    });

    const context = build("reason");

    expect(context.goal.verification).toEqual({
      kind: "challenge",
      challenge_code: "web-01",
      progress: { found: 2, total: 5, last_checked_at: "2026-10-31T09:00:00Z" },
      checks: { total: 1, passed: 0, failed: 1 },
      latest: {
        ok: false,
        detail: "challenge counts 2/5",
        checked_at: "2026-10-31T09:00:00Z",
      },
    });
  });

  test("builds the reason delta since the last successful reason", () => {
    const since = "2020-01-01T00:00:00Z";
    db.withConn((conn) =>
      recordStrategistSuccess(conn, {
        projectId,
        runId: "run_reason_0",
        trigger: "initial",
        factCount: 2,
        hintCount: 0,
        openIntentCount: 0,
        at: since,
      }),
    );
    const older = addFact("old conclusion");
    db.withConn((conn) =>
      recordFactMeta(conn, {
        projectId,
        factId: older.factId,
        evidenceStatus: "missing",
        createdAt: "2019-01-01T00:00:00Z",
      }),
    );
    const newer = addFact("new conclusion");
    db.withConn((conn) =>
      recordFactMeta(conn, {
        projectId,
        factId: newer.factId,
        evidenceStatus: "missing",
        createdAt: "2026-10-31T11:00:00Z",
      }),
    );
    db.withConn((conn) =>
      run(
        conn,
        `INSERT INTO hints (id, project_id, content, creator, created_at)
         VALUES ('h900', ?, 'new hint', 'tester', '2026-10-31T11:00:00Z')`,
        projectId,
      ),
    );
    addRun({
      id: "run_001",
      intentId: newer.intentId,
      startedAt: "2026-10-31T11:00:00Z",
      finishedAt: "2026-10-31T11:01:00Z",
      outcome: "failed",
    });

    const context = build("reason");

    expect(context.delta).toEqual({
      since,
      new_facts: [newer.factId],
      concluded_intents: [older.intentId, newer.intentId],
      new_hints: 1,
      failed_attempts: 1,
    });
  });

  test("caps oversized views and marks the truncated sections", () => {
    const first = openIntent("first direction");
    const second = openIntent("second direction");
    addRun({ id: "run_001", intentId: first, outcome: "failed" });
    addRun({ id: "run_002", intentId: second, outcome: "failed", startedAt: "2026-10-31T09:10:00Z" });

    const context = build("reason", {
      limits: { maxFacts: 1, maxIntents: 1, maxAttempts: 1, maxDeltaIds: 1 },
    });

    expect(context.facts).toHaveLength(1);
    expect(context.intents).toHaveLength(1);
    expect(context.recent_attempts).toHaveLength(1);
    expect(context.truncated).toBe(true);
    expect(context.truncated_sections).toEqual(
      expect.arrayContaining(["facts", "intents", "attempts"]),
    );
  });
});

describe("renderAgentContextYaml", () => {
  test("renders a deterministic, desensitized document", () => {
    const intentId = openIntent("check the admin panel");
    addRun({ id: "run_001", intentId, outcome: "failed", detail: "FAILED: bad token" });
    db.withConn((conn) =>
      createHint(conn, projectId, { content: "try /admin", creator: "operator" }),
    );

    const context = build("reason");
    const first = renderAgentContextYaml(context);
    const second = renderAgentContextYaml(context);

    expect(first).toBe(second);
    expect(first).toContain("version: 1");
    expect(first).toContain("kind: reason");
    expect(first).toContain("generated_at: '2026-10-31T12:00:00Z'");
    expect(first).toContain("truncated: false");
    expect(first).toContain(`- id: ${intentId}`);
    expect(first).not.toContain("audit");
  });
});
