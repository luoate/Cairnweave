import type { Database } from "bun:sqlite";

import { all, get, run } from "./db";
import { HttpError } from "./errors";
import type {
  Intent,
  ProjectMeta,
  ProjectReason,
  ProjectStatus,
} from "./models";

export interface ProjectRow {
  id: string;
  title: string;
  status: ProjectStatus;
  bootstrap_enabled: number;
  created_at: string;
  reason_worker: string | null;
  reason_trigger: string | null;
  reason_started_at: string | null;
  reason_last_heartbeat_at: string | null;
}

export interface IntentRow {
  id: string;
  project_id: string;
  to_fact_id: string | null;
  description: string;
  creator: string;
  worker: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  concluded_at: string | null;
}

export interface FactRow {
  id: string;
  project_id: string;
  description: string;
}

export interface HintRow {
  id: string;
  project_id: string;
  content: string;
  creator: string;
  created_at: string;
}

function realUtcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

let utcNowSource: () => string = realUtcNow;

/**
 * UTC timestamp with second precision, matching `%Y-%m-%dT%H:%M:%SZ`.
 *
 * The source is replaceable so the parity harness can replay Python-generated goldens with a
 * deterministic clock. Production and normal tests use the wall clock.
 */
export function utcnow(): string {
  return utcNowSource();
}

export function setUtcNowSource(source: (() => string) | null): void {
  utcNowSource = source ?? realUtcNow;
}

function threeDigits(value: number): string {
  return String(value).padStart(3, "0");
}

export function nextProjectId(conn: Database): string {
  run(conn, "UPDATE counters SET value = value + 1 WHERE name = 'project'");
  const row = get<{ value: number }>(
    conn,
    "SELECT value FROM counters WHERE name = 'project'",
  );
  if (row === null) {
    throw new Error("project counter is missing");
  }
  return `proj_${threeDigits(row.value)}`;
}

function nextScopedId(
  conn: Database,
  kind: string,
  prefix: string,
  projectId: string,
): string {
  run(
    conn,
    "INSERT OR IGNORE INTO scoped_counters (project_id, kind, value) VALUES (?, ?, 0)",
    projectId,
    kind,
  );
  run(
    conn,
    "UPDATE scoped_counters SET value = value + 1 WHERE project_id = ? AND kind = ?",
    projectId,
    kind,
  );
  const row = get<{ value: number }>(
    conn,
    "SELECT value FROM scoped_counters WHERE project_id = ? AND kind = ?",
    projectId,
    kind,
  );
  if (row === null) {
    throw new Error(`scoped counter ${kind} is missing`);
  }
  return `${prefix}${threeDigits(row.value)}`;
}

export function nextFactId(conn: Database, projectId: string): string {
  return nextScopedId(conn, "fact", "f", projectId);
}

export function nextIntentId(conn: Database, projectId: string): string {
  return nextScopedId(conn, "intent", "i", projectId);
}

export function nextHintId(conn: Database, projectId: string): string {
  return nextScopedId(conn, "hint", "h", projectId);
}

export function nextRunId(conn: Database, projectId: string): string {
  return nextScopedId(conn, "run", "run_", projectId);
}

export function getProjectOr404(conn: Database, projectId: string): ProjectRow {
  const row = get<ProjectRow>(conn, "SELECT * FROM projects WHERE id = ?", projectId);
  if (row === null) {
    throw new HttpError(404, "Project not found");
  }
  return row;
}

export function checkProjectActive(conn: Database, projectId: string): ProjectRow {
  const row = getProjectOr404(conn, projectId);
  if (row.status !== "active") {
    throw new HttpError(403, `Project is ${row.status}`);
  }
  return row;
}

export function checkProjectHintWritable(conn: Database, projectId: string): ProjectRow {
  const row = getProjectOr404(conn, projectId);
  if (row.status !== "active" && row.status !== "stopped" && row.status !== "completed") {
    throw new HttpError(403, `Project is ${row.status}`);
  }
  return row;
}

export function checkProjectCompleted(conn: Database, projectId: string): ProjectRow {
  const row = getProjectOr404(conn, projectId);
  if (row.status !== "completed") {
    throw new HttpError(403, `Project is ${row.status}`);
  }
  return row;
}

export function validateFactsExist(
  conn: Database,
  projectId: string,
  factIds: readonly string[],
): void {
  for (const factId of factIds) {
    const row = get<{ one: number }>(
      conn,
      "SELECT 1 AS one FROM facts WHERE id = ? AND project_id = ?",
      factId,
      projectId,
    );
    if (row === null) {
      throw new HttpError(404, `Fact ${factId} not found`);
    }
  }
}

export function validateGoalNotInSources(factIds: readonly string[]): void {
  if (factIds.includes("goal")) {
    throw new HttpError(400, "goal cannot be used in from");
  }
}

export function validateIntentCreatorWorker(
  creator: string,
  worker: string | null,
): void {
  if (worker !== null && worker !== creator) {
    throw new HttpError(400, "worker must be null or equal to creator");
  }
}

export function getIntentOr404(
  conn: Database,
  projectId: string,
  intentId: string,
): IntentRow {
  const row = get<IntentRow>(
    conn,
    "SELECT * FROM intents WHERE id = ? AND project_id = ?",
    intentId,
    projectId,
  );
  if (row === null) {
    throw new HttpError(404, "Intent not found");
  }
  return row;
}

