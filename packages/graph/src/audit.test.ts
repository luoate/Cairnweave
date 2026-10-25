import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUDIT_GENESIS_HASH,
  HttpError,
  configureDatabase,
  createProject,
  getTaskAudit,
  listProjectAudit,
  recordTaskAudit,
  run,
  type CairnDatabase,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-audit-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = createProjectRow("audit");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function createProjectRow(title: string): string {
  return db.withConn(
    (conn) =>
      createProject(conn, {
        title,
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
}

function record(
  taskId = "explore-1",
  events: readonly unknown[] = [
    { decision: "allow", tool: "read" },
    { decision: "block", tool: "bash" },
  ],
): ReturnType<typeof listProjectAudit>[number] | null {
  return db.withConn((conn) =>
    recordTaskAudit(conn, {
      projectId,
      taskId,
      events,
      createdAt: "2026-02-01T00:00:00Z",
    }),
  );
}

describe("audit ledger", () => {
  test("chains events and exposes task summaries", () => {
    record();
    const events = db.withConn((conn) => getTaskAudit(conn, projectId, "explore-1"));
    expect(events.chain_ok).toBe(true);
    expect(events.event_count).toBe(2);
    expect(events.events[0]!.seq).toBe(1);
    expect(events.events[0]!.prev_hash).toBe(AUDIT_GENESIS_HASH);
    expect(events.events[1]!.prev_hash).toBe(events.events[0]!.hash);
    expect(events.root_hash).toBe(events.events[1]!.hash);
    expect(events.events[1]!.event).toEqual({ decision: "block", tool: "bash" });

    const summaries = db.withConn((conn) => listProjectAudit(conn, projectId));
    expect(summaries).toEqual([
      {
        task_id: "explore-1",
        event_count: 2,
        root_hash: events.root_hash!,
        first_at: "2026-02-01T00:00:00Z",
        last_at: "2026-02-01T00:00:00Z",
      },
    ]);
  });

  test("does not fork or extend an existing task chain", () => {
    record();
    expect(record("explore-1", [{ decision: "allow", tool: "other" }])).toBeNull();
    const events = db.withConn((conn) => getTaskAudit(conn, projectId, "explore-1"));
    expect(events.event_count).toBe(2);
    expect(events.events[1]!.event).toEqual({ decision: "block", tool: "bash" });
    expect(record("explore-1", [])).toBeNull();
  });

  test("keeps tasks and projects separate", () => {
    record("explore-1");
    record("explore-2", [{ decision: "allow", tool: "write" }]);
    expect(
      db.withConn((conn) => listProjectAudit(conn, projectId).map((row) => row.task_id)),
    ).toEqual(["explore-1", "explore-2"]);

    const otherProject = createProjectRow("other");
    expect(db.withConn((conn) => listProjectAudit(conn, otherProject))).toEqual([]);
    expect(
      db.withConn((conn) => getTaskAudit(conn, otherProject, "explore-1")).events,
    ).toEqual([]);

    const empty = db.withConn((conn) => getTaskAudit(conn, projectId, "missing"));
    expect(empty).toEqual({
      task_id: "missing",
      event_count: 0,
      chain_ok: true,
      broken_at: null,
      root_hash: null,
      events: [],
    });
  });

  test("detects a modified event or broken link", () => {
    record();
    db.withConn((conn) =>
      run(
        conn,
        "UPDATE audit_events SET event = ? WHERE project_id = ? AND task_id = ? AND seq = 2",
        JSON.stringify({ decision: "allow", tool: "bash" }),
        projectId,
        "explore-1",
      ),
    );
    const tampered = db.withConn((conn) => getTaskAudit(conn, projectId, "explore-1"));
    expect(tampered.chain_ok).toBe(false);
    expect(tampered.broken_at).toBe(2);

    db.withConn((conn) =>
      run(
        conn,
        "UPDATE audit_events SET event = ? WHERE project_id = ? AND task_id = ? AND seq = 2",
        JSON.stringify({ decision: "block", tool: "bash" }),
        projectId,
        "explore-1",
      ),
    );
    db.withConn((conn) =>
      run(
        conn,
        "UPDATE audit_events SET prev_hash = ? WHERE project_id = ? AND task_id = ? AND seq = 2",
        AUDIT_GENESIS_HASH,
        projectId,
        "explore-1",
      ),
    );
    expect(
      db.withConn((conn) => getTaskAudit(conn, projectId, "explore-1")).broken_at,
    ).toBe(2);
  });

  test("rejects non-object events and unknown projects", () => {
    expect(() => record("explore-1", ["not an object"])).toThrow("JSON object");
    expect(() =>
      db.withConn((conn) => listProjectAudit(conn, "proj_999")),
    ).toThrow(HttpError);
    expect(() =>
      db.withConn((conn) => getTaskAudit(conn, "proj_999", "explore-1")),
    ).toThrow(HttpError);
    expect(() =>
      db.withConn((conn) =>
        recordTaskAudit(conn, { projectId: "proj_999", taskId: "x", events: [{}] }),
      ),
    ).toThrow(HttpError);
  });

  test("cascades when the project is deleted", () => {
    record();
    db.withConn((conn) => {
      conn.query("DELETE FROM projects WHERE id = ?").run(projectId);
      expect(conn.query("SELECT COUNT(*) AS n FROM audit_events").get()).toEqual({ n: 0 });
    });
  });
});
