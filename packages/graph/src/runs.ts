/**
 * Runs and fact evidence are sidecar tables. They deliberately live outside the graph's
 * `facts`/`intents` shape so YAML exports and the Cairn HTTP contract stay unchanged.
 */

import type { Database } from "bun:sqlite";

import { all, get, run as runSql } from "./db";
import type { EvidenceStatus, FactMeta, Run, RunOutcome } from "./models";
import { getProjectOr404, utcnow } from "./services";

export interface StartRunInput {
  id: string;
  projectId: string;
  taskId: string;
  kind: string;
  intentId?: string | null;
  worker: string;
  trigger?: string | null;
  startedAt: string;
  session?: string | null;
}

export function startRun(conn: Database, input: StartRunInput): void {
  runSql(
    conn,
    `
    INSERT INTO runs (id, project_id, task_id, kind, intent_id, worker, trigger, started_at, session)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.id,
    input.projectId,
    input.taskId,
    input.kind,
    input.intentId ?? null,
    input.worker,
    input.trigger ?? null,
    input.startedAt,
    input.session ?? null,
  );
}

export interface FinishRunInput {
  outcome: RunOutcome;
  finishedAt: string;
  durationMs: number;
  exitCode?: number | null;
  evidenceCount?: number;
  detail?: string | null;
}

export function finishRun(conn: Database, runId: string, input: FinishRunInput): void {
  runSql(
    conn,
    `
    UPDATE runs
    SET outcome = ?, finished_at = ?, duration_ms = ?, exit_code = ?, evidence_count = ?, detail = ?
    WHERE id = ?
    `,
    input.outcome,
    input.finishedAt,
    input.durationMs,
    input.exitCode ?? null,
    input.evidenceCount ?? 0,
    input.detail ?? null,
    runId,
  );
}

export function listProjectRuns(conn: Database, projectId: string): Run[] {
  getProjectOr404(conn, projectId);
  const rows = all<RunRow>(
    conn,
    "SELECT * FROM runs WHERE project_id = ? ORDER BY started_at, id",
    projectId,
  );
  return rows.map(runFromRow);
}

export interface RecordFactMetaInput {
  projectId: string;
  factId: string;
  runId?: string | null;
  evidenceRefs?: readonly string[];
  evidenceStatus: "provided" | "missing";
  createdAt?: string;
}

export function recordFactMeta(conn: Database, input: RecordFactMetaInput): void {
  runSql(
    conn,
    `
    INSERT OR REPLACE INTO fact_meta
        (fact_id, project_id, run_id, evidence_refs, evidence_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    `,
    input.factId,
    input.projectId,
    input.runId ?? null,
    JSON.stringify([...(input.evidenceRefs ?? [])]),
    input.evidenceStatus,
    input.createdAt ?? utcnow(),
  );
}

/**
 * Metadata for an existing fact. Facts written before M5a (origin/goal and legacy rows)
 * have no sidecar row; they report `legacy` with a null run so callers can still audit
 * coverage. Unknown facts return null (the route maps that to 404).
 */
export function getFactMeta(
  conn: Database,
  projectId: string,
  factId: string,
): FactMeta | null {
  const fact = get<{ id: string }>(
    conn,
    "SELECT id FROM facts WHERE id = ? AND project_id = ?",
    factId,
    projectId,
  );
  if (fact === null) return null;

  const row = get<FactMetaRow>(
    conn,
    "SELECT * FROM fact_meta WHERE fact_id = ? AND project_id = ?",
    factId,
    projectId,
  );
  if (row === null) {
    return {
      fact_id: factId,
      run_id: null,
      evidence_refs: [],
      evidence_status: "legacy",
      created_at: null,
    };
  }
  return factMetaFromRow(row);
}

interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  kind: string;
  intent_id: string | null;
  worker: string;
  trigger: string | null;
  outcome: string | null;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  session: string | null;
  evidence_count: number;
  detail: string | null;
}

interface FactMetaRow {
  fact_id: string;
  project_id: string;
  run_id: string | null;
  evidence_refs: string;
  evidence_status: string;
  created_at: string;
}

function runFromRow(row: RunRow): Run {
  return {
    id: row.id,
    project_id: row.project_id,
    task_id: row.task_id,
    kind: row.kind,
    intent_id: row.intent_id,
    worker: row.worker,
    trigger: row.trigger,
    outcome: row.outcome === null ? null : (row.outcome as RunOutcome),
    exit_code: row.exit_code,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    session: row.session,
    evidence_count: row.evidence_count,
    detail: row.detail,
  };
}

function factMetaFromRow(row: FactMetaRow): FactMeta {
  return {
    fact_id: row.fact_id,
    run_id: row.run_id,
    evidence_refs: parseEvidenceRefs(row.evidence_refs),
    evidence_status: row.evidence_status as EvidenceStatus,
    created_at: row.created_at,
  };
}

function parseEvidenceRefs(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : [];
  } catch {
    return [];
  }
}