export function getClaimableOpenIntentOr404(
  conn: Database,
  projectId: string,
  intentId: string,
  worker: string,
): IntentRow {
  expireWorkers(conn, projectId);
  const row = getIntentOr404(conn, projectId, intentId);
  if (row.to_fact_id !== null) {
    throw new HttpError(409, "Intent already concluded");
  }
  if (row.worker !== null && row.worker !== worker) {
    throw new HttpError(409, `Intent is currently claimed by ${row.worker}`);
  }
  return row;
}

export function getReleasableOpenIntentOr404(
  conn: Database,
  projectId: string,
  intentId: string,
  worker: string,
): IntentRow {
  expireWorkers(conn, projectId);
  const row = getIntentOr404(conn, projectId, intentId);
  if (row.to_fact_id !== null) {
    throw new HttpError(409, "Intent already concluded");
  }
  if (row.worker === null) {
    return row;
  }
  if (row.worker !== worker) {
    throw new HttpError(409, `Intent is currently claimed by ${row.worker}`);
  }
  return row;
}

export function getCompletionIntentOr409(
  conn: Database,
  projectId: string,
): IntentRow {
  const rows = all<IntentRow>(
    conn,
    "SELECT * FROM intents WHERE project_id = ? AND to_fact_id = 'goal'",
    projectId,
  );
  if (rows.length === 0) {
    throw new HttpError(409, "Completed project is missing its completion intent");
  }
  if (rows.length !== 1) {
    throw new HttpError(409, "Completed project has multiple completion intents");
  }
  return rows[0]!;
}

export function intentToModel(
  conn: Database,
  row: IntentRow,
  projectId: string,
): Intent {
  const sources = all<{ fact_id: string }>(
    conn,
    "SELECT fact_id FROM intent_sources WHERE intent_id = ? AND project_id = ? ORDER BY rowid",
    row.id,
    projectId,
  );
  return {
    id: row.id,
    from: sources.map((source) => source.fact_id),
    to: row.to_fact_id,
    description: row.description,
    creator: row.creator,
    worker: row.worker,
    last_heartbeat_at: row.last_heartbeat_at,
    created_at: row.created_at,
    concluded_at: row.concluded_at,
  };
}

export function buildIntents(conn: Database, projectId: string): Intent[] {
  const rows = all<IntentRow>(
    conn,
    "SELECT * FROM intents WHERE project_id = ? ORDER BY created_at",
    projectId,
  );
  return rows.map((row) => intentToModel(conn, row, projectId));
}

export function getIntentTimeout(conn: Database): number {
  const row = get<{ intent_timeout: number }>(
    conn,
    "SELECT intent_timeout FROM settings WHERE rowid = 1",
  );
  if (row === null) {
    throw new Error("settings row is missing");
  }
  return row.intent_timeout;
}

export function getReasonTimeout(conn: Database): number {
  const row = get<{ reason_timeout: number }>(
    conn,
    "SELECT reason_timeout FROM settings WHERE rowid = 1",
  );
  if (row === null) {
    throw new Error("settings row is missing");
  }
  return row.reason_timeout;
}

export function projectReasonFromRow(row: ProjectRow): ProjectReason | null {
  if (row.reason_worker === null) {
    return null;
  }
  return {
    worker: row.reason_worker,
    trigger: row.reason_trigger ?? "",
    started_at: row.reason_started_at ?? "",
    last_heartbeat_at: row.reason_last_heartbeat_at ?? "",
  };
}

export function projectMetaFromRow(row: ProjectRow): ProjectMeta {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    bootstrap_enabled: Boolean(row.bootstrap_enabled),
    created_at: row.created_at,
    reason: projectReasonFromRow(row),
  };
}

export function clearProjectReason(conn: Database, projectId: string): void {
  run(
    conn,
    `
    UPDATE projects
    SET reason_worker = NULL,
        reason_trigger = NULL,
        reason_started_at = NULL,
        reason_last_heartbeat_at = NULL
    WHERE id = ?
    `,
    projectId,
  );
}

export function expireWorkers(conn: Database, projectId?: string): void {
  const timeout = getIntentTimeout(conn);
  const now = utcnow();
  const query = `
        UPDATE intents
        SET worker = NULL
        WHERE to_fact_id IS NULL
          AND worker IS NOT NULL
          AND last_heartbeat_at IS NOT NULL
          AND (julianday(?) - julianday(last_heartbeat_at)) * 86400 > ?
    `;
  if (projectId !== undefined) {
    run(conn, query.replace("WHERE ", "WHERE project_id = ? AND "), projectId, now, timeout);
  } else {
    run(conn, query, now, timeout);
  }
}

export function expireReasonLeases(conn: Database, projectId?: string): void {
  const timeout = getReasonTimeout(conn);
  const now = utcnow();
  const query = `
        UPDATE projects
        SET reason_worker = NULL,
            reason_trigger = NULL,
            reason_started_at = NULL,
            reason_last_heartbeat_at = NULL
        WHERE reason_worker IS NOT NULL
          AND reason_last_heartbeat_at IS NOT NULL
          AND (julianday(?) - julianday(reason_last_heartbeat_at)) * 86400 > ?
    `;
  if (projectId !== undefined) {
    run(
      conn,
      query.replace("WHERE ", "WHERE id = ? AND "),
      projectId,
      now,
      timeout,
    );
  } else {
    run(conn, query, now, timeout);
  }
}
