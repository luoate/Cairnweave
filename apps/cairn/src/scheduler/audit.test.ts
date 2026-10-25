import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getTaskAudit,
  listProjectAudit,
  type CairnDatabase,
} from "@cairn/graph";

import {
  MAX_AUDIT_EVENTS,
  ingestTaskAudit,
  type AuditIngestResult,
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
