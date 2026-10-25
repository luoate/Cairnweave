/**
 * Graph mutations shared by the HTTP API and the in-process scheduler.
 *
 * The API used to own this logic directly. The scheduler needs exactly the same rules
 * (claim ordering, expiry, 403/409 boundaries), so keeping two copies would let them
 * drift. Each function runs on a caller-supplied connection and throws `HttpError` with
 * the same status/detail Cairn returns over HTTP; the scheduler treats status as an
 * outcome instead of a response.
 */

import type { Database } from "bun:sqlite";

import { all, get, run } from "./db";
import { HttpError } from "./errors";
import { recordFactEvidence, type FactEvidenceFileInput } from "./fact-evidence";
import { recordFactMeta } from "./runs";
import type {
  CompleteRequest,
  ConcludeResponse,
  CreateIntentRequest,
  CreateProjectRequest,
  Fact,
  Hint,
  Intent,
  ProjectDetail,
  ProjectMeta,
  ProjectScopeInput,
  ProjectSummary,
} from "./models";
import {
  buildIntents,
  checkProjectActive,
  clearProjectReason,
  expireReasonLeases,
  expireWorkers,
  getClaimableOpenIntentOr404,
  getProjectOr404,
  getReleasableOpenIntentOr404,
  intentToModel,
  nextFactId,
  nextHintId,
  nextIntentId,
  nextProjectId,
  projectMetaFromRow,
  utcnow,
  validateFactsExist,
  validateGoalNotInSources,
  validateIntentCreatorWorker,
  type IntentRow,
  type ProjectRow,
} from "./services";

export type ProjectScope = ProjectScopeInput;

export function listProjects(conn: Database): ProjectSummary[] {
  expireWorkers(conn);
  expireReasonLeases(conn);
  const rows = all<
    ProjectRow & {
      fact_count: number;
      intent_count: number;
      working_intent_count: number;
      unclaimed_intent_count: number;
      hint_count: number;
    }
  >(
    conn,
    `
    SELECT p.*,
        (SELECT COUNT(*) FROM facts WHERE project_id = p.id) AS fact_count,
        (SELECT COUNT(*) FROM intents WHERE project_id = p.id) AS intent_count,
        (SELECT COUNT(*) FROM intents WHERE project_id = p.id AND concluded_at IS NULL AND worker IS NOT NULL) AS working_intent_count,
        (SELECT COUNT(*) FROM intents WHERE project_id = p.id AND concluded_at IS NULL AND worker IS NULL) AS unclaimed_intent_count,
        (SELECT COUNT(*) FROM hints WHERE project_id = p.id) AS hint_count
    FROM projects p
    ORDER BY p.created_at
    `,
  );
  return rows.map((row) => ({
    ...projectMetaFromRow(row),
    fact_count: row.fact_count,
    intent_count: row.intent_count,
    working_intent_count: row.working_intent_count,
    unclaimed_intent_count: row.unclaimed_intent_count,
    hint_count: row.hint_count,
  }));
}

export function createProject(
  conn: Database,
  body: CreateProjectRequest,
): ProjectDetail {
  const projectId = nextProjectId(conn);
  const now = utcnow();

  run(
    conn,
    "INSERT INTO projects (id, title, status, bootstrap_enabled, created_at) VALUES (?, ?, 'active', ?, ?)",
    projectId,
    body.title,
    body.bootstrap_enabled ? 1 : 0,
    now,
  );
  run(
    conn,
    "INSERT INTO facts (id, project_id, description) VALUES ('origin', ?, ?)",
    projectId,
    body.origin,
  );
  run(
    conn,
    "INSERT INTO facts (id, project_id, description) VALUES ('goal', ?, ?)",
    projectId,
    body.goal,
  );

  // Build the response from what was just written. Calling getProjectDetail here would
  // run lease-expiry queries, which read the clock and would shift the parity harness's
  // deterministic timestamps.
  const hints: Hint[] = [];
  for (const hint of body.hints ?? []) {
    const hintId = nextHintId(conn, projectId);
    run(
      conn,
      "INSERT INTO hints (id, project_id, content, creator, created_at) VALUES (?, ?, ?, ?, ?)",
      hintId,
      projectId,
      hint.content,
      hint.creator,
      now,
    );
    hints.push({
      id: hintId,
      content: hint.content,
      creator: hint.creator,
      created_at: now,
    });
  }

  if (body.scope !== null) {
    setProjectScope(conn, projectId, body.scope);
  }

  return {
    project: {
      id: projectId,
      title: body.title,
      status: "active",
      bootstrap_enabled: body.bootstrap_enabled,
      created_at: now,
      reason: null,
    },
    facts: [
      { id: "origin", description: body.origin },
      { id: "goal", description: body.goal },
    ],
    intents: [],
    hints,
  };
}

