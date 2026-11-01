/**
 * Operator review of completion claims when no automatic oracle applies.
 *
 * `verification: off` means the control plane cannot confirm the goal itself. A worker's
 * `complete` payload is therefore a request, not a decision: the scheduler stores one
 * pending review per project and keeps the project active until an operator approves or
 * rejects it. Repeated claims update the pending row instead of piling up.
 *
 * These rows are sidecar data; the Cairn graph export is unchanged.
 */

import type { Database } from "bun:sqlite";

import { all, get, run } from "./db";
import { HttpError } from "./errors";
import type {
  CompletionReview,
  CompletionReviewDecision,
  CompletionReviewStatus,
  CompletionReviewSummary,
} from "./models";
import { getProjectOr404, utcnow } from "./services";

export interface RecordCompletionReviewInput {
  runId?: string | null;
  taskId?: string | null;
  kind: string;
  description: string;
  fromFacts: readonly string[];
  createdAt?: string;
}

interface CompletionReviewRow {
  id: number;
  project_id: string;
  run_id: string | null;
  task_id: string | null;
  kind: string;
  description: string;
  from_facts: string;
  status: string;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

const STATUSES: readonly CompletionReviewStatus[] = ["pending", "approved", "rejected"];

/**
 * Inserts or refreshes the single pending review for the project. The partial unique
 * index makes the database, not a read-then-write check, enforce "one pending row".
 */
export function recordCompletionReview(
  conn: Database,
  projectId: string,
  input: RecordCompletionReviewInput,
): { review: CompletionReview; created: boolean } {
  getProjectOr404(conn, projectId);
  const kind = input.kind.trim();
  if (kind === "") {
    throw new HttpError(400, "completion review requires a kind");
  }
  const description = input.description.trim();
  if (description === "") {
    throw new HttpError(400, "completion review requires a description");
  }
  const fromFacts = input.fromFacts.map((factId) => {
    if (typeof factId !== "string" || factId.trim() === "") {
      throw new HttpError(400, "completion review facts must be non-empty ids");
    }
    return factId.trim();
  });
  if (fromFacts.length === 0) {
    throw new HttpError(400, "completion review requires at least one source fact");
  }

  const createdAt = input.createdAt ?? utcnow();
  const inserted = conn
    .query(
      `INSERT OR IGNORE INTO completion_reviews
         (project_id, run_id, task_id, kind, description, from_facts, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      projectId,
      input.runId ?? null,
      input.taskId ?? null,
      kind,
      description,
      JSON.stringify(fromFacts),
      createdAt,
    );

  // A repeated claim refreshes the pending row; the first claim keeps its timestamp.
  run(
    conn,
    `UPDATE completion_reviews
       SET run_id = ?, task_id = ?, kind = ?, description = ?, from_facts = ?
     WHERE project_id = ? AND status = 'pending'`,
    input.runId ?? null,
    input.taskId ?? null,
    kind,
    description,
    JSON.stringify(fromFacts),
    projectId,
  );

  const review = getPendingCompletionReview(conn, projectId);
  if (review === null) throw new Error("completion review was not stored");
  return { review, created: inserted.changes > 0 };
}

export function getPendingCompletionReview(
  conn: Database,
  projectId: string,
): CompletionReview | null {
  const row = get<CompletionReviewRow>(
    conn,
    "SELECT * FROM completion_reviews WHERE project_id = ? AND status = 'pending' LIMIT 1",
    projectId,
  );
  return row === null ? null : reviewFromRow(row);
}

export function getCompletionReview(
  conn: Database,
  projectId: string,
  id: number,
): CompletionReview {
  getProjectOr404(conn, projectId);
  const row = get<CompletionReviewRow>(
    conn,
    "SELECT * FROM completion_reviews WHERE project_id = ? AND id = ?",
    projectId,
    id,
  );
  if (row === null) throw new HttpError(404, "completion review not found");
  return reviewFromRow(row);
}

export function listCompletionReviews(
  conn: Database,
  projectId: string,
  limit = 100,
): CompletionReview[] {
  getProjectOr404(conn, projectId);
  return all<CompletionReviewRow>(
    conn,
    `SELECT * FROM completion_reviews
     WHERE project_id = ?
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC
     LIMIT ?`,
    projectId,
    Math.max(1, Math.min(limit, 500)),
  ).map(reviewFromRow);
}

export function summarizeCompletionReviews(
  conn: Database,
  projectId: string,
): CompletionReviewSummary {
  const reviews = listCompletionReviews(conn, projectId);
  return {
    pending: reviews.find((review) => review.status === "pending") ?? null,
    history: reviews.filter((review) => review.status !== "pending"),
  };
}

/** Applies an operator verdict. Only a pending review can be decided. */
export function decideCompletionReview(
  conn: Database,
  projectId: string,
  id: number,
  decision: CompletionReviewDecision,
  note?: string | null,
): CompletionReview {
  if (decision !== "approve" && decision !== "reject") {
    throw new HttpError(400, "decision must be approve or reject");
  }
  const current = getCompletionReview(conn, projectId, id);
  if (current.status !== "pending") {
    throw new HttpError(409, `completion review is already ${current.status}`);
  }
  run(
    conn,
    `UPDATE completion_reviews
       SET status = ?, note = ?, decided_at = ?
     WHERE project_id = ? AND id = ? AND status = 'pending'`,
    decision === "approve" ? "approved" : "rejected",
    note?.trim() || null,
    utcnow(),
    projectId,
    id,
  );
  return getCompletionReview(conn, projectId, id);
}

/**
 * A project can also complete through an operator `/complete`, a confirmed flag, or an
 * automatic oracle. Those paths close any leftover pending review so it cannot be
 * approved later against a different completion.
 */
export function closePendingCompletionReviews(
  conn: Database,
  projectId: string,
  note: string,
  at?: string,
): number {
  return conn
    .query(
      `UPDATE completion_reviews
         SET status = 'approved', note = COALESCE(note, ?), decided_at = ?
       WHERE project_id = ? AND status = 'pending'`,
    )
    .run(note, at ?? utcnow(), projectId).changes;
}

function reviewFromRow(row: CompletionReviewRow): CompletionReview {
  return {
    id: row.id,
    project_id: row.project_id,
    run_id: row.run_id,
    task_id: row.task_id,
    kind: row.kind,
    description: row.description,
    from_facts: parseFacts(row.from_facts),
    status: normalizeStatus(row.status),
    note: row.note,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

function parseFacts(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeStatus(value: string): CompletionReviewStatus {
  return (STATUSES as readonly string[]).includes(value)
    ? (value as CompletionReviewStatus)
    : "pending";
}
