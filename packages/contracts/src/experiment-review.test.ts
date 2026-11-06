import { describe, expect, test } from "bun:test";
import { isExperimentReview, MAX_EXPERIMENT_REVIEW_BYTES, parseExperimentReview, validateReasonPayload } from "./index";
import { experiment } from "./testdata/experiment";
import { review } from "./testdata/experiment-review";
const intent = (value: unknown) => ({ from: ["origin"], description: "follow up", experiment: experiment(), experiment_review: value });
describe("M51c bounded experiment review", () => {
  test("accepts optional reviews in wrapped, bare and singular reason intents", () => {
    for (const data of [{ intents: [intent(review())] }, { intent: intent(review()) }]) {
      expect(validateReasonPayload({ accepted: true, data }, false, 3).kind).toBe("intents");
      expect(validateReasonPayload(data, false, 3).kind).toBe("intents");
    }
    expect(isExperimentReview(review({ choice: "continue" }))).toBe(true);
    expect(isExperimentReview(review({ choice: "need_observation", observations: [] }))).toBe(true);
    expect(validateReasonPayload({ intents: [{ from: ["origin"], description: "legacy" }] }, false, 3).kind).toBe("intents");
  });
  test("rejects unknown keys, verdicts, missing fields, invalid refs and inconsistent choices", () => {
    for (const invalid of [null, [], "review", { ...review(), verdict: "refuted" }, { ...review(), choice: "refuted" },
      { ...review(), rationale: " " }, { ...review(), source_intent_id: "" }, { ...review(), observations: [] },
      review({ choice: "need_observation" }), { ...review(), observations: [{ run_id: "r1", checkpoint_sequence: 0, attempt_id: "a1" }] },
      { ...review(), observations: [{ ...review().observations[0], interpretation: "not an observation" }] },
      { ...review(), observations: [review().observations[0], review().observations[0]] },
      { ...review(), observations: Array.from({ length: 5 }, (_, i) => ({ run_id: "r1", checkpoint_sequence: 1, attempt_id: `a${i}` })) },
    ]) {
      expect(isExperimentReview(invalid)).toBe(false);
      expect(() => validateReasonPayload({ intents: [intent(invalid)] }, false, 3)).toThrow("experiment_review");
    }
    expect(() => validateReasonPayload({ intents: [{ ...intent(review()), experiment: undefined }] }, false, 3)).toThrow("experiment_review");
  });
  test("checks character and combined UTF-8 bounds without repairing stored values", () => {
    expect(isExperimentReview(review({ rationale: "a".repeat(1024) }))).toBe(true);
    expect(isExperimentReview(review({ rationale: "a".repeat(1025) }))).toBe(false);
    const oversized = review({ rationale: "界".repeat(1024), observations: Array.from({ length: 4 }, (_, i) => ({
      run_id: "界".repeat(128), checkpoint_sequence: 1, attempt_id: "界".repeat(95) + i,
    })) });
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MAX_EXPERIMENT_REVIEW_BYTES);
    expect(isExperimentReview(oversized)).toBe(false);
    expect(parseExperimentReview(JSON.stringify(review()))).toEqual(review());
    for (const text of [null, "{", "a".repeat(5000), JSON.stringify(oversized)]) expect(parseExperimentReview(text)).toBeNull();
  });
  test("validates the whole list before truncating reason intents", () => {
    expect(() => validateReasonPayload({ intents: [intent(review()), intent(null)] }, false, 1)).toThrow("experiment_review");
  });
});
