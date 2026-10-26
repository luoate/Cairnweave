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
  recordTaskAudit,
  startRun,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-runs-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db });
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

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

describe("GET /projects/{id}/runs", () => {
  test("returns recorded runs", async () => {
    db.withConn((conn) => {
      startRun(conn, {
        id: "run_001",
        projectId,
        taskId: "explore-1",
        kind: "explore",
        intentId: "i001",
        worker: "cairn-worker",
        startedAt: "2026-01-02T03:00:00Z",
        session: ".cairn/sessions/explore-1",
      });
      finishRun(conn, "run_001", {
        outcome: "success",
        finishedAt: "2026-01-02T03:00:05Z",
        durationMs: 5000,
        exitCode: 0,
        evidenceCount: 1,
        model: "gateway/deepseek-flash",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          totalTokens: 165,
          costUsd: 0.0042,
        },
      });
    });

    const response = await get(`/projects/${projectId}/runs`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        id: "run_001",
        project_id: projectId,
        task_id: "explore-1",
        kind: "explore",
        intent_id: "i001",
        worker: "cairn-worker",
        worker_profile: null,
        model: "gateway/deepseek-flash",
        trigger: null,
        outcome: "success",
        exit_code: 0,
        started_at: "2026-01-02T03:00:00Z",
        finished_at: "2026-01-02T03:00:05Z",
        duration_ms: 5000,
        session: ".cairn/sessions/explore-1",
        evidence_count: 1,
        detail: null,
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
        total_tokens: 165,
        cost_usd: 0.0042,
      },
    ]);
  });

  test("404s for an unknown project", async () => {
    const response = await get("/projects/nope/runs");
    expect(response.status).toBe(404);
  });
});

