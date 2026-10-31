/**
 * Scheduler process liveness. The scheduler's own "running tasks" view is a process-local
 * map, so nothing in the database says which control plane is alive. This sidecar table
 * records one row per boot so a starting scheduler can ask whether another instance is still
 * heartbeating before it closes the runs the previous process left open.
 *
 * Only the reading is subtle: a crashed process never writes `stopped_at`, so liveness is
 * judged by heartbeat freshness, not by the state column.
 */

import type { Database } from "bun:sqlite";

import { all, run } from "./db";
import { utcnow } from "./services";

export interface SchedulerInstanceRow {
  id: string;
  started_at: string;
  heartbeat_at: string;
  stopped_at: string | null;
}

export interface RegisterSchedulerInstanceInput {
  id: string;
  at?: string;
}

/** Idempotent per boot id; a repeated call only refreshes the heartbeat. */
export function registerSchedulerInstance(
  conn: Database,
  input: RegisterSchedulerInstanceInput,
): void {
  const at = input.at ?? utcnow();
  run(
    conn,
    `INSERT INTO scheduler_instances (id, started_at, heartbeat_at, stopped_at)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`,
    input.id,
    at,
    at,
  );
}

export function heartbeatSchedulerInstance(
  conn: Database,
  instanceId: string,
  at?: string,
): void {
  run(
    conn,
    "UPDATE scheduler_instances SET heartbeat_at = ? WHERE id = ? AND stopped_at IS NULL",
    at ?? utcnow(),
    instanceId,
  );
}

/** Terminal for this boot id; a later restart registers a fresh one. */
export function stopSchedulerInstance(
  conn: Database,
  instanceId: string,
  at?: string,
): void {
  run(
    conn,
    "UPDATE scheduler_instances SET stopped_at = ? WHERE id = ? AND stopped_at IS NULL",
    at ?? utcnow(),
    instanceId,
  );
}

/**
 * Instances other than `instanceId` that were never stopped and beat within
 * `timeoutSeconds` of `now`. Rows with an unparseable timestamp are excluded, which matches
 * the intent: only a peer that demonstrably heartbeated recently can own the open runs.
 */
export function listActiveSchedulerPeers(
  conn: Database,
  instanceId: string,
  input: { now: string; timeoutSeconds: number },
): SchedulerInstanceRow[] {
  return all<SchedulerInstanceRow>(
    conn,
    `SELECT id, started_at, heartbeat_at, stopped_at
     FROM scheduler_instances
     WHERE id <> ?
       AND stopped_at IS NULL
       AND (julianday(?) - julianday(heartbeat_at)) * 86400 <= ?
     ORDER BY heartbeat_at, id`,
    instanceId,
    input.now,
    input.timeoutSeconds,
  );
}