export function getProjectDetail(conn: Database, projectId: string): ProjectDetail {
  expireWorkers(conn, projectId);
  expireReasonLeases(conn, projectId);
  const row = getProjectOr404(conn, projectId);

  const facts = all<Fact>(
    conn,
    "SELECT id, description FROM facts WHERE project_id = ?",
    projectId,
  );
  const hints = all<Hint>(
    conn,
    "SELECT id, content, creator, created_at FROM hints WHERE project_id = ? ORDER BY created_at",
    projectId,
  );

  return {
    project: projectMetaFromRow(row),
    facts,
    intents: buildIntents(conn, projectId),
    hints,
  };
}

export function createIntent(
  conn: Database,
  projectId: string,
  body: CreateIntentRequest,
): Intent {
  checkProjectActive(conn, projectId);
  validateFactsExist(conn, projectId, body.from);
  validateGoalNotInSources(body.from);
  validateIntentCreatorWorker(body.creator, body.worker);

  const now = utcnow();
  const intentId = nextIntentId(conn, projectId);
  const claimed = body.worker !== null;
  run(
    conn,
    "INSERT INTO intents (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL)",
    intentId,
    projectId,
    body.description,
    body.creator,
    body.worker,
    claimed ? now : null,
    now,
  );
  for (const factId of body.from) {
    run(
      conn,
      "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, ?)",
      intentId,
      projectId,
      factId,
    );
  }

  return {
    id: intentId,
    from: body.from,
    to: null,
    description: body.description,
    creator: body.creator,
    worker: body.worker,
    last_heartbeat_at: claimed ? now : null,
    created_at: now,
    concluded_at: null,
  };
}

export function claimReason(
  conn: Database,
  projectId: string,
  worker: string,
  trigger: string,
): ProjectMeta {
  checkProjectActive(conn, projectId);
  expireReasonLeases(conn, projectId);
  const row = getProjectOr404(conn, projectId);
  const currentWorker = row.reason_worker;
  if (currentWorker !== null && currentWorker !== worker) {
    throw new HttpError(409, `Project reason is currently claimed by ${currentWorker}`);
  }
  if (currentWorker === worker) {
    return projectMetaFromRow(row);
  }

  const now = utcnow();
  run(
    conn,
    `
    UPDATE projects
    SET reason_worker = ?,
        reason_trigger = ?,
        reason_started_at = ?,
        reason_last_heartbeat_at = ?
    WHERE id = ?
    `,
    worker,
    trigger,
    now,
    now,
    projectId,
  );
  return projectMetaFromRow(getProjectOr404(conn, projectId));
}

export function heartbeatReason(
  conn: Database,
  projectId: string,
  worker: string,
): ProjectMeta {
  checkProjectActive(conn, projectId);
  expireReasonLeases(conn, projectId);
  const row = getProjectOr404(conn, projectId);
  const currentWorker = row.reason_worker;
  if (currentWorker === null) {
    throw new HttpError(409, "Project reason is not currently claimed");
  }
  if (currentWorker !== worker) {
    throw new HttpError(409, `Project reason is currently claimed by ${currentWorker}`);
  }

  run(
    conn,
    "UPDATE projects SET reason_last_heartbeat_at = ? WHERE id = ?",
    utcnow(),
    projectId,
  );
  return projectMetaFromRow(getProjectOr404(conn, projectId));
}

