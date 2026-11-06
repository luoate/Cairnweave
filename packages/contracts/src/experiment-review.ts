/** M51c: a bounded strategy proposal linking a new experiment to prior observations. */
export interface ExperimentObservationRef {
  run_id: string;
  checkpoint_sequence: number;
  attempt_id: string;
}
export interface ExperimentReview {
  source_intent_id: string;
  choice: "continue" | "change_direction" | "need_observation";
  rationale: string;
  observations: ExperimentObservationRef[];
}
export const MAX_EXPERIMENT_REVIEW_BYTES = 4096;
const text = (value: unknown, max: number): value is string => typeof value === "string" &&
  value.trim() !== "" && value.length <= max;
export function isExperimentReview(value: unknown): value is ExperimentReview {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 4 || !text(item["source_intent_id"], 128) || !text(item["rationale"], 1024) ||
      !["continue", "change_direction", "need_observation"].includes(item["choice"] as string) ||
      !Array.isArray(item["observations"]) || item["observations"].length > 4) return false;
  if (item["choice"] === "need_observation" ? item["observations"].length !== 0 : item["observations"].length === 0) return false;
  const seen = new Set<string>();
  for (const ref of item["observations"]) {
    if (ref === null || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).length !== 3 ||
        !text(ref.run_id, 128) || !text(ref.attempt_id, 96) ||
        !Number.isSafeInteger(ref.checkpoint_sequence) || ref.checkpoint_sequence <= 0) return false;
    const key = JSON.stringify([ref.run_id, ref.checkpoint_sequence, ref.attempt_id]);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_EXPERIMENT_REVIEW_BYTES;
}
export function parseExperimentReview(text: string | null | undefined): ExperimentReview | null {
  if (text == null || text.length > MAX_EXPERIMENT_REVIEW_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isExperimentReview(value) ? value : null;
  } catch { return null; }
}
