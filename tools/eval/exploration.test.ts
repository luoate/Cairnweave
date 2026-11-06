import { expect, test } from "bun:test";
import { runExplorationEvaluation } from "./exploration";
test("M52d deterministic preference evaluation covers off, expiry, faults and unknown without false reductions or mutation", () => {
  const report = runExplorationEvaluation();
  expect(report.model_calls).toBe(0); expect(report.real_cost_usd).toBeNull();
  expect(report.metrics).toEqual({ total: 17, matched: 17, unsafe_reductions: 0, mutations: 0, verdict_changes: 0 });
  expect(report.cases.find(item => item.id === "non_renewing")).toMatchObject({ reason: "window_expired", penalty: 0 });
  for (const id of ["missing_evidence", "changed_scope", "changed_plan", "missing_checkpoint", "infrastructure_fault", "tool_fault", "new_fact", "operator_guidance"])
    expect(report.cases.find(item => item.id === id)?.penalty).toBe(0);
});
test("M52d report is byte-for-byte stable across independent database evaluations", () => {
  expect(runExplorationEvaluation()).toEqual(runExplorationEvaluation());
});
