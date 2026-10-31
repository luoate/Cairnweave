import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createIntent,
  createProject,
  getIntentMeta,
  listProjectIntentMeta,
  recordIntentMeta,
  setIntentStatus,
  type CairnDatabase,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-intent-lifecycle-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "lifecycle",
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

function openIntent(description: string): string {
  return db.withConn(
    (conn) =>
      createIntent(conn, projectId, {
        from: ["origin"],
        description,
        creator: "tester",
        worker: null,
      }).id,
  );
}

describe("intent lifecycle sidecar", () => {
  test("abandons a manual intent that has no metadata row", () => {
    const intentId = openIntent("dead end");
    expect(db.withConn((conn) => getIntentMeta(conn, projectId, intentId))).toBeNull();

    const meta = db.withConn((conn) =>
      setIntentStatus(conn, {
        projectId,
        intentId,
        status: "abandoned",
        reason: "two attempts produced nothing",
        by: "operator",
        at: "2026-10-31T10:00:00Z",
      }),
    );

    expect(meta).toMatchObject({
      intent_id: intentId,
      status: "abandoned",
      status_reason: "two attempts produced nothing",
      status_by: "operator",
      status_at: "2026-10-31T10:00:00Z",
      priority: null,
      budget: null,
    });
  });

  test("preserves priority and budget when abandoning", () => {
    const intentId = openIntent("budgeted direction");
    db.withConn((conn) =>
      recordIntentMeta(conn, {
        projectId,
        intentId,
        source: "strategist",
        priority: 80,
        budget: JSON.stringify({ max_seconds: 120 }),
      }),
    );

    db.withConn((conn) =>
      setIntentStatus(conn, {
        projectId,
        intentId,
        status: "abandoned",
        reason: "no login form",
        by: "reason",
      }),
    );

    const meta = db.withConn((conn) => getIntentMeta(conn, projectId, intentId));
    expect(meta).toMatchObject({
      priority: 80,
      budget: { max_seconds: 120 },
      status: "abandoned",
      status_by: "reason",
    });
  });

  test("re-recording metadata does not clear an abandonment", () => {
    const intentId = openIntent("direction");
    db.withConn((conn) =>
      setIntentStatus(conn, {
        projectId,
        intentId,
        status: "abandoned",
        reason: "refuted by a later fact",
        by: "reason",
      }),
    );

    db.withConn((conn) =>
      recordIntentMeta(conn, {
        projectId,
        intentId,
        source: "strategist",
        priority: 95,
      }),
    );

    const meta = db.withConn((conn) => getIntentMeta(conn, projectId, intentId));
    expect(meta).toMatchObject({
      priority: 95,
      status: "abandoned",
      status_reason: "refuted by a later fact",
    });
  });

  test("defaults to open and rejects unknown intents", () => {
    const intentId = openIntent("fresh");
    db.withConn((conn) =>
      recordIntentMeta(conn, { projectId, intentId, source: "strategist" }),
    );
    expect(
      db.withConn((conn) => listProjectIntentMeta(conn, projectId))[0]?.status,
    ).toBe("open");

    expect(() =>
      db.withConn((conn) =>
        setIntentStatus(conn, {
          projectId,
          intentId: "i999",
          status: "abandoned",
          reason: "missing",
          by: "operator",
        }),
      ),
    ).toThrow("Intent not found");
  });
});
