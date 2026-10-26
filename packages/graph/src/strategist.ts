/**
 * Persistent slow-layer (Strategist/reason) trigger state.
 *
 * The scheduler keeps a per-project watermark of the graph it last reasoned about, plus
 * attempt/failure timestamps for cooldown and backoff. This is sidecar data: it never
 * enters the Cairn graph, YAML export, or worker contracts. Keeping it in SQLite means a
 * control-plane restart does not re-run reason for an unchanged graph.
 */

import type { Database } from "bun:sqlite";

import { all, get, run } from "./db";
import type { StrategistRunSummary, StrategistState } from "./models";
import { utcnow } from "./services";

interface StrategistStateRow {
  project_id: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_failure_at: string | null;
  last_trigger: string | null;
  last_run_id: string | null;
  last_fact_count: number;
  last_hint_count: number;
  last_open_intent_count: number;
  updated_at: string;
}

interface StrategistRunRow {
  id: string;
  kind: string;
  outcome: string | null;
  started_at: string;
  finished_at: string;
  produced_fact: number;
}

export function getStrategistState(
  conn: Database,
  projectId: string,
): StrategistState | null {
  const row = get<StrategistStateRow>(
    conn,
    "SELECT * FROM strategist_state WHERE project_id = ?",
    projectId,
  );
  if (row === null) return null;
  return {
    project_id: row.project_id,
    last_success_at: row.last_success_at,
    last_attempt_at: row.last_attempt_at,
    last_failure_at: row.last_failure_at,
    last_trigger: row.last_trigger,
    last_run_id: row.last_run_id,
    last_fact_count: row.last_fact_count,
    last_hint_count: row.last_hint_count,
    last_open_intent_count: row.last_open_intent_count,
    updated_at: row.updated_at,
  };
}

export interface RecordStrategistSuccessInput {
  projectId: string;
  runId: string;
  trigger: string;
  factCount: number;
  hintCount: number;
  openIntentCount: number;
  at?: string;
}

/**
 * Advances the watermarks after a successful/noop reason turn. A success also clears the
 * failure marker so a later unrelated failure starts a fresh backoff window.
 */
export function recordStrategistSuccess(
  conn: Database,
  input: RecordStrategistSuccessInput,
): void {
  const at = input.at ?? utcnow();
  run(
    conn,
    `
    INSERT INTO strategist_state
        (project_id, last_success_at, last_attempt_at, last_failure_at, last_trigger,
         last_run_id, last_fact_count, last_hint_count, last_open_intent_count, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
        last_success_at = excluded.last_success_at,
        last_attempt_at = excluded.last_attempt_at,
        last_failure_at = NULL,
        last_trigger = excluded.last_trigger,
        last_run_id = excluded.last_run_id,
        last_fact_count = excluded.last_fact_count,
        last_hint_count = excluded.last_hint_count,
        last_open_intent_count = excluded.last_open_intent_count,
        updated_at = excluded.updated_at
    `,
    input.projectId,
    at,
    at,
    input.trigger,
    input.runId,
    input.factCount,
    input.hintCount,
    input.openIntentCount,
    at,
  );
}

export interface RecordStrategistFailureInput {
  projectId: string;
  runId: string;
  trigger: string;
  at?: string;
}

/**
 * Records a failed attempt without advancing the graph watermarks: the next eligible
 * trigger must still see the same unprocessed delta.
 */
export function recordStrategistFailure(
  conn: Database,
  input: RecordStrategistFailureInput,
): void {
  const at = input.at ?? utcnow();
  run(
    conn,
    `
    INSERT INTO strategist_state
        (project_id, last_attempt_at, last_failure_at, last_trigger, last_run_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        last_failure_at = excluded.last_failure_at,
        last_trigger = excluded.last_trigger,
        last_run_id = excluded.last_run_id,
        updated_at = excluded.updated_at
    `,
    input.projectId,
    at,
    at,
    input.trigger,
    input.runId,
    at,
  );
}

/**
 * Finished explore/conclude/bootstrap runs, newest first, with whether the run produced
 * a fact. Reason runs are excluded: they intentionally do not write facts.
 */
export function listRecentStrategistRuns(
  conn: Database,
  projectId: string,
  limit: number,
): StrategistRunSummary[] {
  if (limit <= 0) return [];
  const rows = all<StrategistRunRow>(
    conn,
    `
    SELECT r.id, r.kind, r.outcome, r.started_at, r.finished_at,
           EXISTS(SELECT 1 FROM fact_meta m WHERE m.run_id = r.id) AS produced_fact
    FROM runs r
    WHERE r.project_id = ?
      AND r.kind IN ('bootstrap', 'explore', 'conclude')
      AND r.finished_at IS NOT NULL
    ORDER BY r.finished_at DESC, r.id DESC
    LIMIT ?
    `,
    projectId,
    limit,
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    outcome: row.outcome as StrategistRunSummary["outcome"],
    started_at: row.started_at,
    finished_at: row.finished_at,
    produced_fact: Number(row.produced_fact) === 1,
  }));
}

/** Number of reason runs started since an ISO timestamp (inclusive). */
export function countReasonRunsSince(
  conn: Database,
  projectId: string,
  since: string,
): number {
  const row = get<{ count: number }>(
    conn,
    `
    SELECT COUNT(*) AS count
    FROM runs
    WHERE project_id = ? AND kind = 'reason' AND started_at >= ?
    `,
    projectId,
    since,
  );
  return Number(row?.count ?? 0);
}
