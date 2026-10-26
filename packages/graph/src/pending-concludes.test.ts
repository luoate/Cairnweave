import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HttpError,
  configureDatabase,
  createProject,
  deletePendingConclude,
  getPendingConclude,
  hasPendingConclude,
  isPendingConcludeSession,
  listPendingConcludes,
  recordPendingConclude,
  type CairnDatabase,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-pending-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "pending",
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

function queue(overrides: Partial<Parameters<typeof recordPendingConclude>[1]> = {}): void {
  db.withConn((conn) =>
    recordPendingConclude(conn, {
      projectId,
      intentId: "i001",
      phase: "explore",
      session: ".cairn/sessions/explore-1",
      createdAt: "2026-01-02T03:00:00Z",
      ...overrides,
    }),
  );
}

describe("pending concludes", () => {
  test("records, lists and returns the oldest entry", () => {
    queue({ intentId: "i002", session: ".cairn/sessions/explore-2", createdAt: "2026-01-02T03:00:02Z" });
    queue({ intentId: "i001", phase: "bootstrap", createdAt: "2026-01-02T03:00:01Z" });

    expect(db.withConn((conn) => listPendingConcludes(conn, projectId))).toEqual([
      {
        project_id: projectId,
        intent_id: "i001",
        phase: "bootstrap",
        session: ".cairn/sessions/explore-1",
        worker_profile: null,
        created_at: "2026-01-02T03:00:01Z",
      },
      {
        project_id: projectId,
        intent_id: "i002",
        phase: "explore",
        session: ".cairn/sessions/explore-2",
        worker_profile: null,
        created_at: "2026-01-02T03:00:02Z",
      },
    ]);
    expect(db.withConn((conn) => getPendingConclude(conn, projectId))?.intent_id).toBe(
      "i001",
    );
  });

  test("is idempotent per intent and keeps the first session", () => {
    queue();
    queue({ phase: "bootstrap", session: ".cairn/sessions/other" });
    const rows = db.withConn((conn) => listPendingConcludes(conn, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      intent_id: "i001",
      phase: "explore",
      session: ".cairn/sessions/explore-1",
    });
  });

  test("keeps the dispatch profile for the conclude turn", () => {
    queue({ workerProfile: "alpha" });
    expect(db.withConn((conn) => listPendingConcludes(conn, projectId))[0]).toMatchObject({
      intent_id: "i001",
      worker_profile: "alpha",
    });
  });

  test("tracks presence and retained sessions", () => {
    queue();
    expect(db.withConn((conn) => hasPendingConclude(conn, projectId, "i001"))).toBe(true);
    expect(db.withConn((conn) => hasPendingConclude(conn, projectId, "i002"))).toBe(false);
    expect(
      db.withConn((conn) =>
        isPendingConcludeSession(conn, projectId, ".cairn/sessions/explore-1"),
      ),
    ).toBe(true);
    expect(
      db.withConn((conn) =>
        isPendingConcludeSession(conn, projectId, ".cairn/sessions/explore-2"),
      ),
    ).toBe(false);

    db.withConn((conn) => deletePendingConclude(conn, projectId, "i001"));
    expect(db.withConn((conn) => hasPendingConclude(conn, projectId, "i001"))).toBe(false);
    expect(db.withConn((conn) => listPendingConcludes(conn, projectId))).toEqual([]);
  });

  test("404s for an unknown project", () => {
    expect(() => db.withConn((conn) => listPendingConcludes(conn, "proj_999"))).toThrow(
      HttpError,
    );
    expect(() => db.withConn((conn) => getPendingConclude(conn, "proj_999"))).toThrow(
      HttpError,
    );
    expect(() => db.withConn((conn) => hasPendingConclude(conn, "proj_999", "i001"))).toThrow(
      HttpError,
    );
  });

  test("cascades when the project is deleted", () => {
    queue();
    db.withConn((conn) => {
      conn.query("DELETE FROM projects WHERE id = ?").run(projectId);
      expect(conn.query("SELECT COUNT(*) AS n FROM pending_concludes").get()).toEqual({
        n: 0,
      });
    });
  });
});
