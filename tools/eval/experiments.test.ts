import { expect, test } from "bun:test";
import { runExperimentEvaluation } from "./experiments";
test("M51d covers explicit unknowns, result-based choices and unsafe proposal rejection without model calls", () => {
  const report = runExperimentEvaluation();
  expect(report.model_calls).toBe(0); expect(report.real_cost_usd).toBeNull();
  expect(report.metrics).toEqual({ total: 19, matched: 19, accepted: 4, unsafe_acceptances: 0, verdict_changes: 0 });
  const cases = new Map<string, typeof report.cases[number]>(report.cases.map(item => [item.id, item]));
  expect(cases.get("local_negative_change")).toMatchObject({ actual: "accept", choice: "change_direction", hypothesis_verdict: "unknown" });
  expect(cases.get("operational_error_need")).toMatchObject({ actual: "accept", choice: "need_observation", result_status: "operationally_incomplete" });
  for (const id of ["interpretation_only", "tool_failure", "infrastructure_failure", "execution_failure", "missing_evidence",
    "changed_scope", "stale_checkpoint", "changed_plan", "legacy_unbound_plan", "not_delivered", "cross_project_reference",
    "invented_observation", "abandoned_source", "missing_new_contract", "extra_refuted_verdict"]) expect(cases.get(id)?.actual).toBe("reject");
});
test("M51d report remains byte-for-byte deterministic across repeated evaluations", () => {
  expect(runExperimentEvaluation()).toEqual(runExperimentEvaluation());
});
