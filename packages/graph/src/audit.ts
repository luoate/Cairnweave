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
import { HttpError } from "./errors";
import { getProjectOr404, utcnow } from "./services";

export const AUDIT_GENESIS_HASH = "0".repeat(64);

/**
 * One event's compact JSON text. Shared by the live HTTP append and the finish-time
 * `audit.jsonl` import so both paths accept exactly the same events.
 */
export const MAX_AUDIT_EVENT_TEXT_CHARS = 16_384;

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
    throw new HttpError(400, "audit event must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function eventText(value: unknown): string {
  const text = JSON.stringify(requireEventObject(value));
  // The compact form is never longer than the JSON line it came from, so this bound is
  // also what the scheduler's line cap enforces at import time.
  if (text.length > MAX_AUDIT_EVENT_TEXT_CHARS) {
    throw new HttpError(
      400,
      `audit event is too large (max ${MAX_AUDIT_EVENT_TEXT_CHARS} characters)`,
    );
  }
  return text;
}

export interface AuditEntry {
  /** 1-based position in the task's event stream. */
  seq: number;
  event: unknown;
}

export interface AppendTaskAuditInput {
  projectId: string;
  taskId: string;
  entries: readonly AuditEntry[];
  createdAt?: string;
  /**
   * `throw` rejects gaps and conflicts (live stream). `stop` keeps the recorded prefix
   * and reports what was appended; the finish-time file import must never fault.
   */
  onConflict?: "throw" | "stop";
}

export interface AppendTaskAuditResult {
  /** Entries written by this call. */
  recorded: number;
  /** Entries that already existed with identical content (retry or live/file overlap). */
  duplicates: number;
  /** Null when nothing new was appended. */
  summary: AuditTaskSummary | null;
}

interface AuditTailRow {
  seq: number;
  hash: string;
  created_at: string;
}

/**
 * Appends explicit sequence numbers so the live stream and the finish-time import can
 * share one chain. A retry is idempotent when the event text matches; anything else that
 * would fork or gap the chain is rejected.
 */
export function appendTaskAudit(
  conn: Database,
  input: AppendTaskAuditInput,
): AppendTaskAuditResult {
  getProjectOr404(conn, input.projectId);
  if (input.entries.length === 0) {
    return { recorded: 0, duplicates: 0, summary: null };
  }

  const tail = get<AuditTailRow>(
    conn,
    `SELECT seq, hash, created_at FROM audit_events
     WHERE project_id = ? AND task_id = ?
     ORDER BY seq DESC LIMIT 1`,
    input.projectId,
    input.taskId,
  );
  const head = get<{ created_at: string }>(
    conn,
    `SELECT created_at FROM audit_events
     WHERE project_id = ? AND task_id = ?
     ORDER BY seq ASC LIMIT 1`,
    input.projectId,
    input.taskId,
  );

  const stopOnConflict = input.onConflict === "stop";
  const createdAt = input.createdAt ?? utcnow();
  let maxSeq = tail?.seq ?? 0;
  let lastHash = tail?.hash ?? AUDIT_GENESIS_HASH;
  let recorded = 0;
  let duplicates = 0;

  const result = (): AppendTaskAuditResult => ({
    recorded,
    duplicates,
    summary:
      recorded === 0
        ? null
        : {
            task_id: input.taskId,
            event_count: maxSeq,
            root_hash: lastHash,
            first_at: head?.created_at ?? createdAt,
            last_at: createdAt,
          },
  });

  const conflict = (message: string): AppendTaskAuditResult => {
    if (!stopOnConflict) throw new HttpError(409, message);
    return result();
  };

  for (const entry of input.entries) {
    if (!Number.isInteger(entry.seq) || entry.seq <= 0) {
      throw new HttpError(400, "audit seq must be a positive integer");
    }
    const text = eventText(entry.event);

    if (entry.seq <= maxSeq) {
      const existing = get<{ event: string }>(
        conn,
        `SELECT event FROM audit_events
         WHERE project_id = ? AND task_id = ? AND seq = ?`,
        input.projectId,
        input.taskId,
        entry.seq,
      );
      if (existing !== null && existing.event === text) {
        duplicates += 1;
        continue;
      }
      return conflict(
        `audit seq ${entry.seq} conflicts with the recorded chain`,
      );
    }
    if (entry.seq !== maxSeq + 1) {
      return conflict(
        `audit seq ${entry.seq} is out of order; expected ${maxSeq + 1}`,
      );
    }

    const hash = auditEventHash(
      input.projectId,
      input.taskId,
      entry.seq,
      lastHash,
      text,
    );
    run(
      conn,
      `INSERT INTO audit_events (project_id, task_id, seq, event, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.projectId,
      input.taskId,
      entry.seq,
      text,
      lastHash,
      hash,
      createdAt,
    );
    maxSeq = entry.seq;
    lastHash = hash;
    recorded += 1;
  }

  return result();
}

/**
 * Finish-path entry point: imports a whole file in order. Empty input, an already
 * recorded task and conflicting content are no-ops, so a retry cannot fork the chain.
 * A partial live stream is completed instead of being treated as "already imported".
 */
export function recordTaskAudit(
  conn: Database,
  input: RecordTaskAuditInput,
): AuditTaskSummary | null {
  if (input.events.length === 0) return null;
  const entries = input.events.map((event, index) => ({
    seq: index + 1,
    event,
  }));
  return appendTaskAudit(conn, {
    projectId: input.projectId,
    taskId: input.taskId,
    entries,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    onConflict: "stop",
  }).summary;
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
