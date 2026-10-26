import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getAuditStreamLoss,
  getTaskAudit,
  listProjectAudit,
  type CairnDatabase,
} from "@cairn/graph";

import {
  AUDIT_STREAM_LOST_FILE,
  MAX_AUDIT_STREAM_LOST_BYTES,
  MAX_AUDIT_STREAM_LOST_REASON_CHARS,
} from "../audit-stream/constants";
import {
  MAX_AUDIT_EVENTS,
  ingestAuditStreamLoss,
  ingestTaskAudit,
  type AuditIngestResult,
  type AuditStreamLossResult,
} from "./audit";

let directory: string;
let sessionDir: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-ingest-"));
  sessionDir = join(directory, "explore-1");
  mkdirSync(sessionDir, { recursive: true });
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "ingest",
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

function writeAudit(lines: readonly string[]): void {
  writeFileSync(join(sessionDir, "audit.jsonl"), lines.join("\n"), "utf8");
}

function ingest(taskId = "explore-1"): AuditIngestResult {
  return ingestTaskAudit(db, { projectId, taskId, sessionDir });
}

function writeLoss(value: unknown): void {
  writeFileSync(
    join(sessionDir, AUDIT_STREAM_LOST_FILE),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
}

function ingestLoss(taskId = "explore-1"): AuditStreamLossResult {
  return ingestAuditStreamLoss(db, { projectId, taskId, sessionDir });
}

describe("audit ingestion", () => {
  test("records objects, skips malformed lines and preserves the chain", () => {
    writeAudit([
      JSON.stringify({ decision: "allow", tool: "read" }),
      "",
      "not json",
      JSON.stringify({ type: "tool_call", decision: "block" }),
      JSON.stringify("scalar"),
      JSON.stringify([1, 2]),
      JSON.stringify({ oversized: "x".repeat(20_000) }),
      JSON.stringify({ decision: "allow", tool: "write" }),
    ]);

    const result = ingest();
    expect(result).toEqual({
      status: "recorded",
      recorded: 3,
      skipped: 4,
      truncated: false,
    });

    const audit = db.withConn((conn) => getTaskAudit(conn, projectId, "explore-1"));
    expect(audit.chain_ok).toBe(true);
    expect(audit.event_count).toBe(3);
    expect(audit.events.map((row) => row.event)).toEqual([
      { decision: "allow", tool: "read" },
      { type: "tool_call", decision: "block" },
      { decision: "allow", tool: "write" },
    ]);
  });

  test("treats missing or non-file paths as no audit", () => {
    expect(ingest()).toEqual({
      status: "missing",
      recorded: 0,
      skipped: 0,
      truncated: false,
    });

    mkdirSync(join(sessionDir, "audit.jsonl"));
    expect(ingest().status).toBe("unreadable");
  });

  test("does not follow a symlinked audit file", () => {
    const outside = join(directory, "secret.jsonl");
    writeFileSync(outside, `${JSON.stringify({ secret: true })}\n`, "utf8");
    let linked = true;
    try {
      symlinkSync(outside, join(sessionDir, "audit.jsonl"));
    } catch {
      linked = false;
    }
    if (!linked) return;

    expect(ingest().status).toBe("unreadable");
    expect(db.withConn((conn) => listProjectAudit(conn, projectId))).toEqual([]);
  });

  test("caps the number of ingested events", () => {
    const lines = Array.from({ length: MAX_AUDIT_EVENTS + 5 }, (_, index) =>
      JSON.stringify({ index }),
    );
    writeAudit(lines);

    const result = ingest();
    expect(result.status).toBe("recorded");
    expect(result.recorded).toBe(MAX_AUDIT_EVENTS);
    expect(result.truncated).toBe(true);
  }, 30_000);

  test("does not extend an already recorded task", () => {
    writeAudit([JSON.stringify({ index: 1 })]);
    expect(ingest().status).toBe("recorded");
    writeAudit([JSON.stringify({ index: 2 })]);
    expect(ingest()).toEqual({
      status: "existing",
      recorded: 0,
      skipped: 0,
      truncated: false,
    });
    const audit = db.withConn((conn) => getTaskAudit(conn, projectId, "explore-1"));
    expect(audit.event_count).toBe(1);
    expect(audit.events[0]!.event).toEqual({ index: 1 });
  });

  test("reports an empty file without touching the ledger", () => {
    writeFileSync(join(sessionDir, "audit.jsonl"), "", "utf8");
    expect(ingest()).toEqual({
      status: "empty",
      recorded: 0,
      skipped: 0,
      truncated: false,
    });
    expect(db.withConn((conn) => listProjectAudit(conn, projectId))).toEqual([]);
  });
});

describe("audit stream loss ingestion", () => {
  test("records the worker's loss marker", () => {
    writeLoss({
      ts: "2026-01-02T03:04:05.000Z",
      task_id: "explore-1",
      reason: "queue overflow",
      delivered: 7,
      pending: 3,
    });

    const result = ingestLoss();
    expect(result.status).toBe("recorded");
    expect(result.loss).toMatchObject({
      task_id: "explore-1",
      reason: "queue overflow",
      delivered: 7,
      pending: 3,
      reported_at: "2026-01-02T03:04:05.000Z",
    });
    expect(result.loss?.recorded_at).toEqual(expect.any(String));
    expect(
      db.withConn((conn) => getAuditStreamLoss(conn, projectId, "explore-1")),
    ).toEqual(result.loss);
  });

  test("reports a missing marker without creating a row", () => {
    expect(ingestLoss()).toEqual({ status: "missing", loss: null });
    expect(
      db.withConn((conn) => getAuditStreamLoss(conn, projectId, "explore-1")),
    ).toBeNull();
  });

  test("records a generic status for malformed or oversized markers", () => {
    writeLoss("not json");
    const malformed = ingestLoss();
    expect(malformed.status).toBe("invalid");
    expect(malformed.loss).toMatchObject({
      reason: "invalid audit-stream-lost.json",
      delivered: 0,
      pending: 0,
      reported_at: null,
    });

    writeLoss("x".repeat(MAX_AUDIT_STREAM_LOST_BYTES + 1));
    const oversized = ingestLoss();
    expect(oversized.status).toBe("unreadable");
    expect(oversized.loss).toMatchObject({
      reason: "unreadable audit-stream-lost.json",
    });
  });

  test("clamps an oversized reason but keeps the loss visible", () => {
    writeLoss({
      reason: "r".repeat(MAX_AUDIT_STREAM_LOST_REASON_CHARS + 50),
      delivered: 1,
      pending: 1,
    });
    const result = ingestLoss();
    expect(result.status).toBe("recorded");
    expect(result.loss?.reason).toHaveLength(MAX_AUDIT_STREAM_LOST_REASON_CHARS);
  });

  test("does not follow a symlinked marker", () => {
    const outside = join(directory, "outside-loss.json");
    writeFileSync(
      outside,
      JSON.stringify({
        task_id: "explore-1",
        reason: "secret from outside",
        delivered: 9,
        pending: 9,
      }),
      "utf8",
    );
    let linked = true;
    try {
      symlinkSync(outside, join(sessionDir, AUDIT_STREAM_LOST_FILE));
    } catch {
      linked = false;
    }
    if (!linked) return;

    const result = ingestLoss();
    expect(result.status).toBe("unreadable");
    expect(result.loss).toMatchObject({
      reason: "unreadable audit-stream-lost.json",
      delivered: 0,
      pending: 0,
    });
  });
});
