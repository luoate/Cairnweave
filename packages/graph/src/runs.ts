/**
 * Runs and fact evidence are sidecar tables. They deliberately live outside the graph's
 * `facts`/`intents` shape so YAML exports and the Cairn HTTP contract stay unchanged.
 */

import type { Database } from "bun:sqlite";

import { all, get, run as runSql } from "./db";
import type { EvidenceStatus, FactMeta, Run, RunOutcome } from "./models";
import { getProjectOr404, utcnow } from "./services";
import { findSupersedingFact, parseSupersededIds } from "./supersedes";

export interface StartRunInput {
  id: string;
  projectId: string;
  taskId: string;
  kind: string;
  intentId?: string | null;
  worker: string;
  workerProfile?: string | null;
  trigger?: string | null;
  startedAt: string;
  session?: string | null;
}

export function startRun(conn: Database, input: StartRunInput): void {
  runSql(
    conn,
    `
    INSERT INTO runs
        (id, project_id, task_id, kind, intent_id, worker, worker_profile, trigger,
         started_at, session)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.id,
    input.projectId,
    input.taskId,
    input.kind,
    input.intentId ?? null,
    input.worker,
    input.workerProfile ?? null,
    input.trigger ?? null,
    input.startedAt,
    input.session ?? null,
  );
}

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface FinishRunInput {
  outcome: RunOutcome;
  finishedAt: string;
  durationMs: number;
  exitCode?: number | null;
  evidenceCount?: number;
  detail?: string | null;
  usage?: RunUsage | null;
  /** Solver-session `provider/model-id` reported alongside usage (M14c). */
  model?: string | null;
}

export function finishRun(conn: Database, runId: string, input: FinishRunInput): void {
  const usage = input.usage ?? {};
  runSql(
    conn,
    `
    UPDATE runs
    SET outcome = ?, finished_at = ?, duration_ms = ?, exit_code = ?, evidence_count = ?,
        detail = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
        cache_write_tokens = ?, total_tokens = ?, cost_usd = ?, model = ?
    WHERE id = ?
    `,
    input.outcome,
    input.finishedAt,
    input.durationMs,
    input.exitCode ?? null,
    input.evidenceCount ?? 0,
    input.detail ?? null,
    usage.inputTokens ?? 0,
    usage.outputTokens ?? 0,
    usage.cacheReadTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
    usage.totalTokens ?? 0,
    usage.costUsd ?? 0,
    input.model ?? null,
    runId,
  );
}

/** Written into `detail` for every run closed by startup reconciliation (M38). */
export const ORPHAN_RUN_DETAIL = "control plane restarted before finish";

export interface OrphanRun {
  id: string;
  project_id: string;
  task_id: string;
  kind: string;
  started_at: string;
}

/**
 * Closes the runs a previous control plane left open (`outcome IS NULL`) and returns the
 * rows it closed. Only the process that dispatched a task can finish it, and its in-memory
 * task map died with it, so these rows would otherwise count as running forever. `duration_ms`
 * stays null because the real end time is unknown; `finished_at` is the reconcile moment, which
 * is what the read models need. Usage columns keep whatever the crashed task reported.
 * Idempotent: a second pass finds nothing open and closes nothing.
 */
export function reconcileOrphanRuns(
  conn: Database,
  input: { finishedAt?: string; detail?: string } = {},
): OrphanRun[] {
  const open = all<OrphanRun>(
    conn,
    `SELECT id, project_id, task_id, kind, started_at
     FROM runs
     WHERE outcome IS NULL
     ORDER BY started_at, id`,
  );
  if (open.length === 0) return [];
  runSql(
    conn,
    `UPDATE runs
     SET outcome = 'inactive', finished_at = ?, duration_ms = NULL, detail = ?
     WHERE outcome IS NULL`,
    input.finishedAt ?? utcnow(),
    input.detail ?? ORPHAN_RUN_DETAIL,
  );
  return open;
}

export interface ProjectUsage {
  tokens: number;
  cost_usd: number;
}

/**
 * Token/cost totals for every finished (or still running) task in a project. Running tasks
 * have not reported usage yet, so a budget check can overshoot by the task-level usage of
 * the tasks currently in flight; the next dispatch after they finish sees the full total.
 */
export function getProjectUsage(conn: Database, projectId: string): ProjectUsage {
  getProjectOr404(conn, projectId);
  const row = get<{ tokens: number | null; cost_usd: number | null }>(
    conn,
    `SELECT COALESCE(SUM(total_tokens), 0) AS tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd
     FROM runs WHERE project_id = ?`,
    projectId,
  );
  return { tokens: row?.tokens ?? 0, cost_usd: row?.cost_usd ?? 0 };
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

/** Cross-project history used by stats-driven worker selection. */
export function listAllRuns(conn: Database): Run[] {
  return all<RunRow>(conn, "SELECT * FROM runs ORDER BY started_at, id").map(runFromRow);
}

export interface RecordFactMetaInput {
  projectId: string;
  factId: string;
  runId?: string | null;
  evidenceRefs?: readonly string[];
  evidenceStatus: "provided" | "missing";
  supersedes?: readonly string[];
  createdAt?: string;
}

export function recordFactMeta(conn: Database, input: RecordFactMetaInput): void {
  runSql(
    conn,
    `
    INSERT OR REPLACE INTO fact_meta
        (fact_id, project_id, run_id, evidence_refs, evidence_status, supersedes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    input.factId,
    input.projectId,
    input.runId ?? null,
    JSON.stringify([...(input.evidenceRefs ?? [])]),
    input.evidenceStatus,
    JSON.stringify([...(input.supersedes ?? [])]),
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
      supersedes: [],
      superseded_by: findSupersedingFact(conn, projectId, factId),
      created_at: null,
    };
  }
  return factMetaFromRow(conn, projectId, row);
}

interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  kind: string;
  intent_id: string | null;
  worker: string;
  worker_profile: string | null;
  model: string | null;
  trigger: string | null;
  outcome: string | null;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  session: string | null;
  evidence_count: number;
  detail: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

interface FactMetaRow {
  fact_id: string;
  project_id: string;
  run_id: string | null;
  evidence_refs: string;
  evidence_status: string;
  supersedes: string;
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
    worker_profile: row.worker_profile,
    model: row.model,
    trigger: row.trigger,
    outcome: row.outcome === null ? null : (row.outcome as RunOutcome),
    exit_code: row.exit_code,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    session: row.session,
    evidence_count: row.evidence_count,
    detail: row.detail,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_write_tokens: row.cache_write_tokens,
    total_tokens: row.total_tokens,
    cost_usd: row.cost_usd,
  };
}

function factMetaFromRow(
  conn: Database,
  projectId: string,
  row: FactMetaRow,
): FactMeta {
  return {
    fact_id: row.fact_id,
    run_id: row.run_id,
    evidence_refs: parseEvidenceRefs(row.evidence_refs),
    evidence_status: row.evidence_status as EvidenceStatus,
    supersedes: parseSupersededIds(row.supersedes),
    superseded_by: findSupersedingFact(conn, projectId, row.fact_id),
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
