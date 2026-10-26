import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HttpError,
  buildProjectCostReport,
  concludeIntent,
  configureDatabase,
  createIntent,
  createProject,
  finishRun,
  heartbeatIntent,
  recordIntentMeta,
  startRun,
  type CairnDatabase,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-cost-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "cost",
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

function run(
  id: string,
  kind: string,
  tokens: number,
  cost: number,
  intentId: string | null = null,
  startedAt = "2026-01-01T00:00:00Z",
): void {
  db.withConn((conn) => {
    startRun(conn, {
      id,
      projectId,
      taskId: `${kind}-${id}`,
      kind,
      intentId,
      worker: "cairn-worker",
      startedAt,
    });
    finishRun(conn, id, {
      outcome: "success",
      finishedAt: startedAt,
      durationMs: 1000,
      usage: { totalTokens: tokens, costUsd: cost },
    });
  });
}

function intent(description: string, originRunId: string | null = null): string {
  return db.withConn((conn) => {
    const created = createIntent(conn, projectId, {
      from: ["origin"],
      description,
      creator: "strategist",
      worker: null,
    });
    recordIntentMeta(conn, {
      projectId,
      intentId: created.id,
      source: "strategist",
      originRunId,
    });
    return created.id;
  });
}

function conclude(intentId: string, runId: string, description: string, evidence = false): string {
  return db.withConn((conn) => {
    heartbeatIntent(conn, projectId, intentId, "cairn-worker");
    const result = concludeIntent(conn, projectId, intentId, "cairn-worker", description, {
      runId,
      evidenceRefs: evidence ? ["artifacts/a.txt"] : [],
      evidenceStatus: evidence ? "provided" : "missing",
      ...(evidence
        ? {
            evidenceFiles: [
              { path: "artifacts/a.txt", size: 5, sha256: "a".repeat(64) },
            ],
          }
        : {}),
    });
    return result.fact.id;
  });
}

