/** M51b: a read-only index into M49 memory, not a second attempt store or a verdict. */
import type { TaskCheckpoint, AttemptResult } from "@cairn/contracts";
import type { RunFailure } from "./failures";

export interface ExperimentResultProjection {
  source: "memory.checkpoint.attempts";
  trust: "worker_claim_not_verified";
  status: "observations_reported" | "operationally_incomplete" | "unknown";
  /** IDs resolve to the original action/observation/result/evidence_refs, not copied prose. */
  observations: Array<{ attempt_id: string; reported_result: AttemptResult;
    evidence: "refs_available_not_verified" | "missing" | "unavailable" | "not_supplied" }>;
  /** IDs resolve only to the interpretation field; interpretations never become observations. */
  interpretations: Array<{ attempt_id: string; trust: "worker_claim_not_verified" }>;
  unresolved_count: number;
  /** No comparison to expected_signal, route retirement or refutation in M51a/b. */
  hypothesis_verdict: "unknown";
}
export function projectExperimentResult(input: {
  checkpoint: TaskCheckpoint;
  outcome: string | null;
  terminationReason: string | null;
  failure?: RunFailure;
  evidence: ReadonlyArray<{ ref: string; status: "available" | "missing" | "unavailable" }>;
}): ExperimentResultProjection {
  const evidence = new Map(input.evidence.map(item => [item.ref, item.status]));
  const observations = input.checkpoint.attempts.filter(item => item.observation.trim() !== "").map(item => {
    const statuses = item.evidence_refs.map(ref => evidence.get(ref) ?? "unavailable");
    return { attempt_id: item.id, reported_result: item.result, evidence: item.evidence_refs.length === 0 ? "not_supplied" as const
      : statuses.includes("missing") ? "missing" as const : statuses.includes("unavailable") ? "unavailable" as const
      : "refs_available_not_verified" as const };
  });
  const incomplete = input.failure !== undefined || input.outcome !== "success" ||
    (input.terminationReason !== null && input.terminationReason !== "finished");
  const observed = observations.some(item => item.reported_result === "observed" || item.reported_result === "negative_observation");
  return { source: "memory.checkpoint.attempts", trust: "worker_claim_not_verified",
    status: incomplete ? "operationally_incomplete" : observed ? "observations_reported" : "unknown",
    observations, interpretations: input.checkpoint.attempts.filter(item => item.interpretation.trim() !== "")
      .map(item => ({ attempt_id: item.id, trust: "worker_claim_not_verified" })),
    unresolved_count: input.checkpoint.unresolved.length, hypothesis_verdict: "unknown" };
}
