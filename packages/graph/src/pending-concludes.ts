/**
 * Conclude tasks queued after a failed execute attempt. The scheduler keeps the failed
 * task's lease and session directory so a follow-up conclude can salvage the turn; this
 * sidecar table makes that queue survive a control-plane restart.
 *
 * `session` is workspace-relative and forward-slash separated, so the scheduler rebuilds
 * the host path from the current workspace root instead of storing a machine path.
 */

import type { Database } from "bun:sqlite";

import { all, get, run } from "./db";
import { getProjectOr404, utcnow } from "./services";

export type PendingConcludePhase = "bootstrap" | "explore";

export interface PendingConcludeRow {
  project_id: string;
  intent_id: string;
  phase: PendingConcludePhase;
  session: string;
  created_at: string;
}

export interface RecordPendingConcludeInput {
  projectId: string;
  intentId: string;
  phase: PendingConcludePhase;
  session: string;
  createdAt?: string;
}

/** Idempotent per (project, intent): a repeated failure does not reset the queued phase. */
export function recordPendingConclude(
  conn: Database,
  input: RecordPendingConcludeInput,
): void {
  getProjectOr404(conn, input.projectId);
  run(
    conn,
    `INSERT OR IGNORE INTO pending_concludes
        (project_id, intent_id, phase, session, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    input.projectId,
    input.intentId,
    input.phase,
    input.session,
    input.createdAt ?? utcnow(),
  );
}

export function hasPendingConclude(
  conn: Database,
  projectId: string,
  intentId: string,
): boolean {
  getProjectOr404(conn, projectId);
  return (
    get<{ intent_id: string }>(
      conn,
      "SELECT intent_id FROM pending_concludes WHERE project_id = ? AND intent_id = ?",
      projectId,
      intentId,
    ) !== null
  );
}

/** Oldest queued conclude for a project; the scheduler dispatches it before new work. */
export function getPendingConclude(
  conn: Database,
  projectId: string,
): PendingConcludeRow | null {
  getProjectOr404(conn, projectId);
  return get<PendingConcludeRow>(
    conn,
    `SELECT project_id, intent_id, phase, session, created_at
     FROM pending_concludes
     WHERE project_id = ?
     ORDER BY created_at, intent_id
     LIMIT 1`,
    projectId,
  );
}

export function listPendingConcludes(
  conn: Database,
  projectId: string,
): PendingConcludeRow[] {
  getProjectOr404(conn, projectId);
  return all<PendingConcludeRow>(
    conn,
    `SELECT project_id, intent_id, phase, session, created_at
     FROM pending_concludes
     WHERE project_id = ?
     ORDER BY created_at, intent_id`,
    projectId,
  );
}

export function deletePendingConclude(
  conn: Database,
  projectId: string,
  intentId: string,
): void {
  run(
    conn,
    "DELETE FROM pending_concludes WHERE project_id = ? AND intent_id = ?",
    projectId,
    intentId,
  );
}

/** True while a queued conclude still needs the retained session directory. */
export function isPendingConcludeSession(
  conn: Database,
  projectId: string,
  session: string,
): boolean {
  return (
    get<{ intent_id: string }>(
      conn,
      "SELECT intent_id FROM pending_concludes WHERE project_id = ? AND session = ? LIMIT 1",
      projectId,
      session,
    ) !== null
  );
}