export function releaseReason(
  conn: Database,
  projectId: string,
  worker: string,
): ProjectMeta {
  checkProjectActive(conn, projectId);
  expireReasonLeases(conn, projectId);
  const row = getProjectOr404(conn, projectId);
  const currentWorker = row.reason_worker;
  if (currentWorker === null) {
    return projectMetaFromRow(row);
  }
  if (currentWorker !== worker) {
    throw new HttpError(409, `Project reason is currently claimed by ${currentWorker}`);
  }

  clearProjectReason(conn, projectId);
  return projectMetaFromRow(getProjectOr404(conn, projectId));
}

export function heartbeatIntent(
  conn: Database,
  projectId: string,
  intentId: string,
  worker: string,
): Intent {
  checkProjectActive(conn, projectId);
  getClaimableOpenIntentOr404(conn, projectId, intentId, worker);

  run(
    conn,
    "UPDATE intents SET worker = ?, last_heartbeat_at = ? WHERE id = ? AND project_id = ?",
    worker,
    utcnow(),
    intentId,
    projectId,
  );

  const updated = get<IntentRow>(
    conn,
    "SELECT * FROM intents WHERE id = ? AND project_id = ?",
    intentId,
    projectId,
  );
  if (updated === null) {
    throw new HttpError(404, "Intent not found");
  }
  return intentToModel(conn, updated, projectId);
}

export function releaseIntent(
  conn: Database,
  projectId: string,
  intentId: string,
  worker: string,
): Intent {
  checkProjectActive(conn, projectId);
  let row = getReleasableOpenIntentOr404(conn, projectId, intentId, worker);

  if (row.worker === worker) {
    run(
      conn,
      "UPDATE intents SET worker = NULL WHERE id = ? AND project_id = ?",
      intentId,
      projectId,
    );
    const updated = get<IntentRow>(
      conn,
      "SELECT * FROM intents WHERE id = ? AND project_id = ?",
      intentId,
      projectId,
    );
    if (updated === null) {
      throw new HttpError(404, "Intent not found");
    }
    row = updated;
  }
  return intentToModel(conn, row, projectId);
}

export interface FactEvidence {
  runId?: string | null;
  evidenceRefs?: readonly string[];
  evidenceStatus?: "provided" | "missing";
  evidenceFiles?: readonly FactEvidenceFileInput[];
}

export function concludeIntent(
  conn: Database,
  projectId: string,
  intentId: string,
  worker: string,
  description: string,
  evidence?: FactEvidence,
): ConcludeResponse {
  checkProjectActive(conn, projectId);
  getClaimableOpenIntentOr404(conn, projectId, intentId, worker);

  const now = utcnow();
  const factId = nextFactId(conn, projectId);

  run(
    conn,
    "INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)",
    factId,
    projectId,
    description,
  );
  recordFactMeta(conn, {
    projectId,
    factId,
    runId: evidence?.runId ?? null,
    evidenceRefs: evidence?.evidenceRefs ?? [],
    evidenceStatus: evidence?.evidenceStatus ?? "missing",
    createdAt: now,
  });
  if (evidence?.evidenceFiles !== undefined && evidence.evidenceFiles.length > 0) {
    recordFactEvidence(conn, {
      projectId,
      factId,
      files: evidence.evidenceFiles,
      createdAt: now,
    });
  }
  run(
    conn,
    "UPDATE intents SET to_fact_id = ?, worker = ?, last_heartbeat_at = ?, concluded_at = ? WHERE id = ? AND project_id = ?",
    factId,
    worker,
    now,
    now,
    intentId,
    projectId,
  );

  const updated = get<IntentRow>(
    conn,
    "SELECT * FROM intents WHERE id = ? AND project_id = ?",
    intentId,
    projectId,
  );
  if (updated === null) {
    throw new HttpError(404, "Intent not found");
  }
  return {
    fact: { id: factId, description },
    intent: intentToModel(conn, updated, projectId),
  };
}

