/** Control-plane operational state. Never turn a worker error into a target fact. */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { get, run } from "./db";

export type InfrastructureFailureCode = "model_connection_error" | "model_auth_error" |
  "model_rate_limit" | "model_timeout" | "model_error" | "worker_spawn_failed" | "runtime_unavailable";
export type ExecutionFailureCode = "worker_failed" | "hard_deadline" | "lease_lost" |
  "result_missing" | "result_invalid" | "evidence_invalid" | "verification_error" | "apply_failed" | "supervision_failed";
export type RunFailure = { domain: "infrastructure"; code: InfrastructureFailureCode } |
  { domain: "execution"; code: ExecutionFailureCode };
export interface InfrastructureFault {
  project_id: string;
  /** Changes on every new failure, so an older parallel success cannot clear a new fault. */
  id: string;
  code: InfrastructureFailureCode;
  last_run_id: string | null;
  consecutive_failures: number;
  state: "backoff" | "blocked";
  retry_after: string | null;
  updated_at: string;
}
export function getInfrastructureFault(conn: Database, projectId: string): InfrastructureFault | null {
  return get<InfrastructureFault>(conn, "SELECT * FROM infrastructure_faults WHERE project_id = ?", projectId);
}
export function infrastructureDispatchBlocked(fault: InfrastructureFault | null, now: Date): boolean {
  return fault !== null && (fault.state === "blocked" || fault.retry_after === null ||
    !Number.isFinite(Date.parse(fault.retry_after)) || Date.parse(fault.retry_after) > now.getTime());
}
/** Called in the same transaction as run completion, or for pre-dispatch runtime failures. */
export function recordInfrastructureFailure(conn: Database, input: {
  projectId: string; code: InfrastructureFailureCode; runId?: string; at: string;
}): InfrastructureFault {
  const previous = getInfrastructureFault(conn, input.projectId);
  if (input.runId !== undefined && previous?.last_run_id === input.runId) return previous;
  const count = (previous?.consecutive_failures ?? 0) + 1;
  // Authentication cannot heal through retries. Three consecutive environment failures
  // open the circuit; changing hints, replan requests and restarts cannot bypass it.
  const blocked = previous?.state === "blocked" || input.code === "model_auth_error" || count >= 3;
  const delay = (input.code === "model_rate_limit" ? 60 : 30) * 2 ** Math.min(count - 1, 4);
  const fault: InfrastructureFault = { project_id: input.projectId, id: randomUUID(), code: input.code,
    last_run_id: input.runId ?? null, consecutive_failures: count, state: blocked ? "blocked" : "backoff",
    retry_after: blocked ? null : new Date(Date.parse(input.at) + delay * 1000).toISOString(), updated_at: input.at };
  run(conn, `INSERT INTO infrastructure_faults
    (project_id, id, code, last_run_id, consecutive_failures, state, retry_after, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET
    id=excluded.id, code=excluded.code, last_run_id=excluded.last_run_id,
    consecutive_failures=excluded.consecutive_failures, state=excluded.state,
    retry_after=excluded.retry_after, updated_at=excluded.updated_at`, fault.project_id, fault.id, fault.code,
    fault.last_run_id, fault.consecutive_failures, fault.state, fault.retry_after, fault.updated_at);
  return fault;
}
/** Only a successful probe that observed this exact fault can close the circuit. */
export function clearInfrastructureFaultAfterSuccess(conn: Database, projectId: string, observedId: string | null): void {
  if (observedId !== null) run(conn,
    "DELETE FROM infrastructure_faults WHERE project_id = ? AND id = ? AND state = 'backoff'", projectId, observedId);
}
/** Operator recovery reuses the existing stopped -> active status transition, not a new write route. */
export function resetInfrastructureFault(conn: Database, projectId: string): void {
  run(conn, "DELETE FROM infrastructure_faults WHERE project_id = ?", projectId);
}
