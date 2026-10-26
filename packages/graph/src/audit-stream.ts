/**
 * Visibility for the live audit stream. The worker writes `audit-stream-lost.json` when
 * its bounded sender stops; the control plane imports that marker at task finish so an
 * operator can see that the live ledger may be behind the local audit file. The marker
 * never changes the task outcome, and the finish-time `audit.jsonl` import remains the
 * recovery source.
 */

import type { Database } from "bun:sqlite";

import { all, get, run as runSql } from "./db";
import { HttpError } from "./errors";
import { getProjectOr404, utcnow } from "./services";

export interface AuditStreamLoss {
  task_id: string;
  reason: string;
  delivered: number;
  pending: number;
  reported_at: string | null;
  recorded_at: string;
}

export interface RecordAuditStreamLossInput {
  projectId: string;
  taskId: string;
  reason: string;
  delivered: number;
  pending: number;
  reportedAt?: string | null;
  recordedAt?: string;
}

interface AuditStreamLossRow {
  task_id: string;
  reason: string;
  delivered: number;
  pending: number;
  reported_at: string | null;
  recorded_at: string;
}

export function recordAuditStreamLoss(
  conn: Database,
  input: RecordAuditStreamLossInput,
): AuditStreamLoss {
  getProjectOr404(conn, input.projectId);
  if (input.reason.trim() === "") {
    throw new HttpError(400, "audit stream loss reason must not be empty");
  }
  for (const [name, value] of [
    ["delivered", input.delivered],
    ["pending", input.pending],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new HttpError(400, `audit stream loss ${name} must be a non-negative integer`);
    }
  }

  const reportedAt = input.reportedAt ?? null;
  const recordedAt = input.recordedAt ?? utcnow();
  runSql(
    conn,
    `INSERT INTO audit_stream_lost
       (project_id, task_id, reason, delivered, pending, reported_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, task_id) DO UPDATE SET
       reason = excluded.reason,
       delivered = excluded.delivered,
       pending = excluded.pending,
       reported_at = excluded.reported_at,
       recorded_at = excluded.recorded_at`,
    input.projectId,
    input.taskId,
    input.reason,
    input.delivered,
    input.pending,
    reportedAt,
    recordedAt,
  );

  return {
    task_id: input.taskId,
    reason: input.reason,
    delivered: input.delivered,
    pending: input.pending,
    reported_at: reportedAt,
    recorded_at: recordedAt,
  };
}

export function getAuditStreamLoss(
  conn: Database,
  projectId: string,
  taskId: string,
): AuditStreamLoss | null {
  getProjectOr404(conn, projectId);
  const row = get<AuditStreamLossRow>(
    conn,
    `SELECT task_id, reason, delivered, pending, reported_at, recorded_at
     FROM audit_stream_lost
     WHERE project_id = ? AND task_id = ?`,
    projectId,
    taskId,
  );
  return row === null ? null : toResult(row);
}

export function listProjectAuditStreamLoss(
  conn: Database,
  projectId: string,
): AuditStreamLoss[] {
  getProjectOr404(conn, projectId);
  return all<AuditStreamLossRow>(
    conn,
    `SELECT task_id, reason, delivered, pending, reported_at, recorded_at
     FROM audit_stream_lost
     WHERE project_id = ?
     ORDER BY task_id`,
    projectId,
  ).map(toResult);
}

function toResult(row: AuditStreamLossRow): AuditStreamLoss {
  return {
    task_id: row.task_id,
    reason: row.reason,
    delivered: row.delivered,
    pending: row.pending,
    reported_at: row.reported_at,
    recorded_at: row.recorded_at,
  };
}