describe("GET /projects/{id}/stats", () => {
  test("aggregates outcomes and usage by worker and model", async () => {
    db.withConn((conn) => {
      startRun(conn, {
        id: "run_001",
        projectId,
        taskId: "explore-1",
        kind: "explore",
        worker: "cairn-worker",
        workerProfile: "alpha",
        startedAt: "2026-01-02T03:00:00Z",
      });
      finishRun(conn, "run_001", {
        outcome: "success",
        finishedAt: "2026-01-02T03:00:05Z",
        durationMs: 5000,
        model: "gateway/deepseek-flash",
        usage: { totalTokens: 100, costUsd: 0.5 },
      });
      startRun(conn, {
        id: "run_002",
        projectId,
        taskId: "explore-2",
        kind: "explore",
        worker: "cairn-worker",
        startedAt: "2026-01-02T03:01:00Z",
      });
      finishRun(conn, "run_002", {
        outcome: "failed",
        finishedAt: "2026-01-02T03:01:02Z",
        durationMs: 2000,
        model: "gateway/deepseek-flash",
        usage: { totalTokens: 20, costUsd: 0.1 },
      });
    });

    const response = await get(`/projects/${projectId}/stats`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      totals: Record<string, unknown>;
      by_worker: Array<Record<string, unknown>>;
      by_model: Array<Record<string, unknown>>;
      by_profile: Array<Record<string, unknown>>;
    };
    expect(body.totals).toMatchObject({
      runs: 2,
      finished: 2,
      succeeded: 1,
      failed: 1,
      success_rate: 0.5,
      tokens: 120,
      cost_usd: 0.6,
      avg_duration_ms: 3500,
    });
    expect(body.by_worker).toHaveLength(1);
    expect(body.by_worker[0]).toMatchObject({
      worker: "cairn-worker",
      runs: 2,
      success_rate: 0.5,
    });
    expect(body.by_model).toHaveLength(1);
    expect(body.by_model[0]).toMatchObject({
      model: "gateway/deepseek-flash",
      runs: 2,
      success_rate: 0.5,
    });
    expect(body.by_profile).toHaveLength(1);
    expect(body.by_profile[0]).toMatchObject({
      worker_profile: "alpha",
      runs: 1,
      success_rate: 1,
    });
  });

  test("404s for an unknown project and rejects writes", async () => {
    expect((await get("/projects/nope/stats")).status).toBe(404);
    const post = await api.handle(
      new Request(`http://cairn.test/projects/${projectId}/stats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(post.status).toBe(405);
  });
});

describe("fact -> run -> audit drill-down", () => {
  test("walks a produced fact to its run model and that task's tool calls", async () => {
    const factId = db.withConn((conn) => {
      const intent = createIntent(conn, projectId, {
        from: ["origin"],
        description: "drill",
        creator: "tester",
        worker: null,
      });
      heartbeatIntent(conn, projectId, intent.id, "cairn-worker");
      startRun(conn, {
        id: "run_001",
        projectId,
        taskId: "explore-1",
        kind: "explore",
        intentId: intent.id,
        worker: "cairn-worker",
        startedAt: "2026-01-02T03:00:00Z",
      });
      finishRun(conn, "run_001", {
        outcome: "success",
        finishedAt: "2026-01-02T03:00:05Z",
        durationMs: 5000,
        exitCode: 0,
        model: "gateway/deepseek-flash",
        evidenceCount: 0,
      });
      recordTaskAudit(conn, {
        projectId,
        taskId: "explore-1",
        events: [
          { decision: "allow", tool: "bash" },
          { decision: "block", tool: "write" },
        ],
        createdAt: "2026-01-02T03:00:05Z",
      });
      return concludeIntent(conn, projectId, intent.id, "cairn-worker", "found", {
        runId: "run_001",
        evidenceRefs: [],
        evidenceStatus: "missing",
      }).fact.id;
    });

    const meta = (await (await get(`/projects/${projectId}/facts/${factId}/meta`)).json()) as {
      run_id: string | null;
    };
    expect(meta.run_id).toBe("run_001");

    const runs = (await (await get(`/projects/${projectId}/runs`)).json()) as Array<{
      id: string;
      task_id: string;
      model: string | null;
    }>;
    const run = runs.find((item) => item.id === meta.run_id);
    expect(run).toMatchObject({
      task_id: "explore-1",
      model: "gateway/deepseek-flash",
    });

    const audit = (await (
      await get(`/projects/${projectId}/audit/${run!.task_id}`)
    ).json()) as { chain_ok: boolean; events: Array<{ event: { tool?: string } }> };
    expect(audit.chain_ok).toBe(true);
    expect(audit.events.map((row) => row.event.tool)).toEqual(["bash", "write"]);
  });
});

describe("GET /projects/{id}/facts/{fact_id}/meta", () => {
  test("returns evidence metadata attached by the scheduler", async () => {
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
        evidenceRefs: ["artifacts/probe.txt"],
        evidenceStatus: "provided",
      }).fact.id;
    });

    const response = await get(`/projects/${projectId}/facts/${factId}/meta`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      fact_id: factId,
      run_id: "run_001",
      evidence_refs: ["artifacts/probe.txt"],
      evidence_status: "provided",
    });
  });

  test("reports legacy metadata for facts without a sidecar row", async () => {
    const response = await get(`/projects/${projectId}/facts/origin/meta`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      fact_id: "origin",
      run_id: null,
      evidence_refs: [],
      evidence_status: "legacy",
      created_at: null,
    });
  });

  test("404s for an unknown fact", async () => {
    const response = await get(`/projects/${projectId}/facts/f999/meta`);
    expect(response.status).toBe(404);
  });

  test("marks facts from manual conclusions as missing evidence", async () => {
    const created = db.withConn((conn) => {
      const intent = createIntent(conn, projectId, {
        from: ["origin"],
        description: "manual",
        creator: "human",
        worker: null,
      });
      heartbeatIntent(conn, projectId, intent.id, "human");
      return intent;
    });
    const response = await api.handle(
      new Request(
        `http://cairn.test/projects/${projectId}/intents/${created.id}/conclude`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worker: "human", description: "manual fact" }),
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { fact: { id: string } };

    const meta = await get(`/projects/${projectId}/facts/${body.fact.id}/meta`);
    expect(await meta.json()).toMatchObject({
      run_id: null,
      evidence_refs: [],
      evidence_status: "missing",
    });
  });
});
