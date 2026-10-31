/**
 * Operator flag reviews.
 *
 * A worker writing a flag-shaped value is a claim like any other. When manual review is on,
 * the scheduler records one pending row per distinct value and stops dispatching the
 * project until an operator answers:
 *
 * - `real_more`: the value is real, more flags remain, keep exploring.
 * - `real_done`: the value is real and the project should stop here.
 * - `fake`: the value is a decoy, keep exploring.
 *
 * The rows are sidecar data; the Cairn graph export is unchanged. A repeated sighting of
 * the same value never queues a second decision, so a decoy cannot keep re-pausing work.
 */

import type { Database } from "bun:sqlite";

import { all, get, run } from "./db";
import { HttpError } from "./errors";
import type {
  FlagReview,
  FlagReviewDecision,
  FlagReviewStatus,
  FlagReviewSummary,
} from "./models";
import { getProjectOr404, utcnow } from "./services";

export interface RecordFlagReviewInput {
  flag: string;
  factId?: string | null;
  runId?: string | null;
  createdAt?: string;
}

interface FlagReviewRow {
  id: number;
  project_id: string;
  fact_id: string | null;
  run_id: string | null;
  flag: string;
  status: string;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

const STATUSES: readonly FlagReviewStatus[] = [
  "pending",
  "real_more",
  "real_done",
  "fake",
  "dismissed",
];

/** Inserts a pending review unless this project already recorded the same value. */
export function recordFlagReview(
  conn: Database,
  projectId: string,
  input: RecordFlagReviewInput,
): { review: FlagReview; created: boolean } {
  getProjectOr404(conn, projectId);
  const flag = input.flag.trim();
  if (flag === "") throw new HttpError(400, "flag review requires a non-empty flag");
  const inserted = conn
    .query(
      `INSERT OR IGNORE INTO flag_reviews
         (project_id, fact_id, run_id, flag, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .run(projectId, input.factId ?? null, input.runId ?? null, flag, input.createdAt ?? utcnow());
  const review = getFlagReviewByValue(conn, projectId, flag);
  if (review === null) throw new Error("flag review was not stored");
  return { review, created: inserted.changes > 0 };
}

export function listFlagReviews(
  conn: Database,
  projectId: string,
  limit = 100,
): FlagReview[] {
  getProjectOr404(conn, projectId);
  return all<FlagReviewRow>(
    conn,
    `SELECT * FROM flag_reviews
     WHERE project_id = ?
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC
     LIMIT ?`,
    projectId,
    Math.max(1, Math.min(limit, 500)),
  ).map(reviewFromRow);
}

export function listPendingFlagReviews(conn: Database, projectId: string): FlagReview[] {
  getProjectOr404(conn, projectId);
  return all<FlagReviewRow>(
    conn,
    `SELECT * FROM flag_reviews
     WHERE project_id = ? AND status = 'pending'
     ORDER BY id`,
    projectId,
  ).map(reviewFromRow);
}

export function getFlagReview(
  conn: Database,
  projectId: string,
  id: number,
): FlagReview {
  getProjectOr404(conn, projectId);
  const row = get<FlagReviewRow>(
    conn,
    "SELECT * FROM flag_reviews WHERE project_id = ? AND id = ?",
    projectId,
    id,
  );
  if (row === null) throw new HttpError(404, "flag review not found");
  return reviewFromRow(row);
}

export function hasPendingFlagReviews(conn: Database, projectId: string): boolean {
  getProjectOr404(conn, projectId);
  return (
    get<{ id: number }>(
      conn,
      "SELECT id FROM flag_reviews WHERE project_id = ? AND status = 'pending' LIMIT 1",
      projectId,
    ) !== null
  );
}

/**
 * Applies an operator decision. Only a pending review can be decided; `real_done` also
 * dismisses sibling pending reviews because the project is stopping on this flag.
 */
export function decideFlagReview(
  conn: Database,
  projectId: string,
  id: number,
  decision: FlagReviewDecision,
  note?: string | null,
): { review: FlagReview; dismissed: number } {
  if (!(["real_more", "real_done", "fake"] as const).includes(decision)) {
    throw new HttpError(400, "decision must be real_more, real_done or fake");
  }
  const current = getFlagReview(conn, projectId, id);
  if (current.status !== "pending") {
    throw new HttpError(409, `flag review is already ${current.status}`);
  }
  const now = utcnow();
  run(
    conn,
    `UPDATE flag_reviews
       SET status = ?, note = ?, decided_at = ?
     WHERE project_id = ? AND id = ? AND status = 'pending'`,
    decision,
    note?.trim() || null,
    now,
    projectId,
    id,
  );
  const dismissed =
    decision === "real_done" ? dismissPendingFlagReviews(conn, projectId, id, now) : 0;
  return { review: getFlagReview(conn, projectId, id), dismissed };
}

/** Closes remaining pending reviews after an operator stops the project. */
export function dismissPendingFlagReviews(
  conn: Database,
  projectId: string,
  exceptId?: number,
  at?: string,
): number {
  const result = conn
    .query(
      `UPDATE flag_reviews
         SET status = 'dismissed', decided_at = ?
       WHERE project_id = ? AND status = 'pending' AND id <> ?`,
    )
    .run(at ?? utcnow(), projectId, exceptId ?? -1);
  return result.changes;
}

export function listRejectedFlags(conn: Database, projectId: string): string[] {
  return all<{ flag: string }>(
    conn,
    "SELECT flag FROM flag_reviews WHERE project_id = ? AND status = 'fake' ORDER BY id",
    projectId,
  ).map((row) => row.flag);
}

export function listVerifiedFlags(conn: Database, projectId: string): string[] {
  return all<{ flag: string }>(
    conn,
    `SELECT flag FROM flag_reviews
     WHERE project_id = ? AND status IN ('real_more', 'real_done')
     ORDER BY id`,
    projectId,
  ).map((row) => row.flag);
}

/** Pending work plus the operator's verdicts, for the project view and `/flag`. */
export function summarizeFlagReviews(
  conn: Database,
  projectId: string,
): FlagReviewSummary {
  getProjectOr404(conn, projectId);
  const rows = all<{ status: string; total: number }>(
    conn,
    "SELECT status, COUNT(*) AS total FROM flag_reviews WHERE project_id = ? GROUP BY status",
    projectId,
  );
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
    FlagReviewStatus,
    number
  >;
  for (const row of rows) {
    const status = normalizeStatus(row.status);
    counts[status] = row.total;
  }
  return {
    pending: listPendingFlagReviews(conn, projectId),
    verified: listVerifiedFlags(conn, projectId),
    rejected: listRejectedFlags(conn, projectId),
    counts,
  };
}

function getFlagReviewByValue(
  conn: Database,
  projectId: string,
  flag: string,
): FlagReview | null {
  const row = get<FlagReviewRow>(
    conn,
    "SELECT * FROM flag_reviews WHERE project_id = ? AND flag = ?",
    projectId,
    flag,
  );
  return row === null ? null : reviewFromRow(row);
}

function reviewFromRow(row: FlagReviewRow): FlagReview {
  return {
    id: row.id,
    project_id: row.project_id,
    fact_id: row.fact_id,
    run_id: row.run_id,
    flag: row.flag,
    status: normalizeStatus(row.status),
    note: row.note,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

function normalizeStatus(value: string): FlagReviewStatus {
  return (STATUSES as readonly string[]).includes(value)
    ? (value as FlagReviewStatus)
    : "pending";
}
