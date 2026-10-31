/**
 * Task-level claim ledger (M39, Phase C2).
 *
 * The scheduler's in-memory task map answers "what is running" only for its own process, so a
 * second control plane is invisible to it and a crash leaves no record of who owned the task.
 * A claim row records that ownership in the database: one per dispatched task, active until it
 * is released. The two partial unique indexes make double dispatch on the same intent (or the
 * same project's reason slot) impossible at the storage level, which the graph-level lease
 * cannot do because both schedulers claim as the same worker name.
 *
 * This is a sidecar table: it never changes the graph, the YAML export or the worker contract.
 */

import type { Database } from "bun:sqlite";

import { all, get, run, type SqlValue } from "./db";
import { HttpError } from "./errors";
import { utcnow } from "./services";

export interface TaskClaim {
  task_id: string;
  run_id: string | null;
  instance_id: string;
  project_id: string;
  intent_id: string | null;
  kind: string;
  worker: string;
  created_at: string;
  lease_expires_at: string;
  released_at: string | null;
  release_reason: string | null;
}

export interface ClaimTaskInput {
  taskId: string;
  instanceId: string;
  projectId: string;
  kind: string;
  worker: string;
  /** Lease TTL in seconds; the scheduler reuses the graph lease's own timeout. */
  leaseSeconds: number;
  runId?: string | null;
  intentId?: string | null;
  at?: string;
}

/** Release reasons written by takeover and shutdown, so logs and tests agree on one spelling. */
export const CLAIM_RELEASE_INSTANCE_STOPPED = "instance stopped";
export const CLAIM_RELEASE_OWNER_EXPIRED = "owner instance expired";
export const CLAIM_RELEASE_SHUTDOWN = "shutdown";

function formatUtc(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `at` plus a TTL, in the same second-precision shape as `utcnow()`. */
function plusSeconds(at: string, seconds: number): string {
  const base = Date.parse(at);
  // Never write "NaN" into a NOT NULL column if a caller hands over an unparseable stamp.
  const start = Number.isNaN(base) ? Date.now() : base;
  return formatUtc(new Date(start + Math.max(Math.trunc(seconds), 1) * 1000));
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    code === "SQLITE_CONSTRAINT"
  );
}

/**
 * Inserts the claim for a task about to start. Throws `HttpError(409)` when another instance
 * already holds an active claim for the same intent or the project's reason slot; callers run
 * this inside the dispatch transaction, so the throw also rolls back the graph-level lease.
 * Re-claiming the caller's own task id is idempotent and only refreshes the lease.
 */
export function claimTask(conn: Database, input: ClaimTaskInput): TaskClaim {
  const at = input.at ?? utcnow();
  const expiresAt = plusSeconds(at, input.leaseSeconds);
  const intentId = input.intentId ?? null;
  try {
    run(
      conn,
      `
      INSERT INTO task_claims
          (task_id, run_id, instance_id, project_id, intent_id, kind, worker,
           created_at, lease_expires_at, released_at, release_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(task_id) DO UPDATE
        SET lease_expires_at = excluded.lease_expires_at,
            run_id = excluded.run_id
       WHERE released_at IS NULL
      `,
      input.taskId,
      input.runId ?? null,
      input.instanceId,
      input.projectId,
      intentId,
      input.kind,
      input.worker,
      at,
      expiresAt,
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const scope = intentId === null ? "reason slot" : `intent ${intentId}`;
      throw new HttpError(409, `Project ${input.projectId} ${scope} is already claimed`);
    }
    throw error;
  }
  const row = getTaskClaim(conn, input.taskId);
  if (row === null) {
    throw new Error(`claim insert produced no row for task ${input.taskId}`);
  }
  if (row.released_at !== null) {
    // The upsert deliberately stops at a released row, so an attempt to re-claim a finished
    // task reports the loss instead of returning a claim that already gave its slot away.
    throw new HttpError(409, `Task ${input.taskId} already released its claim`);
  }
  return row;
}

export function getTaskClaim(conn: Database, taskId: string): TaskClaim | null {
  return get<TaskClaim>(conn, "SELECT * FROM task_claims WHERE task_id = ?", taskId);
}

/**
 * Pushes the lease out for an active claim. False means the claim is gone (released or taken
 * over), which the supervisor treats exactly like a lost graph lease.
 */
export function renewTaskClaimLease(
  conn: Database,
  taskId: string,
  leaseSeconds: number,
  at?: string,
): boolean {
  const now = at ?? utcnow();
  const result = conn
    .query(
      `UPDATE task_claims SET lease_expires_at = ?
       WHERE task_id = ? AND released_at IS NULL`,
    )
    .run(plusSeconds(now, leaseSeconds), taskId);
  return Number(result.changes) > 0;
}

/** Terminal for this task: an already released claim never comes back. */
export function releaseTaskClaim(
  conn: Database,
  taskId: string,
  reason: string,
  at?: string,
): boolean {
  const result = conn
    .query(
      `UPDATE task_claims SET released_at = ?, release_reason = ?
       WHERE task_id = ? AND released_at IS NULL`,
    )
    .run(at ?? utcnow(), reason, taskId);
  return Number(result.changes) > 0;
}

