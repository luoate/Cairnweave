/** M51d: bounded read-only details. Availability is never a verification verdict. */
import type { TaskContextSnapshot } from "./context-snapshot";
import type { IntentMeta } from "./models";
export function projectIntentExperiment(snapshot: TaskContextSnapshot, intentId: string, metadata: readonly IntentMeta[]) {
  const meta = metadata.find(item => item.intent_id === intentId);
  const attempts = snapshot.attempts.filter(item => item.intent_id === intentId)
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.run_id.localeCompare(a.run_id));
  const followups = metadata.filter(item => item.experiment_review?.source_intent_id === intentId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.intent_id.localeCompare(a.intent_id));
  return {
    project_id: snapshot.project.id, intent_id: intentId,
    trust: "worker_claim_not_verified" as const, hypothesis_verdict: "unknown" as const,
    experiment: meta?.experiment ?? null, experiment_review: meta?.experiment_review ?? null,
    reason_run_id: meta?.origin_run_id ?? null,
    attempts: attempts.slice(0, 10).map(item => ({ run_id: item.run_id, outcome: item.outcome,
      ...(item.failure === undefined ? {} : { failure: item.failure }), memory: item.memory ?? null })),
    followups: followups.slice(0, 10).map(item => ({ intent_id: item.intent_id, reason_run_id: item.origin_run_id,
      review: item.experiment_review! })),
    omitted: { attempts: Math.max(0, attempts.length - 10), followups: Math.max(0, followups.length - 10) },
  };
}
