import { describe, expect, test } from "bun:test";
import { CONTEXT_SCENARIOS } from "./context";
import { runContextPackEvaluation } from "./context-pack";
describe("M48 deterministic context comparison", () => {
  test("measures all eight baseline scenarios, real delivery, compatibility and complete authorized recovery", () => {
    const report = runContextPackEvaluation();
    expect(report.model_calls).toBe(0);
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual(CONTEXT_SCENARIOS.map((scenario) => scenario.id));
    for (const scenario of report.scenarios) {
      expect(scenario.shadow_worker_inputs_unchanged).toBe(true);
      expect(scenario.legacy_snapshot_bytes_unchanged).toBe(true);
      expect(scenario.observer_snapshot_unchanged).toBe(true);
      expect(scenario.actual_initial_bytes).toBeLessThanOrEqual(scenario.legacy_initial_bytes);
      expect(scenario.recovered_records).toBe(scenario.recoverable_records);
      if (scenario.status === "applied") {
        expect(scenario.pinned_state_preserved).toBe(true);
        expect(scenario.actual_initial_bytes).toBe(scenario.candidate_initial_bytes!);
        expect(scenario.actual_initial_bytes).toBeLessThanOrEqual(scenario.max_initial_bytes);
        expect(scenario.recoverable_records).toBeGreaterThan(0);
      }
    }
    const byId = new Map(report.scenarios.map((scenario) => [scenario.id, scenario]));
    for (const id of ["many_facts", "many_intents", "many_hints"]) expect(byId.get(id)!.reduction_percent).toBeGreaterThanOrEqual(30);
    expect(byId.get("long_description")!.status).toBe("applied");
    expect(byId.get("conclude_resume")).toMatchObject({ status: "not_applicable", resumed_history_unknown: true });
    expect(JSON.stringify(report)).not.toContain("长描述长描述");
  }, 60000);
  test("reports stable metrics on repeated runs in one environment", () => {
    expect(runContextPackEvaluation()).toEqual(runContextPackEvaluation());
  }, 60000);
});