export function completeProject(
  conn: Database,
  projectId: string,
  body: CompleteRequest,
): Intent {
  checkProjectActive(conn, projectId);
  expireReasonLeases(conn, projectId);
  validateFactsExist(conn, projectId, body.from);
  validateGoalNotInSources(body.from);

  const now = utcnow();
  const intentId = nextIntentId(conn, projectId);

  run(
    conn,
    "INSERT INTO intents (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at) VALUES (?, ?, 'goal', ?, ?, ?, ?, ?, ?)",
    intentId,
    projectId,
    body.description,
    body.worker,
    body.worker,
    now,
    now,
    now,
  );
  for (const factId of body.from) {
    run(
      conn,
      "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, ?)",
      intentId,
      projectId,
      factId,
    );
  }
  run(
    conn,
    `
    UPDATE projects
    SET status = 'completed',
        reason_worker = NULL,
        reason_trigger = NULL,
        reason_started_at = NULL,
        reason_last_heartbeat_at = NULL
    WHERE id = ?
    `,
    projectId,
  );

  return {
    id: intentId,
    from: body.from,
    to: "goal",
    description: body.description,
    creator: body.worker,
    worker: body.worker,
    last_heartbeat_at: now,
    created_at: now,
    concluded_at: now,
  };
}

/**
 * Lease renewal for a task the scheduler owns. Unlike the HTTP heartbeat commands this
 * never claims or re-creates a lease: it reports false when the lease is gone (expired,
 * released, project stopped, or claimed by someone else) so the supervisor can cancel.
 */
export function renewIntentLease(
  conn: Database,
  projectId: string,
  intentId: string,
  worker: string,
): boolean {
  const result = conn
    .query(
      "UPDATE intents SET last_heartbeat_at = ? WHERE id = ? AND project_id = ? AND worker = ? AND to_fact_id IS NULL",
    )
    .run(utcnow(), intentId, projectId, worker);
  return Number(result.changes) > 0;
}

export function renewReasonLease(
  conn: Database,
  projectId: string,
  worker: string,
): boolean {
  const result = conn
    .query(
      "UPDATE projects SET reason_last_heartbeat_at = ? WHERE id = ? AND reason_worker = ?",
    )
    .run(utcnow(), projectId, worker);
  return Number(result.changes) > 0;
}

export function setProjectScope(
  conn: Database,
  projectId: string,
  scope: ProjectScope,
): void {
  getProjectOr404(conn, projectId);
  if (scope.targets.length === 0) {
    throw new HttpError(400, "scope.targets must not be empty");
  }
  run(
    conn,
    `
    INSERT INTO project_scopes (project_id, targets, notes) VALUES (?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET targets = excluded.targets, notes = excluded.notes
    `,
    projectId,
    JSON.stringify(scope.targets),
    scope.notes ?? null,
  );
}

/**
 * Returns null when the project has no usable scope. A malformed stored value fails
 * closed (null) rather than throwing, so one bad row cannot stop the whole scheduler.
 */
export function getProjectScope(conn: Database, projectId: string): ProjectScope | null {
  const row = get<{ targets: string; notes: string | null }>(
    conn,
    "SELECT targets, notes FROM project_scopes WHERE project_id = ?",
    projectId,
  );
  if (row === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.targets);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  const targets = parsed.filter(
    (target): target is string => typeof target === "string" && target.trim() !== "",
  );
  if (targets.length !== parsed.length) {
    return null;
  }
  return row.notes === null
    ? { targets }
    : { targets, notes: row.notes };
}