describe("buildProjectCostReport", () => {
  test("attributes run usage through reason-created intents to facts", () => {
    const i001 = intent("first direction", "run_001");
    const i002 = intent("second direction", "run_001");
    run("run_001", "reason", 100, 1);
    run("run_002", "explore", 40, 0.4, i001);
    const first = conclude(i001, "run_002", "first fact", true);
    run("run_003", "explore", 60, 0.6, i002);
    const second = conclude(i002, "run_003", "second fact");
    run("run_004", "reason", 30, 0.3);

    const report = db.withConn((conn) => buildProjectCostReport(conn, projectId));
    expect(report.totals).toEqual({ tokens: 230, cost_usd: 2.3, runs: 4 });
    expect(report.by_kind).toEqual([
      { kind: "explore", runs: 2, tokens: 100, cost_usd: 1 },
      { kind: "reason", runs: 2, tokens: 130, cost_usd: 1.3 },
    ]);
    expect(report.attribution).toEqual({
      fact_direct_tokens: 100,
      fact_direct_cost_usd: 1,
      orchestration_tokens: 100,
      orchestration_cost_usd: 1,
      orchestration_attributed_tokens: 100,
      orchestration_attributed_cost_usd: 1,
      attributed_tokens: 200,
      attributed_cost_usd: 2,
      unattributed_tokens: 30,
      unattributed_cost_usd: 0.3,
      complete: false,
    });

    const firstFact = report.facts.find((fact) => fact.id === first)!;
    expect(firstFact).toMatchObject({
      run_id: "run_002",
      run_kind: "explore",
      intent_id: i001,
      evidence_status: "provided",
      evidence_refs: ["artifacts/a.txt"],
      source_fact_ids: ["origin"],
      origin_run_ids: ["run_001"],
      direct_tokens: 40,
      direct_cost_usd: 0.4,
      orchestration_tokens: 50,
      orchestration_cost_usd: 0.5,
      total_tokens: 90,
      total_cost_usd: 0.9,
    });
    const secondFact = report.facts.find((fact) => fact.id === second)!;
    expect(secondFact).toMatchObject({
      intent_id: i002,
      evidence_status: "missing",
      direct_tokens: 60,
      orchestration_tokens: 50,
      total_tokens: 110,
      total_cost_usd: 1.1,
    });

    const firstIntent = report.intents.find((entry) => entry.id === i001)!;
    expect(firstIntent).toMatchObject({
      origin_run_id: "run_001",
      source: "strategist",
      run_ids: ["run_002"],
      produced_fact_ids: [first],
      direct_tokens: 40,
      orchestration_tokens: 50,
      total_tokens: 90,
    });
    expect(firstIntent.from).toEqual(["origin"]);

    expect(report.edges).toHaveLength(10);
    expect(report.edges).toContainEqual({
      from: "run:run_001",
      to: `intent:${i001}`,
      kind: "created_intent",
      tokens: 50,
      cost_usd: 0.5,
    });
    expect(report.edges).toContainEqual({
      from: `intent:${i001}`,
      to: "run:run_002",
      kind: "executed_by",
      tokens: 40,
      cost_usd: 0.4,
    });
    expect(report.edges).toContainEqual({
      from: "run:run_002",
      to: `fact:${first}`,
      kind: "produced_fact",
      tokens: 40,
      cost_usd: 0.4,
    });
    expect(report.edges).toContainEqual({
      from: "fact:origin",
      to: `intent:${i001}`,
      kind: "source_fact",
      tokens: 0,
      cost_usd: 0,
    });
    expect(report.edges).toContainEqual({
      from: `intent:${i001}`,
      to: `fact:${first}`,
      kind: "concluded_fact",
      tokens: 0,
      cost_usd: 0,
    });
    expect(report.edges.some((edge) => edge.from === "run:run_004")).toBe(false);

    expect(report.runs.find((entry) => entry.id === "run_001")).toMatchObject({
      created_intent_ids: [i001, i002],
      produced_fact_ids: [],
    });
    expect(report.runs.find((entry) => entry.id === "run_002")).toMatchObject({
      intent_id: i001,
      produced_fact_ids: [first],
    });
  });

  test("splits integer token remainders deterministically", () => {
    run("run_001", "reason", 101, 0);
    intent("left", "run_001");
    intent("right", "run_001");
    intent("third", "run_001");

    const report = db.withConn((conn) => buildProjectCostReport(conn, projectId));
    expect(report.intents.map((entry) => entry.orchestration_tokens)).toEqual([34, 34, 33]);
    expect(report.attribution.complete).toBe(false);
  });

  test("leaves reason usage unattributed when provenance is missing", () => {
    const i001 = intent("legacy direction");
    run("run_001", "reason", 25, 0.25);

    const report = db.withConn((conn) => buildProjectCostReport(conn, projectId));
    expect(report.intents.find((entry) => entry.id === i001)?.origin_run_id).toBeNull();
    expect(report.attribution.attributed_tokens).toBe(0);
    expect(report.attribution.unattributed_tokens).toBe(25);
    expect(report.edges).toEqual([
      {
        from: "fact:origin",
        to: `intent:${i001}`,
        kind: "source_fact",
        tokens: 0,
        cost_usd: 0,
      },
    ]);
  });

  test("returns a complete zero report for a project with no runs", () => {
    const report = db.withConn((conn) => buildProjectCostReport(conn, projectId));
    expect(report.totals).toEqual({ tokens: 0, cost_usd: 0, runs: 0 });
    expect(report.by_kind).toEqual([]);
    expect(report.attribution).toMatchObject({
      attributed_tokens: 0,
      unattributed_tokens: 0,
      complete: true,
    });
    expect(report.facts.map((fact) => fact.id)).toEqual(["goal", "origin"]);
    expect(report.facts.every((fact) => fact.evidence_status === "legacy")).toBe(true);
    expect(report.intents).toEqual([]);
    expect(report.runs).toEqual([]);
    expect(report.edges).toEqual([]);
  });

  test("rejects an unknown project", () => {
    expect(() => db.withConn((conn) => buildProjectCostReport(conn, "proj_missing"))).toThrow(
      HttpError,
    );
  });
});
