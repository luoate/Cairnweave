import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDatabase, createProject, type CairnDatabase } from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let workspace: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-trace-"));
  workspace = join(directory, "workspace");
  mkdirSync(workspace, { recursive: true });
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db, workspaceRoot: workspace });
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "trace",
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

function writeTrace(taskId: string, lines: string[]): void {
  const session = join(workspace, projectId, ".cairn", "sessions", taskId, "solver-session");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "model-trace.jsonl"), lines.join("\n") + "\n", "utf8");
}

describe("GET /projects/{id}/runs/{task_id}/trace", () => {
  test("serves the worker's model trace for a known project", async () => {
    writeTrace("task_1", [
      JSON.stringify({ seq: 1, at: "2026-01-02T03:00:00Z", type: "request", turn: 1, model: "deepseek-flash" }),
      JSON.stringify({ seq: 2, at: "2026-01-02T03:00:05Z", type: "response", turn: 1, stop_reason: "stop" }),
    ]);
    const response = await get(`/projects/${projectId}/runs/task_1/trace`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { available: boolean; cursor: number; events: { type: string }[] };
    expect(body.available).toBe(true);
    expect(body.cursor).toBe(2);
    expect(body.events.map((event) => event.type)).toEqual(["request", "response"]);
  });

  test("supports a cursor so a polling UI only receives new events", async () => {
    writeTrace("task_1", [JSON.stringify({ seq: 7, at: "2026-01-02T03:00:00Z", type: "stream" })]);
    const response = await get(`/projects/${projectId}/runs/task_1/trace?cursor=7`);
    const body = (await response.json()) as { events: unknown[]; cursor: number };
    expect(body.events).toEqual([]);
    expect(body.cursor).toBe(7);
  });

  test("an unknown project is a 404, not an empty trace", async () => {
    const response = await get(`/projects/proj_missing/runs/task_1/trace`);
    expect(response.status).toBe(404);
  });

  test("a task without a trace file is unavailable rather than an error", async () => {
    const response = await get(`/projects/${projectId}/runs/task_none/trace`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ task_id: "task_none", available: false, truncated: false, cursor: 0, events: [] });
  });
});