/**
 * Releases every claim still held by `instanceId`. Used on a graceful stop, where the tasks
 * already released their own claims and this only catches anything that slipped through.
 */
export function releaseTaskClaimsForInstance(
  conn: Database,
  instanceId: string,
  reason: string,
  at?: string,
): TaskClaim[] {
  const held = all<TaskClaim>(
    conn,
    `SELECT * FROM task_claims
     WHERE instance_id = ? AND released_at IS NULL
     ORDER BY project_id, created_at, task_id`,
    instanceId,
  );
  if (held.length === 0) return [];
  run(
    conn,
    `UPDATE task_claims SET released_at = ?, release_reason = ?
     WHERE instance_id = ? AND released_at IS NULL`,
    at ?? utcnow(),
    reason,
    instanceId,
  );
  return held;
}

/**
 * Claims nobody has released yet and whose lease has not run out. This is the authoritative
 * "what is running" view the scheduler budgets against; `now` comes from its injectable clock.
 */
export function listActiveTaskClaims(
  conn: Database,
  input: { now?: string; projectId?: string } = {},
): TaskClaim[] {
  const now = input.now ?? utcnow();
  const params: SqlValue[] = [now];
  let projectFilter = "";
  if (input.projectId !== undefined) {
    projectFilter = "AND project_id = ?";
    params.push(input.projectId);
  }
  return all<TaskClaim>(
    conn,
    `SELECT * FROM task_claims
     WHERE released_at IS NULL
       AND (julianday(lease_expires_at) - julianday(?)) * 86400 > 0
       ${projectFilter}
     ORDER BY project_id, created_at, task_id`,
    ...params,
  );
}

/** The claim as it was when the takeover rule fired, plus that rule. */
export type ReapedTaskClaim = TaskClaim & {
  reason: string;
};

export interface TaskClaimReapResult {
  /** Claims this pass released, each with the takeover rule that fired. */
  released: ReapedTaskClaim[];
  /** Claims left alone because their owner is dead but the task lease still has time. */
  waiting: TaskClaim[];
}

interface ClaimWithOwner extends TaskClaim {
  owner_stopped_at: string | null;
  /** Seconds since the owner last beat; null when the instance row does not exist. */
  owner_heartbeat_age: number | null;
  lease_age_seconds: number;
}

/**
 * Applies the takeover rules to every active claim and returns what changed.
 *
 * A claim is released when its owner instance stopped cleanly (`stopped_at` set — that boot is
 * finished and will never write again) or when the owner has stopped heartbeating *and* the
 * task's own lease has run out. A dead-looking owner with a live lease is kept: a worker can
 * outlive the control plane that started it, and taking its task over early would let two
 * processes write the same workspace. A claim whose owner still beats is never touched, even
 * past its lease — that instance's own renewal path is the one that has to give it up.
 *
 * Nothing is deleted; released rows stay for attribution.
 */
export function reapTaskClaims(
  conn: Database,
  input: { now?: string; instanceTimeoutSeconds: number },
): TaskClaimReapResult {
  const now = input.now ?? utcnow();
  const rows = all<ClaimWithOwner>(
    conn,
    `SELECT c.*,
            i.stopped_at AS owner_stopped_at,
            CASE WHEN i.id IS NULL THEN NULL
                 ELSE (julianday(?) - julianday(i.heartbeat_at)) * 86400 END AS owner_heartbeat_age,
            (julianday(?) - julianday(c.lease_expires_at)) * 86400 AS lease_age_seconds
     FROM task_claims c
     LEFT JOIN scheduler_instances i ON i.id = c.instance_id
     WHERE c.released_at IS NULL
     ORDER BY c.project_id, c.created_at, c.task_id`,
    now,
    now,
  );

  const released: ReapedTaskClaim[] = [];
  const waiting: TaskClaim[] = [];
  for (const row of rows) {
    const claim: TaskClaim = {
      task_id: row.task_id,
      run_id: row.run_id,
      instance_id: row.instance_id,
      project_id: row.project_id,
      intent_id: row.intent_id,
      kind: row.kind,
      worker: row.worker,
      created_at: row.created_at,
      lease_expires_at: row.lease_expires_at,
      released_at: null,
      release_reason: null,
    };
    const ownerAlive =
      row.owner_stopped_at === null &&
      row.owner_heartbeat_age !== null &&
      row.owner_heartbeat_age <= input.instanceTimeoutSeconds;
    if (ownerAlive) continue;
    const leaseExpired = row.lease_age_seconds >= 0;
    if (row.owner_stopped_at !== null) {
      released.push({ ...claim, reason: CLAIM_RELEASE_INSTANCE_STOPPED });
    } else if (leaseExpired) {
      released.push({ ...claim, reason: CLAIM_RELEASE_OWNER_EXPIRED });
    } else {
      waiting.push(claim);
    }
  }

  for (const claim of released) {
    releaseTaskClaim(conn, claim.task_id, claim.reason, now);
  }
  return { released, waiting };
}
