import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  finishRun,
  startRun,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let workspace: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-activity-"));
  workspace = join(directory, "workspace");
  mkdirSync(workspace, { recursive: true });
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db, workspaceRoot: workspace });
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "activity",
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

function writeTaskContract(taskId: string, hard: number, soft?: number): void {
  const session = join(workspace, projectId, ".cairn", "sessions", taskId);
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "task.json"), JSON.stringify({
    taskId,
    hardDeadlineSeconds: hard,
    ...(soft === undefined ? {} : { softDeadlineSeconds: soft }),
  }), "utf8");
}

describe("GET /projects/{id}/activity", () => {
  test("returns the scheduler feed and the live deadline from task.json", async () => {
    const startedAt = new Date(Date.now() - 70_000).toISOString();
    db.withConn((conn) => {
      startRun(conn, {
        id: "run_001",
        projectId,
        taskId: "explore-aaaaaaaaaaaa",
        kind: "explore",
        intentId: "i001",
        worker: "cairn-worker",
        startedAt,
      });
    });
    writeTaskContract("explore-aaaaaaaaaaaa", 300, 60);

    const response = await get(`/projects/${projectId}/activity`);
    expect(response.status).toBe(200);
    const view = (await response.json()) as any;
    expect(view.project_id).toBe(projectId);
    expect(view.events).toHaveLength(1);
    expect(view.events[0]).toMatchObject({
      kind: "run_dispatched",
      category: "dispatch",
      task_id: "explore-aaaaaaaaaaaa",
      intent_id: "i001",
      attempt: 1,
    });
    expect(view.running).toHaveLength(1);
    expect(view.running[0].deadline).toMatchObject({
      hard_seconds: 300,
      soft_seconds: 60,
      phase: "soft_overdue",
    });
    expect(view.running[0].elapsed_ms).toBeGreaterThanOrEqual(69_000);
    expect(view.running[0].elapsed_ms).toBeLessThan(90_000);
  });

  test("a missing task.json leaves the deadline unknown instead of guessing", async () => {
    db.withConn((conn) => {
      startRun(conn, {
        id: "run_001",
        projectId,
        taskId: "explore-bbbbbbbbbbbb",
        kind: "explore",
        intentId: "i001",
        worker: "cairn-worker",
        startedAt: "2026-01-02T03:00:00Z",
      });
    });

    const view = (await (await get(`/projects/${projectId}/activity`)).json()) as any;
    expect(view.running[0].deadline).toBeNull();
  });

  test("finished runs report their outcome and failure category", async () => {
    db.withConn((conn) => {
      startRun(conn, {
        id: "run_001",
        projectId,
        taskId: "explore-cccccccccccc",
        kind: "explore",
        intentId: "i001",
        worker: "cairn-worker",
        startedAt: "2026-01-02T03:00:00Z",
      });
      finishRun(conn, "run_001", {
        outcome: "failed",
        finishedAt: "2026-01-02T03:00:10Z",
        durationMs: 10_000,
        detail: "invalid evidence: page_flag.php: file is empty (0 bytes; minimum 1)",
        failure: { domain: "execution", code: "evidence_invalid" },
      });
    });

    const view = (await (await get(`/projects/${projectId}/activity`)).json()) as any;
    const finished = view.events.find((event: any) => event.kind === "run_finished");
    expect(finished).toMatchObject({
      level: "error",
      category: "evidence",
      title: "探索证据校验失败",
      detail: "证据文件不可用：page_flag.php: file is empty (0 bytes; minimum 1)",
      outcome: "failed",
      failure: { domain: "execution", code: "evidence_invalid" },
    });
    expect(view.running).toEqual([]);
  });

  test("caps the feed with limit and reports truncation", async () => {
    db.withConn((conn) => {
      for (const index of [1, 2, 3]) {
        startRun(conn, {
          id: `run_00${index}`,
          projectId,
          taskId: `explore-ddddddddddd${index}`,
          kind: "explore",
          intentId: "i001",
          worker: "cairn-worker",
          startedAt: `2026-01-02T03:0${index}:00Z`,
        });
      }
    });

    const view = (await (await get(`/projects/${projectId}/activity?limit=2`)).json()) as any;
    expect(view.truncated).toBe(true);
    expect(view.events.map((event: any) => event.run_id)).toEqual(["run_002", "run_003"]);
    expect(view.events[0].attempt).toBe(2);
  });

  test("an unknown project is a 404", async () => {
    expect((await get("/projects/proj_missing/activity")).status).toBe(404);
  });
});
