import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  concludeIntent,
  configureDatabase,
  createIntent,
  createProject,
  heartbeatIntent,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-report-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db });
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

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

describe("GET /projects/{id}/report", () => {
  test("returns the JSON snapshot by default", async () => {
    const response = await get(`/projects/${projectId}/report`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      generated_at: expect.any(String),
      project: { id: projectId, status: "active" },
      verification: { kind: "evidence", checks: { total: 0 }, latest: null },
      graph: {
        facts: 2,
        current_facts: 2,
        superseded_facts: 0,
        intents: 0,
        open_intents: 0,
        hints: 0,
      },
      runs: { totals: { runs: 0 } },
      cost: { tokens: 0, by_kind: [] },
      audit: { tasks: 0, events: 0 },
      artifacts: { count: 0, bytes: 0 },
    });
    expect(body["current_facts"]).toEqual([
      { id: "goal", description: "goal fact" },
      { id: "origin", description: "origin fact" },
    ]);
  });

  test("renders Markdown for the same snapshot", async () => {
    db.withConn((conn) => {
      const intent = createIntent(conn, projectId, {
        from: ["origin"],
        description: "check the port",
        creator: "tester",
        worker: null,
      });
      heartbeatIntent(conn, projectId, intent.id, "cairn-worker");
      concludeIntent(conn, projectId, intent.id, "cairn-worker", "port is 8080");
    });

    const response = await get(`/projects/${projectId}/report?format=markdown`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("# report");
    expect(body).toContain("- facts: 3 (current 3, superseded 0)");
    expect(body).toContain("- `f001`: port is 8080");
    expect(body).toContain("## Completion");
  });

  test("rejects unknown formats and projects, and stays read-only", async () => {
    const badFormat = await get(`/projects/${projectId}/report?format=yaml`);
    expect(badFormat.status).toBe(400);
    expect(await badFormat.json()).toEqual({
      detail: "Supported formats: json, markdown",
    });

    const missing = await get("/projects/proj_missing/report");
    expect(missing.status).toBe(404);

    const write = await api.handle(
      new Request(`http://cairn.test/projects/${projectId}/report`, { method: "POST" }),
    );
    expect(write.status).toBe(405);
  });
});
