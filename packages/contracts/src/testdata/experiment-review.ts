import type { ExperimentReview } from "../experiment-review";
export const review = (extra: Partial<ExperimentReview> = {}): ExperimentReview => ({
  source_intent_id: "i001", choice: "change_direction", rationale: "局部观察与预期不同，调整下一次实验，不反证整体假设",
  observations: [{ run_id: "r1", checkpoint_sequence: 1, attempt_id: "a1" }], ...extra,
});
