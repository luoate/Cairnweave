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
        trigger: null,
        outcome: "success",
        exit_code: 0,
        started_at: "2026-01-02T03:00:00Z",
        finished_at: "2026-01-02T03:00:05Z",
        duration_ms: 5000,
        session: ".cairn/sessions/explore-1",
        evidence_count: 1,
        detail: null,
      },
    ]);
  });

  test("404s for an unknown project", async () => {
    const response = await get("/projects/nope/runs");
    expect(response.status).toBe(404);
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
