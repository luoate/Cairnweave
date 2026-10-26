import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  recordAuditStreamLoss,
  recordTaskAudit,
  run,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-audit-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db });
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "audit",
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

function record(taskId: string, events: readonly unknown[]): void {
  db.withConn((conn) =>
    recordTaskAudit(conn, {
      projectId,
      taskId,
      events,
      createdAt: "2026-03-01T00:00:00Z",
    }),
  );
}

describe("audit routes", () => {
  test("lists task summaries and returns a verified chain", async () => {
    record("explore-1", [
      { decision: "allow", tool: "read" },
      { decision: "block", tool: "bash" },
    ]);
    record("explore-2", [{ decision: "allow", tool: "write" }]);

    const list = await get(`/projects/${projectId}/audit`);
    expect(list.status).toBe(200);
    const summaries = (await list.json()) as Array<Record<string, unknown>>;
    expect(summaries.map((row) => row["task_id"])).toEqual(["explore-1", "explore-2"]);
    expect(summaries[0]).toMatchObject({
      task_id: "explore-1",
      event_count: 2,
      first_at: "2026-03-01T00:00:00Z",
      last_at: "2026-03-01T00:00:00Z",
    });
    expect(typeof summaries[0]!["root_hash"]).toBe("string");

    const detail = await get(`/projects/${projectId}/audit/explore-1`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      chain_ok: boolean;
      broken_at: number | null;
      root_hash: string;
      events: Array<{ seq: number; event: unknown }>;
    };
    expect(body.chain_ok).toBe(true);
    expect(body.broken_at).toBeNull();
    expect(body.root_hash).toBe(summaries[0]!["root_hash"] as string);
    expect(body.events.map((row) => row.event)).toEqual([
      { decision: "allow", tool: "read" },
      { decision: "block", tool: "bash" },
    ]);
  });

  test("reports a broken chain after a row is edited", async () => {
    record("explore-1", [
      { decision: "allow", tool: "read" },
      { decision: "block", tool: "bash" },
    ]);
    db.withConn((conn) =>
      run(
        conn,
        "UPDATE audit_events SET event = ? WHERE project_id = ? AND task_id = ? AND seq = 1",
        JSON.stringify({ decision: "block", tool: "read" }),
        projectId,
        "explore-1",
      ),
    );

    const response = await get(`/projects/${projectId}/audit/explore-1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      chain_ok: false,
      broken_at: 1,
    });
  });

  test("returns an empty chain for an unknown task and 404 for an unknown project", async () => {
    const empty = await get(`/projects/${projectId}/audit/missing`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      task_id: "missing",
      event_count: 0,
      chain_ok: true,
      broken_at: null,
      root_hash: null,
      events: [],
    });

    expect((await get("/projects/proj_999/audit")).status).toBe(404);
    expect((await get("/projects/proj_999/audit/explore-1")).status).toBe(404);
  });

  test("exposes live-stream loss without changing the audit chain response", async () => {
    record("explore-1", [{ decision: "allow", tool: "read" }]);
    db.withConn((conn) =>
      recordAuditStreamLoss(conn, {
        projectId,
        taskId: "explore-1",
        reason: "queue overflow",
        delivered: 1,
        pending: 2,
        reportedAt: "2026-03-01T00:01:00Z",
        recordedAt: "2026-03-01T00:02:00Z",
      }),
    );

    const response = await get(`/projects/${projectId}/audit/explore-1/stream-lost`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      task_id: "explore-1",
      stream_lost: {
        task_id: "explore-1",
        reason: "queue overflow",
        delivered: 1,
        pending: 2,
        reported_at: "2026-03-01T00:01:00Z",
        recorded_at: "2026-03-01T00:02:00Z",
      },
    });

    const empty = await get(`/projects/${projectId}/audit/missing/stream-lost`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ task_id: "missing", stream_lost: null });

    const audit = (await (await get(`/projects/${projectId}/audit/explore-1`)).json()) as
      Record<string, unknown>;
    expect(audit["stream_lost"]).toBeUndefined();

    expect((await get("/projects/proj_999/audit/explore-1/stream-lost")).status).toBe(404);
  });
});
