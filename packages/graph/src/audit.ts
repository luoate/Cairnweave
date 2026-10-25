/**
 * Control-plane audit ledger. The worker's Host Bridge writes `audit.jsonl` into its
 * session directory, which is worker-writable and can later be removed by retention.
 * This sidecar imports the events at task finish into a project-scoped, hash-chained
 * table so the trail outlives the session directory and is readable through the API.
 *
 * The chain detects edits/removals inside these rows. It is not a signature: anyone who
 * can rewrite the database can also rebuild the chain, and events never written here
 * (worker crash before finish) are not covered.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { all, get, run } from "./db";
import { getProjectOr404, utcnow } from "./services";

export const AUDIT_GENESIS_HASH = "0".repeat(64);

export interface AuditEvent {
  task_id: string;
  seq: number;
  event: unknown;
  prev_hash: string;
  hash: string;
  created_at: string;
}

export interface AuditTaskSummary {
  task_id: string;
  event_count: number;
  root_hash: string;
  first_at: string;
  last_at: string;
}

export interface TaskAudit {
  task_id: string;
  event_count: number;
  chain_ok: boolean;
  broken_at: number | null;
  root_hash: string | null;
  events: AuditEvent[];
}

export interface RecordTaskAuditInput {
  projectId: string;
  taskId: string;
  events: readonly unknown[];
  createdAt?: string;
}

interface AuditRow {
  task_id: string;
  seq: number;
  event: string;
  prev_hash: string;
  hash: string;
  created_at: string;
}

interface SummaryRow {
  task_id: string;
  event_count: number;
  root_hash: string;
  first_at: string;
  last_at: string;
}

export function auditEventHash(
  projectId: string,
  taskId: string,
  seq: number,
  prevHash: string,
  eventText: string,
): string {
  return createHash("sha256")
    .update(projectId)
    .update("\n")
    .update(taskId)
    .update("\n")
    .update(String(seq))
    .update("\n")
    .update(prevHash)
    .update("\n")
    .update(eventText)
    .digest("hex");
}

function requireEventObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("audit event must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function eventText(value: unknown): string {
  return JSON.stringify(requireEventObject(value));
}

/**
 * Appends one chain for a task. Empty input and an already-recorded task are no-ops and
 * return null, so finish-path retries cannot fork or extend an existing chain.
 */
export function recordTaskAudit(
  conn: Database,
  input: RecordTaskAuditInput,
): AuditTaskSummary | null {
  getProjectOr404(conn, input.projectId);
  if (input.events.length === 0) return null;
  const existing = get<{ seq: number }>(
    conn,
    "SELECT seq FROM audit_events WHERE project_id = ? AND task_id = ? LIMIT 1",
    input.projectId,
    input.taskId,
  );
  if (existing !== null) return null;

  const createdAt = input.createdAt ?? utcnow();
  let prevHash = AUDIT_GENESIS_HASH;
  let seq = 0;
  for (const event of input.events) {
    seq += 1;
    const text = eventText(event);
    const hash = auditEventHash(
      input.projectId,
      input.taskId,
      seq,
      prevHash,
      text,
    );
    run(
      conn,
      `INSERT INTO audit_events (project_id, task_id, seq, event, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.projectId,
      input.taskId,
      seq,
      text,
      prevHash,
      hash,
      createdAt,
    );
    prevHash = hash;
  }

  return {
    task_id: input.taskId,
    event_count: seq,
    root_hash: prevHash,
    first_at: createdAt,
    last_at: createdAt,
  };
}

export function listProjectAudit(
  conn: Database,
  projectId: string,
): AuditTaskSummary[] {
  getProjectOr404(conn, projectId);
  return all<SummaryRow>(
    conn,
    `SELECT a.task_id,
            COUNT(*) AS event_count,
            (SELECT b.hash FROM audit_events b
              WHERE b.project_id = a.project_id AND b.task_id = a.task_id
              ORDER BY b.seq DESC LIMIT 1) AS root_hash,
            MIN(a.created_at) AS first_at,
            MAX(a.created_at) AS last_at
     FROM audit_events a
     WHERE a.project_id = ?
     GROUP BY a.task_id
     ORDER BY a.task_id`,
    projectId,
  );
}

/**
 * Returns the stored chain and re-derives every hash from the raw event text. `broken_at`
 * is the first sequence number whose link or hash does not match.
 */
export function getTaskAudit(
  conn: Database,
  projectId: string,
  taskId: string,
): TaskAudit {
  getProjectOr404(conn, projectId);
  const rows = all<AuditRow>(
    conn,
    `SELECT task_id, seq, event, prev_hash, hash, created_at
     FROM audit_events
     WHERE project_id = ? AND task_id = ?
     ORDER BY seq`,
    projectId,
    taskId,
  );

  let prevHash = AUDIT_GENESIS_HASH;
  let expectedSeq = 1;
  let brokenAt: number | null = null;
  for (const row of rows) {
    const expected = auditEventHash(
      projectId,
      taskId,
      row.seq,
      prevHash,
      row.event,
    );
    if (row.seq !== expectedSeq || row.prev_hash !== prevHash || row.hash !== expected) {
      brokenAt = row.seq;
      break;
    }
    prevHash = row.hash;
    expectedSeq += 1;
  }

  return {
    task_id: taskId,
    event_count: rows.length,
    chain_ok: brokenAt === null,
    broken_at: brokenAt,
    root_hash: rows.length === 0 ? null : rows[rows.length - 1]!.hash,
    events: rows.map((row) => ({
      task_id: row.task_id,
      seq: row.seq,
      event: parseEvent(row.event),
      prev_hash: row.prev_hash,
      hash: row.hash,
      created_at: row.created_at,
    })),
  };
}

function parseEvent(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
