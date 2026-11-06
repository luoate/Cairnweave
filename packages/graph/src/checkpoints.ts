/** M49 control-plane sidecar: latest accepted version; assertions stay worker claims. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { parseTaskCheckpoint, parseExperimentContract, isExperimentContract, type ExperimentContract, type TaskCheckpoint } from "@cairn/contracts";
import { all, get, run } from "./db";
import { utcnow } from "./services";
import type { AgentContextAttempt } from "./models";
import { projectExperimentResult, type ExperimentResultProjection } from "./experiments";
import type { RunFailure } from "./failures";
export type CheckpointTermination = "hard_deadline" | "cancelled" | "lease_lost" | "worker_exit" |
  "spawn_failed" | "result_missing" | "result_invalid" | "finished" | "control_plane_restart" | "supervision_failed";
export type CheckpointIngestStatus = "accepted" | "duplicate" | "stale" | "conflict" | "invalid" | "identity_mismatch" | "closed";
export function registerCheckpointRun(conn: Database, runId: string, scopeTargets: readonly string[], experiment?: ExperimentContract): void {
  if (experiment !== undefined && !isExperimentContract(experiment)) throw new Error("Invalid checkpoint experiment plan");
  run(conn, "INSERT OR IGNORE INTO task_checkpoints(run_id, scope_targets, experiment_plan) VALUES (?, ?, ?)",
    runId, JSON.stringify([...scopeTargets].sort()), experiment === undefined ? null : JSON.stringify(experiment));
}
export function acceptTaskCheckpoint(conn: Database, input: {
  runId: string; projectId: string; taskId: string; bytes: Uint8Array;
}): CheckpointIngestStatus {
  const value = parseTaskCheckpoint(input.bytes);
  if (value === null) return "invalid";
  const owner = get<{ project_id: string; task_id: string; intent_id: string | null }>(conn,
    "SELECT project_id, task_id, intent_id FROM runs WHERE id = ?", input.runId);
  if (owner === null || owner.project_id !== input.projectId || owner.task_id !== input.taskId ||
      value.project_id !== owner.project_id || value.task_id !== owner.task_id || value.intent_id !== owner.intent_id) return "identity_mismatch";
  const previous = get<{ sequence: number; sha256: string | null; termination_reason: string | null }>(conn,
    "SELECT sequence, sha256, termination_reason FROM task_checkpoints WHERE run_id = ?", input.runId);
  const payload = JSON.stringify(canonical(value));
  const digest = createHash("sha256").update(payload).digest("hex");
  if (previous !== null && value.sequence < previous.sequence) return "stale";
  if (previous !== null && value.sequence === previous.sequence) return digest === previous.sha256 ? "duplicate" : "conflict";
  if (previous?.termination_reason != null) return "closed";
  run(conn, `INSERT INTO task_checkpoints(run_id, sequence, payload, sha256, accepted_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET sequence=excluded.sequence,
    payload=excluded.payload, sha256=excluded.sha256, accepted_at=excluded.accepted_at
    WHERE task_checkpoints.sequence < excluded.sequence AND task_checkpoints.termination_reason IS NULL`,
    input.runId, value.sequence, payload, digest, utcnow());
  return "accepted";
}
/** Semantic key order is irrelevant to same-sequence replay identity. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function finalizeCheckpointRun(conn: Database, runId: string, reason: CheckpointTermination): void {
  run(conn, `INSERT INTO task_checkpoints(run_id, termination_reason) VALUES (?, ?)
    ON CONFLICT(run_id) DO UPDATE SET termination_reason=COALESCE(task_checkpoints.termination_reason, excluded.termination_reason)`, runId, reason);
}
export interface AttemptMemory {
  trust: "worker_claim_not_verified";
  sequence: number;
  accepted_at: string;
  checkpoint: TaskCheckpoint;
  /** M51c: control-plane dispatch-time plan; absent for legacy runs. */
  experiment_plan?: ExperimentContract;
  control: { outcome: string | null; termination_reason: string | null; failure?: RunFailure };
  /** M51b: optional for old serialized memories; absence is unknown, not negative. */
  experiment_result?: ExperimentResultProjection;
  reuse: {
    intent_status: string | null;
    scope_status: "unchanged_requires_authorization" | "changed_requires_authorization" | "unknown_requires_authorization";
    project_status: string;
    budget: "recheck_current_pack_core";
    facts: Array<{ id: string; status: "current" | "superseded" | "missing"; superseded_by: string | null }>;
    evidence: Array<{ ref: string; status: "available" | "missing" | "unavailable" }>;
    automatic_execution: false;
  };
}
export interface AttemptMemoryOptions {
  scopeTargets?: readonly string[];
  evidenceStatus?: (ref: string) => "available" | "missing" | "unavailable";
}
export function attachAttemptMemories(conn: Database, projectId: string, attempts: AgentContextAttempt[],
  facts: Array<{ id: string; status: "current" | "superseded"; superseded_by: string | null }>,
  intents: Array<{ id: string; status: string }>, projectStatus: string, options: AttemptMemoryOptions,
): Array<AgentContextAttempt & { memory?: AttemptMemory }> {
  const rows = all<{ run_id: string; payload: string | null; sequence: number; accepted_at: string;
    termination_reason: string | null; scope_targets: string | null; experiment_plan: string | null; outcome: string | null }>(conn,
    `SELECT c.*, r.outcome FROM task_checkpoints c JOIN runs r ON r.id=c.run_id
     WHERE r.project_id=? AND c.payload IS NOT NULL`, projectId);
  const byRun = new Map(rows.map((row) => [row.run_id, row]));
  const factMap = new Map(facts.map((fact) => [fact.id, fact]));
  return attempts.map((attempt) => {
    const row = byRun.get(attempt.run_id);
    if (row?.payload == null) return attempt;
    const checkpoint = parseTaskCheckpoint(Buffer.from(row.payload));
    if (checkpoint === null) return attempt;
    const refs = [...new Set(checkpoint.attempts.flatMap((a) => a.fact_refs))];
    const evidence = [...new Set(checkpoint.attempts.flatMap((a) => a.evidence_refs))];
    const scope = options.scopeTargets === undefined || row.scope_targets === null ? "unknown_requires_authorization" :
      row.scope_targets === JSON.stringify([...options.scopeTargets].sort()) ? "unchanged_requires_authorization" : "changed_requires_authorization";
    const experiment = parseExperimentContract(row.experiment_plan);
    const memory: AttemptMemory = { trust: "worker_claim_not_verified", sequence: row.sequence,
      ...(experiment === null ? {} : { experiment_plan: experiment }),
      accepted_at: row.accepted_at, checkpoint,
      control: { outcome: row.outcome, termination_reason: row.termination_reason,
        ...(attempt.failure === undefined ? {} : { failure: attempt.failure }) },
      reuse: { intent_status: checkpoint.intent_id === null ? null : intents.find((i) => i.id === checkpoint.intent_id)?.status ?? "missing",
        scope_status: scope, project_status: projectStatus, budget: "recheck_current_pack_core", automatic_execution: false,
        facts: refs.map((id) => ({ id, status: factMap.get(id)?.status ?? "missing", superseded_by: factMap.get(id)?.superseded_by ?? null })),
        evidence: evidence.map((ref) => ({ ref, status: options.evidenceStatus?.(ref) ?? "unavailable" })) },
    };
    memory.experiment_result = projectExperimentResult({ checkpoint, outcome: row.outcome,
      terminationReason: row.termination_reason, evidence: memory.reuse.evidence,
      ...(attempt.failure === undefined ? {} : { failure: attempt.failure }) });
    return { ...attempt, memory };
  });
}
