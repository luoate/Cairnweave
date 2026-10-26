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
  recordStrategistSuccess,
  startRun,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-strategist-"));
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

function api(budget?: {
  maxProjectTokens: number;
  maxProjectCostUsd: number;
  maxProjectTasks: number;
}): Api {
  return createApi({ db, ...(budget === undefined ? {} : { budget }) });
}

function get(instance: Api, path: string): Promise<Response> {
  return instance.handle(new Request(`http://cairn.test${path}`));
}

function addRun(id: string, kind: string, startedAt: string, tokens: number, cost: number): void {
  db.withConn((conn) => {
    startRun(conn, {
      id,
      projectId,
      taskId: `${kind}-${id}`,
      kind,
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

describe("GET /projects/{id}/strategist", () => {
  test("returns empty state, usage and null limits without scheduler config", async () => {
    const response = await get(api(), `/projects/${projectId}/strategist`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: null,
      budget: {
        used_tokens: 0,
        used_cost_usd: 0,
        running_tasks: 0,
        limits: null,
        exhausted: { tokens: false, cost_usd: false, tasks: false },
      },
      intents: [],
      reason_runs: [],
    });
  });

  test("orders open intents by priority and exposes intent metadata", async () => {
    const ids = db.withConn((conn) => {
      const low = createIntent(conn, projectId, {
        from: ["origin"],
        description: "low priority",
        creator: "tester",
        worker: null,
      });
      const normal = createIntent(conn, projectId, {
        from: ["origin"],
        description: "default priority",
        creator: "strategist",
        worker: null,
      });
      const high = createIntent(conn, projectId, {
        from: ["origin"],
        description: "high priority",
        creator: "worker-1",
        worker: "worker-1",
      });
      const done = createIntent(conn, projectId, {
        from: ["origin"],
        description: "concluded",
        creator: "worker-1",
        worker: "worker-1",
      });
      recordIntentMeta(conn, {
        projectId,
        intentId: low.id,
        source: "human",
        priority: 10,
      });
      recordIntentMeta(conn, {
        projectId,
        intentId: normal.id,
        source: "strategist",
        priority: 50,
        budget: JSON.stringify({ max_seconds: 300 }),
      });
      recordIntentMeta(conn, {
        projectId,
        intentId: high.id,
        source: "strategist",
        priority: 90,
        budget: JSON.stringify({ max_tool_calls: 20 }),
      });
      heartbeatIntent(conn, projectId, done.id, "worker-1");
      concludeIntent(conn, projectId, done.id, "worker-1", "done");
      return { low: low.id, normal: normal.id, high: high.id, done: done.id };
    });

    const body = (await (await get(api(), `/projects/${projectId}/strategist`)).json()) as {
      intents: Array<Record<string, unknown>>;
    };
    expect(body.intents.map((intent) => intent["id"])).toEqual([
      ids.high,
      ids.normal,
      ids.low,
    ]);
    expect(body.intents[0]).toMatchObject({
      id: ids.high,
      description: "high priority",
      worker: "worker-1",
      priority: 90,
      budget: { max_tool_calls: 20 },
      source: "strategist",
    });
    expect(body.intents[1]).toMatchObject({
      priority: 50,
      budget: { max_seconds: 300 },
    });
    expect(body.intents[2]).toMatchObject({ priority: 10, budget: null, source: "human" });
    expect(body.intents.some((intent) => intent["id"] === ids.done)).toBe(false);
  });

  test("returns newest reason runs first and applies the limit", async () => {
    db.withConn((conn) =>
      recordStrategistSuccess(conn, {
        projectId,
        runId: "run_r2",
        trigger: "facts:1->2",
        factCount: 2,
        hintCount: 0,
        openIntentCount: 1,
        at: "2026-01-02T04:00:00Z",
      }),
    );
    addRun("run_r1", "reason", "2026-01-02T03:00:00Z", 100, 0.001);
    addRun("run_r2", "reason", "2026-01-02T04:00:00Z", 200, 0.002);
    addRun("run_e1", "explore", "2026-01-02T05:00:00Z", 300, 0.003);

    const body = (await (await get(api(), `/projects/${projectId}/strategist`)).json()) as {
      state: Record<string, unknown>;
      reason_runs: Array<Record<string, unknown>>;
      budget: Record<string, unknown>;
    };
    expect(body.reason_runs.map((run) => run["id"])).toEqual(["run_r2", "run_r1"]);
    expect(body.state).toEqual({
      project_id: projectId,
      last_success_at: "2026-01-02T04:00:00Z",
      last_attempt_at: "2026-01-02T04:00:00Z",
      last_failure_at: null,
      last_trigger: "facts:1->2",
      last_run_id: "run_r2",
      last_fact_count: 2,
      last_hint_count: 0,
      last_open_intent_count: 1,
      updated_at: "2026-01-02T04:00:00Z",
    });
    expect(body.budget["used_tokens"]).toBe(600);
    expect(body.budget["used_cost_usd"]).toBeCloseTo(0.006, 10);

    const limited = (await (
      await get(api(), `/projects/${projectId}/strategist?limit=1`)
    ).json()) as { reason_runs: Array<Record<string, unknown>> };
    expect(limited.reason_runs.map((run) => run["id"])).toEqual(["run_r2"]);
  });

  test("defaults to 20 reason runs and accepts the maximum limit", async () => {
    for (let index = 1; index <= 25; index += 1) {
      const id = `run_${String(index).padStart(3, "0")}`;
      addRun(id, "reason", `2026-01-02T03:${String(index).padStart(2, "0")}:00Z`, 1, 0);
    }
    const instance = api();

    const defaultBody = (await (
      await get(instance, `/projects/${projectId}/strategist`)
    ).json()) as { reason_runs: Array<Record<string, unknown>> };
    expect(defaultBody.reason_runs).toHaveLength(20);
    expect(defaultBody.reason_runs[0]!["id"]).toBe("run_025");
    expect(defaultBody.reason_runs[19]!["id"]).toBe("run_006");

    const maxBody = (await (
      await get(instance, `/projects/${projectId}/strategist?limit=100`)
    ).json()) as { reason_runs: Array<Record<string, unknown>> };
    expect(maxBody.reason_runs).toHaveLength(25);
  });

  test("reports configured limits, running tasks and exhaustion flags", async () => {
    addRun("run_r1", "reason", "2026-01-02T03:00:00Z", 500, 0.75);
    db.withConn((conn) => {
      startRun(conn, {
        id: "run_live",
        projectId,
        taskId: "explore-live",
        kind: "explore",
        worker: "cairn-worker",
        startedAt: "2026-01-02T04:00:00Z",
      });
    });

    const instance = api({
      maxProjectTokens: 400,
      maxProjectCostUsd: 0.5,
      maxProjectTasks: 1,
    });
    const body = (await (await get(instance, `/projects/${projectId}/strategist`)).json()) as {
      budget: Record<string, unknown>;
    };
    expect(body.budget).toEqual({
      used_tokens: 500,
      used_cost_usd: 0.75,
      running_tasks: 1,
      limits: {
        max_project_tokens: 400,
        max_project_cost_usd: 0.5,
        max_project_tasks: 1,
      },
      exhausted: { tokens: true, cost_usd: true, tasks: true },
    });
  });

  test("404s for an unknown project", async () => {
    const response = await get(api(), "/projects/nope/strategist");
    expect(response.status).toBe(404);
  });

  test("rejects invalid limits and non-GET methods", async () => {
    const instance = api();
    for (const limit of ["0", "101", "1.5", "abc", "-1"]) {
      const response = await get(instance, `/projects/${projectId}/strategist?limit=${limit}`);
      expect(response.status).toBe(400);
    }

    const post = await instance.handle(
      new Request(`http://cairn.test/projects/${projectId}/strategist`, { method: "POST" }),
    );
    expect(post.status).toBe(405);
    const del = await instance.handle(
      new Request(`http://cairn.test/projects/${projectId}/strategist`, { method: "DELETE" }),
    );
    expect(del.status).toBe(405);
  });
});
