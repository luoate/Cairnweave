/** M51c: source validation for a new direction, never a semantic hypothesis verifier. */
import { EXPERIMENT_FIELDS, type ExperimentReview, type ExperimentObservationRef } from "@cairn/contracts";
import type { TaskContextSnapshot } from "./context-snapshot";

export interface ExperimentReviewBasis {
  sources: Array<{ intent_id: string; plan: string; observations: ExperimentObservationRef[] }>;
}
const planKey = (plan: NonNullable<TaskContextSnapshot["intents"][number]["experiment"]>): string =>
  JSON.stringify(EXPERIMENT_FIELDS.map(key => plan[key]));
const refKey = (ref: ExperimentObservationRef): string => JSON.stringify([ref.run_id, ref.checkpoint_sequence, ref.attempt_id]);
export function buildExperimentReviewBasis(snapshot: TaskContextSnapshot): ExperimentReviewBasis {
  return { sources: snapshot.intents.filter(intent => intent.experiment !== undefined && intent.status !== "abandoned")
    .map(intent => ({ intent_id: intent.id,
      plan: planKey(intent.experiment!),
      observations: snapshot.attempts.filter(attempt => attempt.intent_id === intent.id).flatMap(attempt => {
        const memory = attempt.memory;
        if (memory === undefined || memory.experiment_plan === undefined ||
            planKey(memory.experiment_plan) !== planKey(intent.experiment!) ||
            memory.control.failure !== undefined || attempt.failure !== undefined ||
            memory.control.outcome !== "success" || memory.control.termination_reason !== "finished" ||
            memory.sequence !== memory.checkpoint.sequence ||
            memory.checkpoint.project_id !== snapshot.project.id || memory.checkpoint.intent_id !== intent.id ||
            memory.reuse.scope_status !== "unchanged_requires_authorization" ||
            memory.reuse.facts.some(fact => fact.status !== "current") ||
            memory.experiment_result?.status !== "observations_reported") return [];
        return memory.experiment_result.observations.filter(observation =>
          (observation.reported_result === "observed" || observation.reported_result === "negative_observation") &&
          observation.evidence === "refs_available_not_verified")
          .map(observation => ({ run_id: attempt.run_id, checkpoint_sequence: memory.sequence, attempt_id: observation.attempt_id }));
      }),
    })) };
}
/** Both snapshots must authorize exactly the same source and observation version. */
export function experimentReviewError(review: ExperimentReview, dispatched: ExperimentReviewBasis | undefined,
  current: ExperimentReviewBasis): string | null {
  const before = dispatched?.sources.find(source => source.intent_id === review.source_intent_id);
  const now = current.sources.find(source => source.intent_id === review.source_intent_id);
  if (before === undefined) return "experiment review source was not authorized in the applied context pack";
  if (now === undefined || before.plan !== now.plan) return "experiment review source is stale or unavailable";
  if (review.choice === "need_observation") return null;
  const knownBefore = new Set(before.observations.map(refKey));
  const knownNow = new Set(now.observations.map(refKey));
  return review.observations.every(ref => knownBefore.has(refKey(ref)) && knownNow.has(refKey(ref)))
    ? null : "experiment review requires current, available observation references; errors and interpretations are not observations";
}
