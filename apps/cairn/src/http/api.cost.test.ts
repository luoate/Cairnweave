import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  concludeIntent,
  configureDatabase,
  createIntent,
  createProject,
  finishRun,
  heartbeatIntent,
  recordIntentMeta,
  startRun,
  type CairnDatabase,
  type ProjectCostReport,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-cost-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db });
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

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

function addRun(
  id: string,
  kind: string,
  tokens: number,
  cost: number,
  intentId: string | null = null,
): void {
  db.withConn((conn) => {
    startRun(conn, {
      id,
      projectId,
      taskId: `${kind}-${id}`,
      kind,
      intentId,
      worker: "cairn-worker",
      startedAt: "2026-01-01T00:00:00Z",
    });
    finishRun(conn, id, {
      outcome: "success",
      finishedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
      usage: { totalTokens: tokens, costUsd: cost },
    });
  });
}

describe("GET /projects/{id}/cost", () => {
  test("returns a zero report for an empty project", async () => {
    const response = await get(`/projects/${projectId}/cost`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProjectCostReport;
    expect(body).toMatchObject({
      project_id: projectId,
      totals: { tokens: 0, cost_usd: 0, runs: 0 },
      by_kind: [],
      attribution: {
        attributed_tokens: 0,
        unattributed_tokens: 0,
        complete: true,
      },
      intents: [],
      runs: [],
      edges: [],
    });
    expect(body.facts.map((fact: { id: string }) => fact.id)).toEqual(["goal", "origin"]);
    expect(body.facts.every((fact: { evidence_status: string }) => fact.evidence_status === "legacy")).toBe(true);
  });

  test("returns cost attribution and causal edges", async () => {
    const intentId = db.withConn((conn) => {
      const created = createIntent(conn, projectId, {
        from: ["origin"],
        description: "probe /admin",
        creator: "strategist",
        worker: null,
      });
      recordIntentMeta(conn, {
        projectId,
        intentId: created.id,
        source: "strategist",
        originRunId: "run_reason",
      });
      return created.id;
    });
    addRun("run_reason", "reason", 100, 0.1);
    addRun("run_explore", "explore", 40, 0.04, intentId);
    const factId = db.withConn((conn) => {
      heartbeatIntent(conn, projectId, intentId, "cairn-worker");
      return concludeIntent(conn, projectId, intentId, "cairn-worker", "admin exists", {
        runId: "run_explore",
        evidenceRefs: [],
        evidenceStatus: "missing",
      }).fact.id;
    });

    const response = await get(`/projects/${projectId}/cost`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProjectCostReport;
    expect(body.totals).toEqual({ tokens: 140, cost_usd: 0.14, runs: 2 });
    expect(body.by_kind).toEqual([
      { kind: "explore", runs: 1, tokens: 40, cost_usd: 0.04 },
      { kind: "reason", runs: 1, tokens: 100, cost_usd: 0.1 },
    ]);
    expect(body.attribution).toMatchObject({
      fact_direct_tokens: 40,
      orchestration_tokens: 100,
      orchestration_attributed_tokens: 100,
      attributed_tokens: 140,
      unattributed_tokens: 0,
      complete: true,
    });
    expect(body.facts.find((fact: { id: string }) => fact.id === factId)).toMatchObject({
      run_id: "run_explore",
      intent_id: intentId,
      origin_run_ids: ["run_reason"],
      total_tokens: 140,
      evidence_status: "missing",
    });
    expect(body.intents[0]).toMatchObject({
      id: intentId,
      origin_run_id: "run_reason",
      source: "strategist",
      direct_tokens: 40,
      orchestration_tokens: 100,
      total_tokens: 140,
    });
    expect(body.edges).toContainEqual({
      from: "run:run_reason",
      to: `intent:${intentId}`,
      kind: "created_intent",
      tokens: 100,
      cost_usd: 0.1,
    });
    expect(body.edges).toContainEqual({
      from: `intent:${intentId}`,
      to: "run:run_explore",
      kind: "executed_by",
      tokens: 40,
      cost_usd: 0.04,
    });
    expect(body.edges).toContainEqual({
      from: "run:run_explore",
      to: `fact:${factId}`,
      kind: "produced_fact",
      tokens: 40,
      cost_usd: 0.04,
    });
  });

  test("returns 404 for an unknown project and 405 for writes", async () => {
    expect((await get("/projects/proj_missing/cost")).status).toBe(404);
    const write = await api.handle(
      new Request(`http://cairn.test/projects/${projectId}/cost`, { method: "POST" }),
    );
    expect(write.status).toBe(405);
  });
});
